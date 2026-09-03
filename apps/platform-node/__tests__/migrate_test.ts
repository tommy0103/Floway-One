import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { upstreamConfigSecretContext, upstreamStateSecretContext } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'migrate-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('applies all real migration files against a fresh sqlite', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'real.db'));
  await applyMigrations(db);

  // Schema check: a stable table from migration 0001 exists with expected columns.
  const apiKeyCols = await db.prepare('PRAGMA table_info(api_keys)').all<{ name: string }>();
  const colNames = apiKeyCols.results.map(r => r.name).toSorted();
  assertEquals(colNames.includes('id'), true);
  assertEquals(colNames.includes('key'), true);
  assertEquals(colNames.includes('server_secret'), true);

  // Every migration was recorded.
  const recorded = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(recorded !== null && recorded.n > 0, true);
}));

test('rerun is a no-op once all migrations are applied', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'idempotent.db'));
  await applyMigrations(db);
  const firstCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();

  await applyMigrations(db);
  const secondCount = await db.prepare('SELECT COUNT(*) AS n FROM _migrations').first<{ n: number }>();
  assertEquals(secondCount?.n, firstCount?.n);
}));

test('mid-migration failure rolls back and leaves no partial schema', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  await rm(migrationsDir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir, { recursive: true });

  // First statement creates a table; second is invalid SQL — the transaction
  // must roll back so the table from the first statement does not survive.
  await writeFile(
    join(migrationsDir, '0001_bad.sql'),
    'CREATE TABLE only_in_failed_migration (id INTEGER);\n'
    + 'NOT VALID SQL HERE;\n',
  );

  const db = createNodeSqliteDatabase(join(dir, 'rollback.db'));
  await assertRejects(() => applyMigrations(db, migrationsDir));

  const tables = await db.prepare(
    'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?',
  ).bind('only_in_failed_migration').all<{ name: string }>();
  assertEquals(tables.results, []);

  const recorded = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  assertEquals(recorded.results, []);
}));

test('skips already-applied migrations on partial state', () => withTemp(async dir => {
  const migrationsDir = join(dir, 'migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(join(migrationsDir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  await writeFile(join(migrationsDir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');

  const db = createNodeSqliteDatabase(join(dir, 'partial.db'));
  await applyMigrations(db, migrationsDir);

  // Add a third migration; rerun. Only the new one should execute — the first
  // two would error if re-run because the tables already exist.
  await writeFile(join(migrationsDir, '0003_c.sql'), 'CREATE TABLE c (id INTEGER);');
  await applyMigrations(db, migrationsDir);

  const recorded = await db.prepare('SELECT name FROM _migrations ORDER BY name').all<{ name: string }>();
  assertEquals(recorded.results.map(r => r.name), ['0001_a.sql', '0002_b.sql', '0003_c.sql']);
}));

test('personal encrypted upstream documents decrypt, migrate, and re-encrypt atomically', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'encrypted-upgrade.db'));
  await applyMigrations(db);
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(7));
  const id = 'up_encrypted_upgrade';
  const config = await codec.seal(
    '{"apiKey":"upgrade-secret","legacy":true}',
    upstreamConfigSecretContext(id),
  );
  const state = await codec.seal(
    '{"obsolete":"remove-me","refreshToken":"upgrade-refresh"}',
    upstreamStateSecretContext(id),
  );
  await db.prepare(
    `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, flag_overrides, hue)
     VALUES (?, 'custom', 'Encrypted upgrade', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', ?, ?, '{}', 210)`,
  ).bind(id, config, state).run();

  const migrationsDir = join(dir, 'encrypted-migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir);
  await writeFile(join(migrationsDir, '9000_encrypted_documents.sql'), `
    UPDATE upstreams
    SET config_json = json_set(config_json, '$.migrated', json('true')),
        state_json = json_remove(state_json, '$.obsolete')
    WHERE id = '${id}';
  `);

  await applyMigrations(db, migrationsDir, codec);

  const row = await db.prepare('SELECT config_json, state_json FROM upstreams WHERE id = ?')
    .bind(id)
    .first<{ config_json: string; state_json: string }>();
  assert(row !== null);
  assertEquals(row.config_json.includes('upgrade-secret'), false);
  assertEquals(row.state_json.includes('upgrade-refresh'), false);
  assertEquals(JSON.parse(await codec.open(row.config_json, upstreamConfigSecretContext(id))), {
    apiKey: 'upgrade-secret',
    legacy: true,
    migrated: true,
  });
  assertEquals(JSON.parse(await codec.open(row.state_json, upstreamStateSecretContext(id))), {
    refreshToken: 'upgrade-refresh',
  });
}));

test('personal encrypted migration preserves authenticated-decryption causes and rolls back', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'encrypted-failure.db'));
  await applyMigrations(db);
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(8));
  const id = 'up_encrypted_failure';
  const stored = await codec.seal('{"apiKey":"tampered-secret"}', upstreamConfigSecretContext(id));
  const envelope = JSON.parse(stored) as { $flowayEncrypted: { ciphertext: string } };
  envelope.$flowayEncrypted.ciphertext = `${envelope.$flowayEncrypted.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.$flowayEncrypted.ciphertext.slice(1)}`;
  const tampered = JSON.stringify(envelope);
  await db.prepare(
    `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides, hue)
     VALUES (?, 'custom', 'Encrypted failure', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', ?, '{}', 210)`,
  ).bind(id, tampered).run();

  const migrationsDir = join(dir, 'failing-encrypted-migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrationsDir);
  const migrationName = '9001_authenticated_failure.sql';
  await writeFile(join(migrationsDir, migrationName), 'SELECT 1;');

  const error = await assertRejects(
    () => applyMigrations(db, migrationsDir, codec),
    Error,
    `Failed to decrypt stored secret for upstream:${id}:config`,
  );
  assert(error.cause instanceof Error);
  assertEquals(
    (await db.prepare('SELECT config_json FROM upstreams WHERE id = ?').bind(id).first<{ config_json: string }>())?.config_json,
    tampered,
  );
  assertEquals(
    await db.prepare('SELECT name FROM _migrations WHERE name = ?').bind(migrationName).first(),
    null,
  );
}));
