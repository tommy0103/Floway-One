import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Entry, findCredentials, type Credential } from '@napi-rs/keyring';

const DEVICE_MASTER_KEY_BYTES = 32;
// The binding maps this service/account entry to macOS Keychain, Windows
// Credential Manager, and the Linux system keyring backend without writing a
// key file beside SQLite.
// https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs
const CREDENTIAL_SERVICE = 'Floway One';
const CREDENTIAL_ACCOUNT = 'device-master-key-v1';
const CREATION_LOCK_PATH = join(
  tmpdir(),
  `floway-one-device-master-key-${process.getuid?.() ?? 'current-user'}.lock`,
);
const CREATION_LOCK_RETRY_MS = 25;
const CREATION_LOCK_TIMEOUT_MS = 30_000;

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

export const createOperatingSystemCredential = (
  service = CREDENTIAL_SERVICE,
  account = CREDENTIAL_ACCOUNT,
  platform: NodeJS.Platform = process.platform,
  bindings: KeyringBindings = defaultKeyringBindings,
): DeviceMasterKeyCredential => {
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
  // https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs#L406-L438
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

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
};

const removeStaleCreationLock = (): boolean => {
  let owner: string;
  try {
    owner = readFileSync(CREATION_LOCK_PATH, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new Error('Failed to inspect the Floway One device master key creation lock', { cause });
  }
  if (!/^[1-9]\d*$/u.test(owner)) {
    throw new Error('Floway One device master key creation lock has an invalid owner');
  }
  if (processExists(Number(owner))) return false;
  try {
    unlinkSync(CREATION_LOCK_PATH);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Failed to remove a stale Floway One device master key creation lock', { cause });
    }
  }
  return true;
};

const tryAcquireCreationLock = (): (() => void) | null => {
  let descriptor: number;
  try {
    // `wx` maps to an exclusive create: only one process can own first-key
    // creation at a time. A PID lets a later launch recover a crashed owner.
    // https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags
    descriptor = openSync(CREATION_LOCK_PATH, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      return removeStaleCreationLock() ? tryAcquireCreationLock() : null;
    }
    throw new Error('Failed to acquire the Floway One device master key creation lock', { cause });
  }
  try {
    writeFileSync(descriptor, String(process.pid));
  } finally {
    closeSync(descriptor);
  }
  return () => {
    try {
      unlinkSync(CREATION_LOCK_PATH);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Failed to release the Floway One device master key creation lock', { cause });
      }
    }
  };
};

const withCreationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const deadline = Date.now() + CREATION_LOCK_TIMEOUT_MS;
  let release = tryAcquireCreationLock();
  while (release === null) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Floway One device master key creation');
    }
    await new Promise(resolve => setTimeout(resolve, CREATION_LOCK_RETRY_MS));
    release = tryAcquireCreationLock();
  }
  try {
    const result = await operation();
    release();
    return result;
  } catch (cause) {
    try { release(); } catch { /* preserve the original operation failure */ }
    throw cause;
  }
};

export const loadDeviceMasterKey = async (
  createIfMissing: boolean,
  credential?: DeviceMasterKeyCredential,
  generate: (size: number) => Uint8Array = randomBytes,
): Promise<Uint8Array> => await withCreationLock(async () => {
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
