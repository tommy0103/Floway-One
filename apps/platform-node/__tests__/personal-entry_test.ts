import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_NODE_ENTRY_URL = new URL('../src/run-node-entry.ts', import.meta.url).href;

test('production personal entry rejects an invalid multi-user SQLite database before serving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'personal-entry-test-'));
  try {
    const paths = resolvePersonalRuntimePaths({ dataDir: join(dir, 'personal-data') });
    const db = createNodeSqliteDatabase(paths.databasePath);
    await applyMigrations(db);
    await db.prepare(
      `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(2, 'other', null, 0, null, '2026-09-03T00:00:00.000Z', null).run();
    const entry = join(dir, 'personal-entry-verification.mts');
    await writeFile(entry, `
import { runNodeEntry } from ${JSON.stringify(RUN_NODE_ENTRY_URL)};
const paths = JSON.parse(process.env.FLOWAY_TEST_PERSONAL_PATHS);
const plaintextStoredSecrets = {
  seal: value => Promise.resolve(value),
  open: value => Promise.resolve(value),
};
await runNodeEntry({
  resolvePersonalRuntimePaths: () => paths,
  createNodeStoredSecretCodec: () => Promise.resolve(plaintextStoredSecrets),
});
`);

    let failure: unknown;
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', entry], {
        cwd: APP_ROOT,
        env: {
          ...process.env,
          ADMIN_KEY: 'personal-entry-test',
          FLOWAY_TEST_PERSONAL_PATHS: JSON.stringify(paths),
          FLOWAY_PROFILE: 'personal',
          NODE_ENV: 'production',
          PORT: '0',
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
