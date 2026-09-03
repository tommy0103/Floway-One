import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = fileURLToPath(new URL('./fixtures/personal-entry-failure-child.ts', import.meta.url));

test('production personal entry rejects an invalid multi-user SQLite database before serving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personal-entry-test-'));
  try {
    const databasePath = join(dir, 'floway.db');
    const db = createNodeSqliteDatabase(databasePath);
    await applyMigrations(db);
    await db.prepare(
      `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(2, 'other', null, 0, null, '2026-09-03T00:00:00.000Z', null).run();

    let failure: unknown;
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', ENTRY, 'profile-invariant', dir], {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          ADMIN_KEY: 'personal-entry-test',
          FLOWAY_PROFILE: 'personal',
          NODE_ENV: 'production',
          PORT: '8788',
        },
        timeout: 10_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const output = String((failure as { stdout?: string }).stdout ?? '')
      + String((failure as { stderr?: string }).stderr ?? '');
    expect(output).toContain(
      'Personal profile invariant violated: expected exactly the seed owner (user 1); found user ids: 1, 2',
    );
    expect(output).not.toContain('Floway listening on');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
