import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, vi } from 'vitest';

import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { initializePersonalStorage } from '../src/personal-storage.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const withTempDb = async (fn: (dbPath: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'node-sqlite-db-'));
  try {
    await fn(join(dir, 'test.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const withRecoveryFailures = async (
  operation: (db: ReturnType<typeof createNodeSqliteDatabase>) => Promise<unknown>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'node-sqlite-recovery-'));
  const paths = resolvePersonalRuntimePaths({ dataDir: join(root, 'data'), stableUserHome: root });
  try {
    const permissions = initializePersonalStorage(paths);
    const db = createNodeSqliteDatabase(paths.databasePath, { permissions });
    const primary = new Error('forced primary transaction failure');
    const hardening = new Error('forced recovery hardening failure');
    let hardeningCalls = 0;
    const harden = vi.spyOn(permissions, 'hardenSqliteFiles').mockImplementation(() => {
      if (hardeningCalls++ === 0) throw primary;
      throw hardening;
    });
    let observed: unknown;
    try {
      await operation(db);
    } catch (cause) {
      observed = cause;
    }
    assert(observed instanceof AggregateError);
    assertEquals(observed.cause, primary);
    assertEquals(observed.errors[0], primary);
    assert(observed.errors[1] instanceof Error);
    assert((observed.errors[1] as Error).message.includes('no transaction is active'));
    assertEquals(observed.errors[2], hardening);
    harden.mockRestore();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('prepare/all returns rows in SqlResult envelope', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b').run();

  const result = await db.prepare('SELECT id, name FROM t ORDER BY id').all<{ id: number; name: string }>();
  assertEquals(result.success, true);
  assertEquals(result.results, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
}));

test('first returns first row or null', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(7, 'seven').run();

  const hit = await db.prepare('SELECT id, name FROM t WHERE id = ?').bind(7).first<{ id: number; name: string }>();
  assertEquals(hit, { id: 7, name: 'seven' });

  const miss = await db.prepare('SELECT id, name FROM t WHERE id = ?').bind(99).first();
  assertEquals(miss, null);
}));

test('run reports changes for INSERT / UPDATE / DELETE', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();

  const ins = await db.prepare('INSERT INTO t (id, name) VALUES (?, ?), (?, ?)').bind(1, 'a', 2, 'b').run();
  assertEquals(ins.meta.changes, 2);

  const upd = await db.prepare('UPDATE t SET name = ? WHERE id = ?').bind('A', 1).run();
  assertEquals(upd.meta.changes, 1);

  const del = await db.prepare('DELETE FROM t WHERE id = ?').bind(1).run();
  assertEquals(del.meta.changes, 1);
}));

test('batch executes statements in order and returns each result', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  assert(db.batch !== undefined, 'batch must be implemented');
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();

  const results = await db.batch([
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a'),
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b'),
    db.prepare('UPDATE t SET name = ? WHERE id = ?').bind('A', 1),
  ]);
  assertEquals(results.length, 3);
  assertEquals(results.map(r => r.meta.changes), [1, 1, 1]);

  const rows = await db.prepare('SELECT id, name FROM t ORDER BY id').all<{ id: number; name: string }>();
  assertEquals(rows.results, [{ id: 1, name: 'A' }, { id: 2, name: 'b' }]);
}));

test('batch and interactive transactions expose their complete ordered lifecycle', () => withTempDb(async path => {
  const phases: string[] = [];
  const db = createNodeSqliteDatabase(path, { observeTransactionPhase: phase => phases.push(phase) });
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();
  await db.batch!([db.prepare('INSERT INTO t (id) VALUES (1)')]);
  assertEquals(phases, ['not-begun', 'begun', 'body', 'commit', 'committed', 'finalize', 'done']);
  phases.length = 0;
  await db.transaction!(async () => { await db.prepare('INSERT INTO t (id) VALUES (2)').run(); });
  assertEquals(phases, ['not-begun', 'begun', 'body', 'finalize', 'commit', 'committed', 'done']);
}));

test('batch post-commit hardening failure preserves committed data and never attempts rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-sqlite-committed-recovery-'));
  const paths = resolvePersonalRuntimePaths({ dataDir: join(root, 'data'), stableUserHome: root });
  try {
    const permissions = initializePersonalStorage(paths);
    const hardenOriginal = permissions.hardenSqliteFiles.bind(permissions);
    const hardeningFailure = new Error('forced post-commit hardening failure');
    const phases: string[] = [];
    let failNextHardening = false;
    const harden = vi.spyOn(permissions, 'hardenSqliteFiles').mockImplementation(path => {
      if (failNextHardening) {
        failNextHardening = false;
        throw hardeningFailure;
      }
      hardenOriginal(path);
    });
    const db = createNodeSqliteDatabase(paths.databasePath, {
      permissions,
      observeTransactionPhase: phase => {
        phases.push(phase);
        if (phase === 'finalize') failNextHardening = true;
      },
    });
    await db.prepare('CREATE TABLE committed (id INTEGER PRIMARY KEY)').run();

    let observed: unknown;
    try { await db.batch!([db.prepare('INSERT INTO committed (id) VALUES (1)')]); } catch (cause) { observed = cause; }

    assertEquals(observed, hardeningFailure);
    assertEquals(phases, ['not-begun', 'begun', 'body', 'commit', 'committed', 'finalize', 'recovery']);
    assertEquals((await db.prepare('SELECT id FROM committed').all<{ id: number }>()).results, [{ id: 1 }]);
    harden.mockRestore();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('begin and commit failures preserve their phase and original precedence', () => withTempDb(async path => {
  const phases: string[] = [];
  const db = createNodeSqliteDatabase(path, { observeTransactionPhase: phase => phases.push(phase) });
  await db.exec('BEGIN');
  let beginFailure: unknown;
  try { await db.batch!([db.prepare('SELECT 1')]); } catch (cause) { beginFailure = cause; }
  assert(beginFailure instanceof Error);
  assert(beginFailure.message.includes('transaction'));
  assertEquals(phases, ['not-begun', 'recovery']);
  await db.exec('ROLLBACK');

  phases.length = 0;
  let commitFailure: unknown;
  try {
    await db.transaction!(async () => { await db.exec('COMMIT'); });
  } catch (cause) { commitFailure = cause; }
  assert(commitFailure instanceof AggregateError);
  assertEquals(commitFailure.cause, commitFailure.errors[0]);
  assert((commitFailure.cause as Error).message.includes('no transaction is active'));
  assertEquals(phases, ['not-begun', 'begun', 'body', 'finalize', 'commit', 'recovery']);
}));

test('batch rolls back on mid-batch failure', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)').run();
  await db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'a').run();

  await assertRejects(
    () => db.batch!([
      db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(2, 'b'),
      // Duplicate primary key — fails after the first succeeds.
      db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').bind(1, 'dup'),
    ]),
  );

  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  // Only the pre-batch insert should remain — the in-batch INSERT(id=2) was rolled back.
  assertEquals(rows.results, [{ id: 1 }]);
}));

test('batch preserves its primary failure and aggregates rollback and hardening recovery failures', () =>
  withRecoveryFailures(async db => {
    await db.batch!([db.prepare('ROLLBACK')]);
  }));

test('interactive transaction rolls back awaited writes and rethrows the original failure', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  assert(db.transaction !== undefined, 'transaction must be implemented');
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind(1).run();
  const failure = new Error('forced restore write failure');

  let observed: unknown;
  try {
    await db.transaction(async () => {
      await db.prepare('DELETE FROM t').run();
      await db.prepare('INSERT INTO t (id) VALUES (?)').bind(2).run();
      throw failure;
    });
  } catch (cause) {
    observed = cause;
  }

  assertEquals(observed, failure);
  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  assertEquals(rows.results, [{ id: 1 }]);
}));

test('interactive transaction preserves its primary failure and aggregates rollback and hardening recovery failures', () =>
  withRecoveryFailures(async db => {
    await db.transaction!(async () => {
      await db.exec('ROLLBACK');
    });
  }));

test('final private-storage hardening fails before commit and rolls back every restored entity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-sqlite-hardening-'));
  const paths = resolvePersonalRuntimePaths({ dataDir: join(root, 'data'), stableUserHome: root });
  try {
    const permissions = initializePersonalStorage(paths);
    const hardenOriginal = permissions.hardenSqliteFiles.bind(permissions);
    const nativeFailure = Object.assign(new Error('forced chmod failure'), { code: 'EACCES' });
    const hardeningFailure = new Error('Floway could not finalize private SQLite storage', { cause: nativeFailure });
    let armed = false;
    const harden = vi.spyOn(permissions, 'hardenSqliteFiles').mockImplementation(path => {
      hardenOriginal(path);
      if (armed) throw hardeningFailure;
    });
    const db = createNodeSqliteDatabase(paths.databasePath, { permissions });
    await db.prepare('CREATE TABLE restored (kind TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
    for (const kind of ['owner', 'key', 'upstream', 'alias']) {
      await db.prepare('INSERT INTO restored (kind, value) VALUES (?, ?)').bind(kind, `prior-${kind}`).run();
    }

    armed = true;
    let operationFinished = false;
    let observed: unknown;
    try {
      await db.transaction!(async () => {
        await db.prepare('DELETE FROM restored').run();
        for (const kind of ['owner', 'key', 'upstream', 'alias']) {
          await db.prepare('INSERT INTO restored (kind, value) VALUES (?, ?)').bind(kind, `restored-${kind}`).run();
        }
        operationFinished = true;
      });
    } catch (cause) {
      observed = cause;
    }

    assertEquals(operationFinished, true);
    assert(observed instanceof AggregateError);
    assertEquals(observed.cause, hardeningFailure);
    assertEquals(observed.errors, [hardeningFailure, hardeningFailure]);
    assertEquals((observed.cause as Error).cause, nativeFailure);
    armed = false;
    const rows = await db.prepare('SELECT kind, value FROM restored ORDER BY kind').all<{ kind: string; value: string }>();
    assertEquals(rows.results, [
      { kind: 'alias', value: 'prior-alias' },
      { kind: 'key', value: 'prior-key' },
      { kind: 'owner', value: 'prior-owner' },
      { kind: 'upstream', value: 'prior-upstream' },
    ]);
    harden.mockRestore();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary database work cannot interleave with an awaited transaction', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  assert(db.transaction !== undefined, 'transaction must be implemented');
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind(1).run();

  let enterTransaction!: () => void;
  const transactionEntered = new Promise<void>(resolve => { enterTransaction = resolve; });
  let releaseTransaction!: () => void;
  const transactionRelease = new Promise<void>(resolve => { releaseTransaction = resolve; });
  const failure = new Error('forced transaction rollback');
  const transaction = db.transaction(async () => {
    await db.prepare('DELETE FROM t').run();
    enterTransaction();
    await transactionRelease;
    throw failure;
  });

  await transactionEntered;
  const outsideWrite = db.prepare('INSERT INTO t (id) VALUES (?)').bind(3).run();
  releaseTransaction();
  await assertRejects(() => transaction);
  await outsideWrite;

  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  assertEquals(rows.results, [{ id: 1 }, { id: 3 }]);
}));

test('an atomic repository batch participates in its enclosing restore transaction', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  assert(db.transaction !== undefined, 'transaction must be implemented');
  assert(db.batch !== undefined, 'batch must be implemented');
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();
  await db.prepare('INSERT INTO t (id) VALUES (?)').bind(1).run();
  const failure = new Error('forced failure after nested batch');
  let batchCompleted = false;
  let observed: unknown;

  try {
    await db.transaction!(async () => {
      await db.batch!([
        db.prepare('DELETE FROM t'),
        db.prepare('INSERT INTO t (id) VALUES (?)').bind(2),
      ]);
      batchCompleted = true;
      throw failure;
    });
  } catch (cause) {
    observed = cause;
  }

  assertEquals(batchCompleted, true);
  assertEquals(observed, failure);
  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  assertEquals(rows.results, [{ id: 1 }]);
}));

test('concurrent batch calls do not interleave transactions', () => withTempDb(async path => {
  // Regression: an `await` between BEGIN and COMMIT used to yield a microtask,
  // letting a second batch call's BEGIN run while the first transaction was
  // still open and trip "cannot start a transaction within a transaction".
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)').run();

  await Promise.all([
    db.batch!([db.prepare('INSERT INTO t (id) VALUES (?)').bind(1)]),
    db.batch!([db.prepare('INSERT INTO t (id) VALUES (?)').bind(2)]),
  ]);

  const rows = await db.prepare('SELECT id FROM t ORDER BY id').all<{ id: number }>();
  assertEquals(rows.results, [{ id: 1 }, { id: 2 }]);
}));

test('foreign key enforcement is on', () => withTempDb(async path => {
  const db = createNodeSqliteDatabase(path);
  await db.prepare('CREATE TABLE parent (id INTEGER PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))').run();

  await assertRejects(
    () => db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').bind(1, 999).run(),
  );
}));
