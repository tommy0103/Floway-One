import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { applyMigrations, type ProtectedMigrationTransitions } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import {
  SqlRepo,
  UPSTREAM_CONFIG_STORED_SECRET_FIELD,
  UPSTREAM_STATE_STORED_SECRET_FIELD,
  upstreamConfigSecretContext,
  upstreamStateSecretContext,
  WEB_SEARCH_STORED_SECRET_FIELDS,
} from '@floway-dev/gateway';
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

test('personal encrypted web-search secrets migrate as plaintext and remain readable ciphertext', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'encrypted-search-upgrade.db'));
  await applyMigrations(db);
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(8));
  const repo = new SqlRepo(db, { storedSecrets: codec });
  await repo.webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'tavily-upgrade-secret' },
    microsoftWebIq: { apiKey: 'microsoft-upgrade-secret' },
    jina: { apiKey: 'jina-upgrade-secret' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  const migrationsDir = join(dir, 'encrypted-search-migrations');
  await mkdir(migrationsDir);
  await writeFile(join(migrationsDir, '9001_encrypted_search.sql'), `
    UPDATE search_config
    SET tavily_api_key = tavily_api_key || '-migrated',
        microsoft_web_iq_api_key = microsoft_web_iq_api_key || '-migrated',
        jina_api_key = jina_api_key || '-migrated'
    WHERE id = 1;
  `);

  await applyMigrations(db, migrationsDir, codec);

  const raw = await db.prepare(`SELECT ${WEB_SEARCH_STORED_SECRET_FIELDS.map(field => field.column).join(', ')} FROM search_config WHERE id = 1`)
    .first<Record<(typeof WEB_SEARCH_STORED_SECRET_FIELDS)[number]['column'], string>>();
  assert(raw !== null);
  for (const field of WEB_SEARCH_STORED_SECRET_FIELDS) {
    assertEquals(raw[field.column].includes('upgrade-secret'), false);
  }
  const readable = await repo.webSearchConfig.get() as {
    tavily: { apiKey: string };
    microsoftWebIq: { apiKey: string };
    jina: { apiKey: string };
  };
  assertEquals(readable.tavily.apiKey, 'tavily-upgrade-secret-migrated');
  assertEquals(readable.microsoftWebIq.apiKey, 'microsoft-upgrade-secret-migrated');
  assertEquals(readable.jina.apiKey, 'jina-upgrade-secret-migrated');
}));

test('personal protected migrations restore ciphertext after rebuilding tables and renaming columns', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'protected-schema-transition.db'));
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(9));
  const upstreamId = 'up_schema_transition';
  await db.exec(`
    CREATE TABLE upstreams (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, state_json TEXT NULL);
    CREATE TABLE search_config (
      id INTEGER PRIMARY KEY,
      tavily_api_key TEXT NOT NULL,
      microsoft_web_iq_api_key TEXT NOT NULL,
      jina_api_key TEXT NOT NULL
    );
  `);
  const configCiphertext = await codec.seal('{"apiKey":"transition-config"}', upstreamConfigSecretContext(upstreamId));
  const stateCiphertext = await codec.seal('{"refreshToken":"transition-state"}', upstreamStateSecretContext(upstreamId));
  const searchCiphertexts = await Promise.all(WEB_SEARCH_STORED_SECRET_FIELDS.map(field =>
    codec.seal(`${field.provider}-transition-secret`, field.context)));
  await db.prepare('INSERT INTO upstreams (id, config_json, state_json) VALUES (?, ?, ?)')
    .bind(upstreamId, configCiphertext, stateCiphertext)
    .run();
  await db.prepare('INSERT INTO search_config (id, tavily_api_key, microsoft_web_iq_api_key, jina_api_key) VALUES (1, ?, ?, ?)')
    .bind(...searchCiphertexts)
    .run();

  const migrationsDir = join(dir, 'protected-schema-migrations');
  await mkdir(migrationsDir);
  const migrationName = '9002_rebuild_protected_storage.sql';
  await writeFile(join(migrationsDir, migrationName), `
    CREATE TABLE protected_upstreams (
      upstream_key TEXT PRIMARY KEY,
      protected_config TEXT NOT NULL,
      protected_state TEXT NULL
    );
    INSERT INTO protected_upstreams SELECT id, config_json, state_json FROM upstreams;
    DROP TABLE upstreams;
    CREATE TABLE protected_search_config (
      config_key INTEGER PRIMARY KEY,
      protected_tavily TEXT NOT NULL,
      protected_microsoft TEXT NOT NULL,
      protected_jina TEXT NOT NULL
    );
    INSERT INTO protected_search_config
      SELECT id, tavily_api_key, microsoft_web_iq_api_key, jina_api_key FROM search_config;
    DROP TABLE search_config;
  `);
  const protectedSearchColumns = {
    tavily: 'protected_tavily',
    'microsoft-web-iq': 'protected_microsoft',
    jina: 'protected_jina',
  } as const;
  const transitions: ProtectedMigrationTransitions = {
    [migrationName]: [
      {
        field: UPSTREAM_CONFIG_STORED_SECRET_FIELD,
        after: { table: 'protected_upstreams', identityColumn: 'upstream_key', column: 'protected_config' },
      },
      {
        field: UPSTREAM_STATE_STORED_SECRET_FIELD,
        after: { table: 'protected_upstreams', identityColumn: 'upstream_key', column: 'protected_state' },
      },
      ...WEB_SEARCH_STORED_SECRET_FIELDS.map(field => ({
        field,
        after: {
          table: 'protected_search_config',
          identityColumn: 'config_key',
          column: protectedSearchColumns[field.provider],
        },
      })),
    ],
  };

  await applyMigrations(db, migrationsDir, codec, transitions);

  const upstream = await db.prepare('SELECT upstream_key, protected_config, protected_state FROM protected_upstreams')
    .first<{ upstream_key: string; protected_config: string; protected_state: string }>();
  assert(upstream !== null);
  assertEquals(upstream.protected_config.includes('transition-config'), false);
  assertEquals(upstream.protected_state.includes('transition-state'), false);
  assertEquals(
    await codec.open(upstream.protected_config, upstreamConfigSecretContext(upstream.upstream_key)),
    '{"apiKey":"transition-config"}',
  );
  assertEquals(
    await codec.open(upstream.protected_state, upstreamStateSecretContext(upstream.upstream_key)),
    '{"refreshToken":"transition-state"}',
  );
  const search = await db.prepare('SELECT config_key, protected_tavily, protected_microsoft, protected_jina FROM protected_search_config')
    .first<{ config_key: number; protected_tavily: string; protected_microsoft: string; protected_jina: string }>();
  assert(search !== null);
  for (const field of WEB_SEARCH_STORED_SECRET_FIELDS) {
    const column = protectedSearchColumns[field.provider];
    assertEquals(search[column].includes('transition-secret'), false);
    assertEquals(await codec.open(search[column], field.context), `${field.provider}-transition-secret`);
  }
}));

test('personal encrypted migration preserves a re-encryption cause and rolls back SQL data and schema', () => withTemp(async dir => {
  const db = createNodeSqliteDatabase(join(dir, 'encrypted-failure.db'));
  await applyMigrations(db);
  const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(10));
  const id = 'up_encrypted_failure';
  const stored = await codec.seal('{"apiKey":"rollback-secret"}', upstreamConfigSecretContext(id));
  await db.prepare(
    `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, flag_overrides, hue)
     VALUES (?, 'custom', 'Encrypted failure', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', ?, '{}', 210)`,
  ).bind(id, stored).run();
  await db.exec("CREATE TABLE migration_probe (value TEXT NOT NULL); INSERT INTO migration_probe VALUES ('before');");

  const migrationsDir = join(dir, 'failing-encrypted-migrations');
  await mkdir(migrationsDir);
  const migrationName = '9003_reencrypt_failure.sql';
  await writeFile(join(migrationsDir, migrationName), `
    ALTER TABLE migration_probe ADD COLUMN added_by_migration TEXT DEFAULT 'added';
    UPDATE migration_probe SET value = 'after';
    UPDATE upstreams SET config_json = json_set(config_json, '$.migrated', json('true')) WHERE id = '${id}';
  `);
  const reEncryptionCause = new Error('re-encryption boundary sentinel');
  let sealAttempts = 0;
  const failingCodec: StoredSecretCodec = {
    open: (value, context) => codec.open(value, context),
    seal: async () => {
      sealAttempts++;
      throw reEncryptionCause;
    },
  };

  const error = await assertRejects(
    () => applyMigrations(db, migrationsDir, failingCodec),
  );
  assert(error === reEncryptionCause);
  assertEquals(sealAttempts, 1);
  assertEquals(
    (await db.prepare('SELECT config_json FROM upstreams WHERE id = ?').bind(id).first<{ config_json: string }>())?.config_json,
    stored,
  );
  assertEquals(
    await db.prepare('SELECT value FROM migration_probe').first<{ value: string }>(),
    { value: 'before' },
  );
  const probeColumns = await db.prepare('PRAGMA table_info(migration_probe)').all<{ name: string }>();
  assertEquals(probeColumns.results.map(column => column.name), ['value']);
  assertEquals(
    await db.prepare('SELECT name FROM _migrations WHERE name = ?').bind(migrationName).first(),
    null,
  );
}));
