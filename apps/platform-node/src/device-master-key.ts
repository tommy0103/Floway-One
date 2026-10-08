import { randomBytes } from 'node:crypto';

import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { createLocalDeviceMasterKeyCredential } from './local-device-master-key.ts';
import { startupFailure } from './startup-failure.ts';

const DEVICE_MASTER_KEY_BYTES = 32;
type Awaitable<T> = T | Promise<T>;

export interface DeviceMasterKeyCredential {
  getSecret(): Awaitable<ArrayLike<number> | null>;
  setSecret(secret: Uint8Array): Awaitable<void>;
  deleteSecret?(): Awaitable<boolean>;
}

const validateMasterKey = (stored: ArrayLike<number>): Uint8Array => {
  const bytes = Array.from(stored);
  if (bytes.length !== DEVICE_MASTER_KEY_BYTES || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`Floway device master key must contain exactly ${DEVICE_MASTER_KEY_BYTES} bytes`);
  }
  return Uint8Array.from(bytes);
};

export const loadDeviceMasterKey = async (
  creationLock: DeviceMasterKeyCreationLock,
  createIfMissing: boolean,
  credential?: DeviceMasterKeyCredential,
  generate: (size: number) => Uint8Array = randomBytes,
): Promise<Uint8Array> => await creationLock.run(async () => {
  let resolvedCredential: DeviceMasterKeyCredential;
  let stored: ArrayLike<number> | null;
  try {
    resolvedCredential = credential ?? createLocalDeviceMasterKeyCredential();
    stored = await resolvedCredential.getSecret();
  } catch (cause) {
    throw startupFailure('credential', 'Failed to read the Floway device master key from the local key store', cause);
  }
  if (stored !== null) return validateMasterKey(stored);
  if (!createIfMissing) {
    throw new Error('Floway local device master key is missing; existing encrypted data requires migration');
  }

  const generated = validateMasterKey(generate(DEVICE_MASTER_KEY_BYTES));
  try {
    await resolvedCredential.setSecret(generated);
  } catch (cause) {
    throw startupFailure('credential', 'Failed to save the Floway device master key in the local key store', cause);
  }

  let authoritative: ArrayLike<number> | null;
  try {
    authoritative = await resolvedCredential.getSecret();
  } catch (cause) {
    throw startupFailure('credential', 'Failed to read back the Floway device master key from the local key store', cause);
  }
  if (authoritative === null) {
    throw new Error('Floway device master key was not persisted by the local key store');
  }
  return validateMasterKey(authoritative);
});
