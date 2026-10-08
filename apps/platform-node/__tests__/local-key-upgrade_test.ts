import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, test } from 'vitest';

import { createDeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
import { createLocalDeviceMasterKeyCredential, localDeviceMasterKeyPath } from '../src/local-device-master-key.ts';
import { prepareLocalKeyUpgrade } from '../src/local-key-upgrade.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { initializePersonalStorage } from '../src/personal-storage.ts';
import { createNodeStoredSecretCodec } from '../src/stored-secrets.ts';
import { PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION, upstreamConfigSecretContext } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec, type SqlDatabase, type StoredSecretContext } from '@floway-dev/platform';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-key-upgrade-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolvePersonalRuntimePaths({ dataDir: root, stableUserHome: root });
  const permissions = initializePersonalStorage(paths);
  const original = new DatabaseSync(paths.databasePath);
  cleanups.push(() => original.close());
  original.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE _migrations (name TEXT PRIMARY KEY);
    INSERT INTO _migrations VALUES ('${PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION}');
    CREATE TABLE upstreams (id TEXT PRIMARY KEY, name TEXT, config_json TEXT, state_json TEXT);
    CREATE TABLE search_config (id INTEGER PRIMARY KEY, protected_tavily_api_key TEXT,
      protected_microsoft_web_iq_api_key TEXT, protected_jina_api_key TEXT);
    CREATE TABLE preserved_settings (models TEXT, routes TEXT, usage INTEGER);
    INSERT INTO preserved_settings VALUES ('configured-model', 'configured-route', 123);
  `);
  const oldCodec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(31));
  const oldConfig = await oldCodec.seal('{"apiKey":"old-key","baseUrl":"https://old.example"}', upstreamConfigSecretContext('up_old'));
  original.prepare('INSERT INTO upstreams VALUES (?, ?, ?, ?)').run('up_old', 'My provider', oldConfig,
    await oldCodec.seal('{"refreshToken":"old-token"}', 'upstream:up_old:state' as StoredSecretContext));
  original.prepare('INSERT INTO search_config VALUES (1, ?, ?, ?)').run(
    await oldCodec.seal('old-search-key', 'web-search:tavily:api-key' as StoredSecretContext), '', '',
  );
  const db = createNodeSqliteDatabase(paths.databasePath, { permissions });
  const credential = createLocalDeviceMasterKeyCredential(paths, permissions);
  const lock = createDeviceMasterKeyCreationLock({ lockDatabasePath: paths.credentialLockDatabasePath });
  return {
    original, oldConfig, db, paths, permissions, credential, lock,
    upgrade: () => prepareLocalKeyUpgrade(db, paths, permissions, lock, credential),
  };
};

test('Floway upgrades an older encrypted installation without its old key and preserves a complete private snapshot', async () => {
  const f = await fixture();
  await f.upgrade();
  const codec = await createNodeStoredSecretCodec('personal', f.db, f.lock, f.credential);
  const row = f.original.prepare('SELECT * FROM upstreams').get()!;
  expect(row.name).toBe('My provider');
  expect(await codec.open(String(row.config_json), upstreamConfigSecretContext('up_old'))).toBe('{}');
  expect(row.state_json).toBeNull();
  expect(f.original.prepare('SELECT protected_tavily_api_key FROM search_config').get()?.protected_tavily_api_key).toBe('');
  expect(f.original.prepare('SELECT * FROM preserved_settings').get()).toMatchObject({ models: 'configured-model', routes: 'configured-route', usage: 123 });
  const state = f.original.prepare('SELECT * FROM floway_local_key_state').get()!;
  expect(state.phase).toBe('active');
  const snapshotPath = String(state.snapshot);
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    expect(snapshot.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
    expect(snapshot.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
    expect(snapshot.prepare('SELECT usage FROM preserved_settings').get()?.usage).toBe(123);
  } finally { snapshot.close(); }
  if (process.platform !== 'win32') {
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.paths.dataDir, 'credential-upgrade')).mode & 0o777).toBe(0o700);
  }
  const newConfig = await codec.seal('{"apiKey":"replacement"}', upstreamConfigSecretContext('up_old'));
  f.original.prepare('UPDATE upstreams SET config_json=?').run(newConfig);
  await f.upgrade();
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(newConfig);
  const restarted = await createNodeStoredSecretCodec('personal', f.db, f.lock, createLocalDeviceMasterKeyCredential(f.paths));
  expect(await restarted.open(newConfig, upstreamConfigSecretContext('up_old'))).toBe('{"apiKey":"replacement"}');
  rmSync(localDeviceMasterKeyPath(f.paths));
  await expect(f.upgrade()).rejects.toThrow('missing');
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(newConfig);
});

test('Floway resumes an interrupted upgrade after saving the snapshot without touching old credentials early', async () => {
  const f = await fixture();
  const failure = new Error('interrupted before local key publication');
  await expect(prepareLocalKeyUpgrade(f.db, f.paths, f.permissions, f.lock, {
    getSecret: () => null, setSecret: () => { throw failure; },
  })).rejects.toMatchObject({ cause: failure });
  expect(f.original.prepare('SELECT phase FROM floway_local_key_state').get()?.phase).toBe('reset-pending');
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
  await f.upgrade();
  expect(f.original.prepare('SELECT phase FROM floway_local_key_state').get()?.phase).toBe('active');
});

test('Floway rolls back the whole credential reset if any field fails, then safely retries', async () => {
  const f = await fixture();
  f.original.exec("CREATE TRIGGER fail_reset BEFORE UPDATE ON search_config BEGIN SELECT RAISE(ABORT, 'reset failed sentinel'); END");
  await expect(f.upgrade()).rejects.toThrow('local encryption key');
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
  expect(f.original.prepare('SELECT phase FROM floway_local_key_state').get()?.phase).toBe('reset-pending');
  f.original.exec('DROP TRIGGER fail_reset');
  await f.upgrade();
  expect(f.original.prepare('SELECT phase FROM floway_local_key_state').get()?.phase).toBe('active');
});

test('Floway refuses to reset old credentials without its recovery snapshot', async () => {
  const f = await fixture();
  await expect(prepareLocalKeyUpgrade(f.db, f.paths, f.permissions, f.lock, {
    getSecret: () => null, setSecret: () => { throw new Error('interruption'); },
  })).rejects.toThrow();
  const snapshot = String(f.original.prepare('SELECT snapshot FROM floway_local_key_state').get()?.snapshot);
  rmSync(snapshot);
  await expect(f.upgrade()).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
  expect(await f.credential.getSecret()).toBeNull();
});

test('Floway keeps the original database and error chain when snapshot creation fails', async () => {
  const f = await fixture();
  const cause = new Error('snapshot write failed sentinel');
  await expect(prepareLocalKeyUpgrade(f.db, f.paths, {
    ...f.permissions,
    ensureDirectory: () => { throw cause; },
  }, f.lock, f.credential)).rejects.toMatchObject({ cause });
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
  expect(f.original.prepare("SELECT name FROM sqlite_master WHERE name='floway_local_key_state'").get()).toBeUndefined();
});

test('Floway rolls back an interrupted upgrade marker creation so the next launch can retry', async () => {
  const f = await fixture();
  const cause = new Error('interrupted after marker table creation');
  let tableCreated = false;
  const interrupted: SqlDatabase = {
    prepare: query => {
      if (query.startsWith('INSERT INTO floway_local_key_state')) {
        expect(tableCreated).toBe(true);
        throw cause;
      }
      return f.db.prepare(query);
    },
    exec: async query => {
      await f.db.exec(query);
      if (query.startsWith('CREATE TABLE IF NOT EXISTS floway_local_key_state')) tableCreated = true;
    },
    transaction: operation => f.db.transaction!(operation),
  };
  await expect(prepareLocalKeyUpgrade(interrupted, f.paths, f.permissions, f.lock, f.credential))
    .rejects.toMatchObject({ cause });
  expect(tableCreated).toBe(true);
  expect(f.original.prepare("SELECT name FROM sqlite_master WHERE name='floway_local_key_state'").get()).toBeUndefined();
  expect(f.original.prepare('SELECT config_json FROM upstreams').get()?.config_json).toBe(f.oldConfig);
  expect(await f.credential.getSecret()).toBeNull();
  await f.upgrade();
  expect(f.original.prepare('SELECT phase FROM floway_local_key_state').get()?.phase).toBe('active');
});
