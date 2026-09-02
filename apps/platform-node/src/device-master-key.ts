import { randomBytes } from 'node:crypto';

import { Entry } from '@napi-rs/keyring';

const DEVICE_MASTER_KEY_BYTES = 32;
// The binding maps this service/account entry to macOS Keychain, Windows
// Credential Manager, and the Linux system keyring backend without writing a
// key file beside SQLite.
// https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs
const CREDENTIAL_SERVICE = 'Floway One';
const CREDENTIAL_ACCOUNT = 'device-master-key-v1';

export interface DeviceMasterKeyCredential {
  getSecret(): ArrayLike<number> | null;
  setSecret(secret: Uint8Array): void;
}

const createCredential = (): DeviceMasterKeyCredential =>
  new Entry(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT);

const validateMasterKey = (stored: ArrayLike<number>): Uint8Array => {
  const bytes = Array.from(stored);
  if (bytes.length !== DEVICE_MASTER_KEY_BYTES || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`Floway One device master key must contain exactly ${DEVICE_MASTER_KEY_BYTES} bytes`);
  }
  return Uint8Array.from(bytes);
};

export const loadDeviceMasterKey = (
  createIfMissing: boolean,
  credential: DeviceMasterKeyCredential = createCredential(),
  generate: (size: number) => Uint8Array = randomBytes,
): Uint8Array => {
  let stored: ArrayLike<number> | null;
  try {
    stored = credential.getSecret();
  } catch (cause) {
    throw new Error('Failed to read the Floway One device master key from the operating system credential store', { cause });
  }
  if (stored !== null) return validateMasterKey(stored);
  if (!createIfMissing) {
    throw new Error('Floway One device master key is missing from the operating system credential store');
  }

  const generated = validateMasterKey(generate(DEVICE_MASTER_KEY_BYTES));
  try {
    credential.setSecret(generated);
  } catch (cause) {
    throw new Error('Failed to save the Floway One device master key in the operating system credential store', { cause });
  }
  return generated;
};
