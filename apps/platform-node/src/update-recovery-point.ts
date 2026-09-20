import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bootstrapNodePlatform } from './bootstrap.ts';
import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import type { PersonalRuntimePaths } from './personal-runtime.ts';
import type { InitializedPersonalStorage } from './personal-storage.ts';
import { prepareNodePlatform, type NodeEntryOverrides } from './run-node-entry.ts';
import { collectExportPayload, createEncryptedBackupArchive } from '@floway-dev/gateway';

export const UPDATE_RECOVERY_POINT_EVENT_PREFIX = 'FLOWAY_UPDATE_RECOVERY_POINT ';
export const DESKTOP_DATA_ROOT_ENV = 'FLOWAY_DESKTOP_DATA_DIR';

// These names mirror UPDATE_DIRECTORY_NAME and UPDATE_RECOVERY_POINT_FILE_NAME
// in apps/desktop/src-tauri/src/update_channel.rs; the shell owns the directory
// and the runtime owns the archive bytes.
const UPDATE_DIRECTORY_NAME = 'update';
const UPDATE_RECOVERY_POINT_FILE_NAME = 'recovery-point.json';

export interface UpdateRecoveryPointResult {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface UpdateRecoveryPointOptions {
  // The archive key must come from the same device master key that protects
  // stored secrets, so tests and the packaged verifier pass the credential
  // their stored-secret codec override uses; production reads the operating
  // system credential store by default.
  readonly deviceMasterKeyCredential?: DeviceMasterKeyCredential;
  readonly overrides: NodeEntryOverrides;
  readonly paths: PersonalRuntimePaths;
  readonly storage: InitializedPersonalStorage;
}

const archivePassword = (masterKey: Uint8Array): string =>
  Buffer.from(masterKey).toString('hex');

// The pre-update recovery point reuses the full-backup archive from #21 with
// the archive key derived from the device master key instead of a user
// password: it is a same-device recovery point, so it does not need the
// cross-device password story, and it stays unusable off this device because
// the master key never leaves the operating-system credential store.
export const createUpdateRecoveryPoint = async (
  options: UpdateRecoveryPointOptions,
): Promise<UpdateRecoveryPointResult> => {
  const { overrides, paths, storage } = options;
  const bootstrapped = (overrides.bootstrapNodePlatform ?? bootstrapNodePlatform)({
    profile: 'personal',
    storage: paths,
    personalStorage: storage,
  });
  await prepareNodePlatform(bootstrapped, 'personal', overrides, paths.databasePath);
  const creationLock = bootstrapped.deviceMasterKeyCreationLock;
  if (creationLock === undefined) throw new Error('Personal profile requires a device master key creation lock');
  const masterKey = await loadDeviceMasterKey(creationLock, false, options.deviceMasterKeyCredential);
  try {
    const { payload } = await collectExportPayload(false);
    const archive = await createEncryptedBackupArchive(payload, archivePassword(masterKey));
    const encoded = `${JSON.stringify(archive, undefined, 2)}\n`;

    // The shell hands its own data root to this child so the recovery point
    // always sits next to the owning update state, even when the runtime
    // resolves a different personal data directory.
    const dataRoot = process.env[DESKTOP_DATA_ROOT_ENV] ?? paths.dataDir;
    const recoveryDirectory = join(dataRoot, UPDATE_DIRECTORY_NAME);
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    storage.ensureDirectory(recoveryDirectory);
    const target = join(recoveryDirectory, UPDATE_RECOVERY_POINT_FILE_NAME);
    const temporary = join(recoveryDirectory, `.${UPDATE_RECOVERY_POINT_FILE_NAME}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, encoded, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, target);
      chmodSync(target, 0o600);
      storage.hardenFile(target);
    } catch (cause) {
      try { rmSync(temporary, { force: true }); } catch { /* preserve the storage failure */ }
      throw new Error(`Floway could not persist the pre-update recovery point at ${target}`, { cause });
    }
    return {
      bytes: Buffer.byteLength(encoded),
      path: target,
      sha256: createHash('sha256').update(encoded).digest('hex'),
    };
  } finally {
    masterKey.fill(0);
  }
};
