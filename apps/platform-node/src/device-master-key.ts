import { randomBytes } from 'node:crypto';

import { Entry, findCredentials, type Credential } from '@napi-rs/keyring';

import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY } from './device-master-key-credential-identity.ts';

const DEVICE_MASTER_KEY_BYTES = 32;
type Awaitable<T> = T | Promise<T>;

export interface DeviceMasterKeyCredential {
  getSecret(): Awaitable<ArrayLike<number> | null>;
  setSecret(secret: Uint8Array): Awaitable<void>;
  deleteSecret?(): Awaitable<boolean>;
}

interface KeyringEntry {
  getSecret(): ArrayLike<number> | null;
  setSecret(secret: Uint8Array): void;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

interface KeyringBindings {
  Entry: new (service: string, account: string) => KeyringEntry;
  findCredentials(service: string): Credential[];
}

const defaultKeyringBindings: KeyringBindings = { Entry, findCredentials };

const encodeLinuxSecret = (secret: Uint8Array): string => Buffer.from(secret).toString('base64');

const decodeLinuxSecret = (stored: string): Uint8Array => {
  const decoded = Buffer.from(stored, 'base64');
  if (decoded.toString('base64') !== stored) {
    throw new Error('Floway One device master key in Linux Secret Service is not canonical base64');
  }
  return new Uint8Array(decoded);
};

// The binding maps this service/account entry to macOS Keychain, Windows
// Credential Manager, and the Linux system keyring backend without writing a
// key file beside SQLite.
// https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs
export const createOperatingSystemCredential = (
  service: string = DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY.service,
  account: string = DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY.account,
  platform: NodeJS.Platform = process.platform,
  bindings: KeyringBindings = defaultKeyringBindings,
): DeviceMasterKeyCredential => {
  // Packaged native-platform jobs use this boundary to force the same startup
  // failure on hosts where locking the runner's real credential store is not
  // safe or deterministic.
  const injectedFailure = process.env.FLOWAY_TEST_CREDENTIAL_STORE_FAILURE;
  if (injectedFailure !== undefined) {
    throw new Error('Injected operating system credential-store failure for Floway verification', {
      cause: new Error(injectedFailure),
    });
  }
  if (platform !== 'linux') {
    const entry = new bindings.Entry(service, account);
    return {
      getSecret: () => entry.getSecret(),
      setSecret: secret => entry.setSecret(secret),
      deleteSecret: () => entry.deleteCredential(),
    };
  }

  // keyring-node v2 falls back to the non-durable kernel keyutils store when
  // Secret Service construction fails. Its findCredentials implementation,
  // however, connects to Secret Service directly. Use that direct path as the
  // authoritative read/probe and verify every mutation through it so the
  // fallback can never be silently accepted.
  // https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/linux_credential_builder.rs
  // https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs#L527-L553
  const listFromSecretService = (): Credential[] => {
    try {
      return bindings.findCredentials(service);
    } catch (cause) {
      throw new Error('Linux Secret Service is unavailable for the Floway One device master key', { cause });
    }
  };
  const readPassword = (): string | null => {
    const matches = listFromSecretService().filter(credential => credential.account === account);
    if (matches.length > 1) {
      throw new Error('Linux Secret Service contains ambiguous Floway One device master key entries');
    }
    return matches[0]?.password ?? null;
  };

  listFromSecretService();
  const entry = new bindings.Entry(service, account);
  return {
    getSecret: () => {
      const password = readPassword();
      return password === null ? null : decodeLinuxSecret(password);
    },
    setSecret: secret => {
      const encoded = encodeLinuxSecret(secret);
      entry.setPassword(encoded);
      if (readPassword() !== encoded) {
        throw new Error('Failed to verify the Floway One device master key in Linux Secret Service');
      }
    },
    deleteSecret: () => {
      const deleted = entry.deleteCredential();
      if (readPassword() !== null) {
        throw new Error('Failed to delete the Floway One device master key from Linux Secret Service');
      }
      return deleted;
    },
  };
};

const validateMasterKey = (stored: ArrayLike<number>): Uint8Array => {
  const bytes = Array.from(stored);
  if (bytes.length !== DEVICE_MASTER_KEY_BYTES || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`Floway One device master key must contain exactly ${DEVICE_MASTER_KEY_BYTES} bytes`);
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
    resolvedCredential = credential ?? createOperatingSystemCredential();
    stored = await resolvedCredential.getSecret();
  } catch (cause) {
    throw new Error('Failed to read the Floway One device master key from the operating system credential store', { cause });
  }
  if (stored !== null) return validateMasterKey(stored);
  if (!createIfMissing) {
    throw new Error('Floway One device master key is missing from the operating system credential store');
  }

  const generated = validateMasterKey(generate(DEVICE_MASTER_KEY_BYTES));
  try {
    await resolvedCredential.setSecret(generated);
  } catch (cause) {
    throw new Error('Failed to save the Floway One device master key in the operating system credential store', { cause });
  }

  let authoritative: ArrayLike<number> | null;
  try {
    authoritative = await resolvedCredential.getSecret();
  } catch (cause) {
    throw new Error('Failed to read back the Floway One device master key from the operating system credential store', { cause });
  }
  if (authoritative === null) {
    throw new Error('Floway One device master key was not persisted by the operating system credential store');
  }
  return validateMasterKey(authoritative);
});
