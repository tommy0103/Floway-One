import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import { inspectProtectedStorage, validateStoredSecrets } from '@floway-dev/gateway';
import {
  createAes256GcmStoredSecretCodec,
  plaintextStoredSecretCodec,
  type RuntimeProfileMode,
  type SqlDatabase,
  type StoredSecretCodec,
} from '@floway-dev/platform';

export interface NodeStoredSecretCodec extends StoredSecretCodec {
  readonly requiresLegacyAdoption: boolean;
}

export const createNodeStoredSecretCodec = async (
  profile: RuntimeProfileMode,
  db: SqlDatabase,
  creationLock?: DeviceMasterKeyCreationLock,
  credential?: DeviceMasterKeyCredential,
  options: { readonly validate?: boolean } = {},
): Promise<NodeStoredSecretCodec> => {
  if (profile === 'server') return { ...plaintextStoredSecretCodec, requiresLegacyAdoption: false };
  if (creationLock === undefined) throw new Error('Personal profile requires a device master key creation lock');

  const status = await inspectProtectedStorage(db);
  const masterKey = await loadDeviceMasterKey(
    creationLock,
    status.requiresLegacyAdoption || !status.hasProtectedValues,
    credential,
  );
  const storedSecrets = {
    ...createAes256GcmStoredSecretCodec(masterKey),
    requiresLegacyAdoption: status.requiresLegacyAdoption,
  };
  if (options.validate !== false) await validateStoredSecrets(db, storedSecrets);
  return storedSecrets;
};
