import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import { databaseHasProtectedValues, validateStoredSecrets } from '@floway-dev/gateway';
import {
  createAes256GcmStoredSecretCodec,
  plaintextStoredSecretCodec,
  type RuntimeProfileMode,
  type SqlDatabase,
  type StoredSecretCodec,
} from '@floway-dev/platform';

export const createNodeStoredSecretCodec = async (
  profile: RuntimeProfileMode,
  db: SqlDatabase,
  creationLock?: DeviceMasterKeyCreationLock,
  credential?: DeviceMasterKeyCredential,
  options: { readonly validate?: boolean } = {},
): Promise<StoredSecretCodec> => {
  if (profile === 'server') return plaintextStoredSecretCodec;
  if (creationLock === undefined) throw new Error('Personal profile requires a device master key creation lock');

  const hasProtectedValues = await databaseHasProtectedValues(db);
  const masterKey = await loadDeviceMasterKey(creationLock, !hasProtectedValues, credential);
  const storedSecrets = createAes256GcmStoredSecretCodec(masterKey);
  if (options.validate !== false) await validateStoredSecrets(db, storedSecrets);
  return storedSecrets;
};
