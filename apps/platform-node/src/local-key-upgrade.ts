import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fsyncSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import type { PersonalRuntimePaths } from './personal-runtime.ts';
import type { PrivateStoragePermissions } from './personal-storage.ts';
import { DesktopStartupError, startupFailure } from './startup-failure.ts';
import { inspectProtectedStorage, upstreamConfigSecretContext, WEB_SEARCH_STORED_SECRET_FIELDS } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec, type SqlDatabase } from '@floway-dev/platform';

const STATE_TABLE = 'floway_local_key_state';
interface KeyState { phase: 'active' | 'reset-pending'; snapshot: string | null }

const readState = async (db: SqlDatabase): Promise<KeyState | null> => {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind(STATE_TABLE).first();
  if (exists === null) return null;
  const state = await db.prepare(`SELECT phase, snapshot FROM ${STATE_TABLE} WHERE id=1`).first<KeyState>();
  if (state === null || !['active', 'reset-pending'].includes(state.phase)) throw new Error('Floway local key state is invalid');
  return state;
};

const writeState = async (db: SqlDatabase, phase: KeyState['phase'], snapshot: string | null): Promise<void> => {
  await db.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL, snapshot TEXT)`);
  await db.prepare(`INSERT INTO ${STATE_TABLE} VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, snapshot=excluded.snapshot`)
    .bind(phase, snapshot).run();
};

const snapshotLegacyDatabase = async (paths: PersonalRuntimePaths, permissions: PrivateStoragePermissions): Promise<string> => {
  const directory = join(paths.dataDir, 'credential-upgrade');
  permissions.ensureDirectory(directory);
  const target = join(directory, `before-local-key-${randomUUID()}.db`);
  const descriptor = openSync(target, 'wx', 0o600);
  closeSync(descriptor);
  permissions.hardenFile(target);
  const source = new DatabaseSync(paths.databasePath, { readOnly: true });
  try {
    // Includes committed WAL contents; a filesystem copy could omit them.
    // https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options
    await backup(source, target);
    permissions.hardenFile(target);
    const file = openSync(target, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    if (process.platform !== 'win32') {
      const parent = openSync(dirname(target), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    return target;
  } finally {
    source.close();
  }
};

export const prepareLocalKeyUpgrade = async (
  db: SqlDatabase,
  paths: PersonalRuntimePaths,
  permissions: PrivateStoragePermissions,
  lock: DeviceMasterKeyCreationLock,
  credential: DeviceMasterKeyCredential,
): Promise<void> => await lock.run(async () => {
  let state = await readState(db);
  const key = await credential.getSecret();
  if (state?.phase === 'active') {
    if (key === null) throw startupFailure('credential', 'Floway local encryption key is missing',
      new Error('The existing local key must be restored; saved credentials have not been reset'));
    return;
  }
  const status = await inspectProtectedStorage(db);
  if (state === null && key === null && status.inputMode === 'ciphertext' && status.hasProtectedValues) {
    const snapshot = await snapshotLegacyDatabase(paths, permissions);
    await writeState(db, 'reset-pending', snapshot);
    state = { phase: 'reset-pending', snapshot };
  }
  if (state?.phase === 'reset-pending') {
    if (state.snapshot === null) throw new Error('Floway credential upgrade has no recovery snapshot');
    const snapshotMetadata = lstatSync(state.snapshot);
    if (!snapshotMetadata.isFile() || snapshotMetadata.isSymbolicLink()) {
      throw new Error('Floway credential upgrade recovery snapshot must be a regular file');
    }
    permissions.hardenFile(state.snapshot);
    const snapshot = new DatabaseSync(state.snapshot, { readOnly: true });
    try {
      const integrity = snapshot.prepare('PRAGMA quick_check').get();
      if (integrity?.quick_check !== 'ok') throw new Error('Floway credential upgrade recovery snapshot is invalid');
      snapshot.prepare('SELECT id, config_json FROM upstreams').all();
    } finally { snapshot.close(); }
    if (db.transaction === undefined) throw new Error('Floway credential upgrade requires an atomic local transaction');
    const masterKey = await loadDeviceMasterKey({ run: operation => operation() }, true, credential);
    try {
      const codec = createAes256GcmStoredSecretCodec(masterKey);
      await db.transaction(async () => {
        const rows = await db.prepare('SELECT id FROM upstreams').all<{ id: string }>();
        for (const row of rows.results) {
          await db.prepare('UPDATE upstreams SET config_json=?, state_json=NULL WHERE id=?')
            .bind(await codec.seal('{}', upstreamConfigSecretContext(row.id)), row.id).run();
        }
        for (const field of WEB_SEARCH_STORED_SECRET_FIELDS) {
          await db.exec(`UPDATE search_config SET ${field.column}=''`);
        }
        await writeState(db, 'active', state!.snapshot);
      });
      console.warn('Floway upgraded local key storage. Re-enter provider and search credentials; other settings and the original database snapshot have been kept.');
    } finally { masterKey.fill(0); }
    return;
  }
  // A new/legacy-plaintext database can create a key without discarding values.
  // With an existing key, normal stored-secret validation remains authoritative.
  const masterKey = await loadDeviceMasterKey({ run: operation => operation() },
    status.inputMode === 'legacy-plaintext' || !status.hasProtectedValues, credential);
  masterKey.fill(0);
  await writeState(db, 'active', null);
}).catch((cause: unknown) => {
  if (cause instanceof DesktopStartupError) throw cause;
  throw startupFailure('credential', 'Floway could not prepare its local encryption key', cause);
});
