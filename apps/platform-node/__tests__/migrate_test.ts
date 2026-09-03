import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import {
  PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION,
  upstreamConfigSecretContext,
  WEB_SEARCH_STORED_SECRET_FIELDS,
} from '@floway-dev/gateway';
import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import { createAes256GcmStoredSecretCodec, type StoredSecretCodec } from '@floway-dev/platform';
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

const legacySearchColumns = {
  tavily: 'tavily_api_key',
  'microsoft-web-iq': 'microsoft_web_iq_api_key',
  jina: 'jina_api_key',
} as const;

const prepareProtectedMigration = async (
  dir: string,
  journalMode: 'DELETE' | 'WAL',
  sentinel: string,
): Promise<{
  codec: StoredSecretCodec;
  databasePath: string;
  db: ReturnType<typeof createNodeSqliteDatabase>;
  migrationDir: string;
  originalCiphertexts: readonly string[];
}> => {
  const databasePath = join(dir, `protected-${journalMode.toLowerCase()}.db`);
  const db = createNodeSqliteDatabase(databasePath);
  await db.exec(`PRAGMA journal_mode = ${journalMode};`);
  await db.exec(`
    CREATE TABLE upstreams (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, state_json TEXT NULL);
    CREATE TABLE search_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      tavily_api_key TEXT NOT NULL DEFAULT '',
      microsoft_web_iq_api_key TEXT NOT NULL DEFAULT '',
      jina_api_key TEXT NOT NULL DEFAULT '',
      passthrough_openai_search INTEGER NOT NULL DEFAULT 0,
      alpha_search_upstream_id TEXT NOT NULL DEFAULT '',
      alpha_search_model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(11));
  const upstreamCiphertext = await codec.seal('{"apiKey":"upstream-ciphertext-only"}', upstreamConfigSecretContext('up_raw_scan'));
  await db.prepare('INSERT INTO upstreams VALUES (?, ?, NULL)').bind('up_raw_scan', upstreamCiphertext).run();
  const searchCiphertexts = await Promise.all(WEB_SEARCH_STORED_SECRET_FIELDS.map(field =>
    codec.seal(`${sentinel}-${field.provider}`, field.context)));
  await db.prepare(
    `INSERT INTO search_config
     (id, provider, tavily_api_key, microsoft_web_iq_api_key, jina_api_key, updated_at)
     VALUES (1, 'tavily', ?, ?, ?, '2026-09-03T00:00:00.000Z')`,
  ).bind(...searchCiphertexts).run();
  const migrationDir = join(dir, 'migrations');
  await mkdir(migrationDir);
  await copyFile(
    join(fileURLToPath(migrationsDir), PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION),
    join(migrationDir, PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION),
  );
  return { codec, databasePath, db, migrationDir, originalCiphertexts: searchCiphertexts };
};

const assertPlaintextAbsentFromSqliteFiles = async (databasePath: string, sentinel: string): Promise<void> => {
  const needle = Buffer.from(sentinel);
  for (const path of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      assertEquals(Buffer.from(await readFile(path)).includes(needle), false, `${path} contains migration plaintext`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

for (const journalMode of ['DELETE', 'WAL'] as const) {
  test(`personal ${journalMode} migration keeps opened values out of every SQLite file`, () => withTemp(async dir => {
    const sentinel = `raw-migration-sentinel-${journalMode.toLowerCase()}`;
    const setup = await prepareProtectedMigration(dir, journalMode, sentinel);
    const inspectingCodec: StoredSecretCodec = {
      open: (value, context) => setup.codec.open(value, context),
      seal: async (value, context) => {
        await assertPlaintextAbsentFromSqliteFiles(setup.databasePath, sentinel);
        return await setup.codec.seal(value, context);
      },
    };

    await applyMigrations(setup.db, setup.migrationDir, inspectingCodec);
    await assertPlaintextAbsentFromSqliteFiles(setup.databasePath, sentinel);

    const row = await setup.db.prepare(
      `SELECT ${WEB_SEARCH_STORED_SECRET_FIELDS.map(field => field.column).join(', ')} FROM search_config WHERE id = 1`,
    ).first<Record<(typeof WEB_SEARCH_STORED_SECRET_FIELDS)[number]['column'], string>>();
    assert(row !== null);
    for (const field of WEB_SEARCH_STORED_SECRET_FIELDS) {
      assertEquals(row[field.column].includes(sentinel), false);
      assertEquals(await setup.codec.open(row[field.column], field.context), `${sentinel}-${field.provider}`);
    }
  }));

  test(`personal ${journalMode} seal failure rolls back without persisting opened values`, () => withTemp(async dir => {
    const sentinel = `raw-rollback-sentinel-${journalMode.toLowerCase()}`;
    const setup = await prepareProtectedMigration(dir, journalMode, sentinel);
    const sealCause = new Error(`${journalMode} post-SQL seal failure`);
    const failingCodec: StoredSecretCodec = {
      open: (value, context) => setup.codec.open(value, context),
      seal: async () => {
        await assertPlaintextAbsentFromSqliteFiles(setup.databasePath, sentinel);
        throw sealCause;
      },
    };

    const error = await assertRejects(() => applyMigrations(setup.db, setup.migrationDir, failingCodec));
    assert(error === sealCause);
    await assertPlaintextAbsentFromSqliteFiles(setup.databasePath, sentinel);
    const oldColumns = await setup.db.prepare('PRAGMA table_info(search_config)').all<{ name: string }>();
    assertEquals(oldColumns.results.some(column => column.name === 'tavily_api_key'), true);
    assertEquals(oldColumns.results.some(column => column.name === 'protected_tavily_api_key'), false);
    const oldRow = await setup.db.prepare(
      'SELECT tavily_api_key, microsoft_web_iq_api_key, jina_api_key FROM search_config WHERE id = 1',
    ).first<{ tavily_api_key: string; microsoft_web_iq_api_key: string; jina_api_key: string }>();
    assert(oldRow !== null);
    assertEquals(
      WEB_SEARCH_STORED_SECRET_FIELDS.map(field => oldRow[legacySearchColumns[field.provider]]),
      setup.originalCiphertexts,
    );
    assertEquals(
      await setup.db.prepare('SELECT name FROM _migrations WHERE name = ?')
        .bind(PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION)
        .first(),
      null,
    );
  }));
}

test('personal migration rejects protected SQL without a checked-in plan and preserves its cause', () => withTemp(async dir => {
  const sentinel = 'missing-plan-sentinel';
  const setup = await prepareProtectedMigration(dir, 'DELETE', sentinel);
  await rm(join(setup.migrationDir, PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION));
  const migrationName = '9000_unplanned_protected_change.sql';
  await writeFile(
    join(setup.migrationDir, migrationName),
    "UPDATE search_config SET tavily_api_key = tavily_api_key || '-unsafe';",
  );

  const error = await assertRejects(
    () => applyMigrations(setup.db, setup.migrationDir, setup.codec),
    Error,
    `Floway One could not plan protected migration ${migrationName}`,
  );
  assert(error.cause instanceof Error);
  assertEquals((error.cause as Error).message, `Missing checked-in protected migration plan for ${migrationName}`);
  await assertPlaintextAbsentFromSqliteFiles(setup.databasePath, sentinel);
}));

test('legacy plaintext adoption seal failure restores the 0083 schema and exact cause', () => withTemp(async dir => {
  const sentinel = 'legacy-adoption-rollback-secret';
  const setup = await prepareProtectedMigration(dir, 'DELETE', sentinel);
  const searchPlaintext = WEB_SEARCH_STORED_SECRET_FIELDS.map(field => `${sentinel}-${field.provider}`);
  await setup.db.prepare(
    'UPDATE search_config SET tavily_api_key = ?, microsoft_web_iq_api_key = ?, jina_api_key = ?',
  ).bind(...searchPlaintext).run();
  await setup.db.prepare('UPDATE upstreams SET config_json = ?').bind(`{"apiKey":"${sentinel}-upstream"}`).run();
  await setup.db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
  await setup.db.prepare('INSERT INTO _migrations (name) VALUES (?)')
    .bind('0083_canonical_protocol_names.sql')
    .run();
  const sealCause = new Error('legacy adoption seal sentinel');
  const failingCodec: StoredSecretCodec = {
    open: () => Promise.reject(new Error('legacy adoption attempted decryption')),
    seal: () => Promise.reject(sealCause),
  };

  const error = await assertRejects(() => applyMigrations(
    setup.db,
    setup.migrationDir,
    failingCodec,
    { adoptLegacyPlaintext: true },
  ));
  assert(error === sealCause);
  const columns = await setup.db.prepare('PRAGMA table_info(search_config)').all<{ name: string }>();
  assertEquals(columns.results.some(column => column.name === 'tavily_api_key'), true);
  assertEquals(
    await setup.db.prepare('SELECT tavily_api_key FROM search_config').first<{ tavily_api_key: string }>(),
    { tavily_api_key: searchPlaintext[0] },
  );
  assertEquals(
    await setup.db.prepare('SELECT name FROM _migrations WHERE name = ?')
      .bind(PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION)
      .first(),
    null,
  );
}));

test('legacy plaintext adoption seals upstream and search values through 0084', () => withTemp(async dir => {
  const sentinel = 'legacy-adoption-success';
  const setup = await prepareProtectedMigration(dir, 'DELETE', sentinel);
  await setup.db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
  await setup.db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind('0083_canonical_protocol_names.sql').run();
  await setup.db.prepare('UPDATE upstreams SET config_json = ?').bind(`{"apiKey":"${sentinel}"}`).run();
  await setup.db.prepare('UPDATE search_config SET tavily_api_key = ?').bind(sentinel).run();

  await applyMigrations(setup.db, setup.migrationDir, setup.codec, { adoptLegacyPlaintext: true });
  const upstream = await setup.db.prepare('SELECT config_json FROM upstreams').first<{ config_json: string }>();
  assert(upstream !== null);
  assertEquals(await setup.codec.open(upstream.config_json, upstreamConfigSecretContext('up_raw_scan')), `{"apiKey":"${sentinel}"}`);
  const search = await setup.db.prepare('SELECT protected_tavily_api_key FROM search_config')
    .first<{ protected_tavily_api_key: string }>();
  assert(search !== null);
  assertEquals(await setup.codec.open(search.protected_tavily_api_key, WEB_SEARCH_STORED_SECRET_FIELDS[0].context), sentinel);
}));
