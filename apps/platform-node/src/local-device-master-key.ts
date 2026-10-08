import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DeviceMasterKeyCredential } from './device-master-key.ts';
import { resolvePersonalRuntimePaths, type PersonalRuntimePaths } from './personal-runtime.ts';
import { initializePersonalStorage, type PrivateStoragePermissions } from './personal-storage.ts';

export const localDeviceMasterKeyPath = (paths: PersonalRuntimePaths): string =>
  join(paths.dataDir, 'credentials', 'device-master-key-v1.key');

// The OS user's private application-data directory is the storage boundary.
// No system credential store, native credential binding, or interactive unlock
// participates in startup. Existing encrypted databases must retain their key.
export const createLocalDeviceMasterKeyCredential = (
  paths: PersonalRuntimePaths = resolvePersonalRuntimePaths(),
  permissions: PrivateStoragePermissions = initializePersonalStorage(paths),
): DeviceMasterKeyCredential => {
  const target = localDeviceMasterKeyPath(paths);
  const directory = dirname(target);
  permissions.ensureDirectory(directory);
  return {
    getSecret: () => {
      try {
        const metadata = lstatSync(target);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Floway local master key must be a regular file');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw cause;
      }
      permissions.hardenFile(target);
      const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const metadata = fstatSync(descriptor);
        if (!metadata.isFile() || metadata.size !== 32) throw new Error('Floway local master key must contain exactly 32 bytes');
        return Uint8Array.from(readFileSync(descriptor));
      } finally {
        closeSync(descriptor);
      }
    },
    setSecret: secret => {
      if (secret.byteLength !== 32) throw new Error('Floway local master key must contain exactly 32 bytes');
      const temporary = join(directory, `.device-master-key-${randomUUID()}.tmp`);
      try {
        const descriptor = openSync(temporary, 'wx', 0o600);
        try {
          writeFileSync(descriptor, secret);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        permissions.hardenFile(temporary);
        // link is an exclusive atomic publication: readers never see a partial
        // key, and an existing key cannot be replaced even by a competing writer.
        // https://nodejs.org/api/fs.html#fslinksyncexistingpath-newpath
        linkSync(temporary, target);
        rmSync(temporary);
        permissions.hardenFile(target);
        if (process.platform !== 'win32') {
          const parent = openSync(directory, constants.O_RDONLY);
          try { fsyncSync(parent); } finally { closeSync(parent); }
        }
      } catch (cause) {
        try { rmSync(temporary, { force: true }); } catch { /* retain the original storage failure */ }
        throw cause;
      }
    },
    deleteSecret: () => {
      try { rmSync(target); return true; } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw cause;
      }
    },
  };
};
