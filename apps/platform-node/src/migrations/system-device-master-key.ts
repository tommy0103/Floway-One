import type { Credential } from '@napi-rs/keyring';

import type { DeviceMasterKeyCredential } from '../device-master-key.ts';
import { DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY, type DeviceMasterKeyCredentialIdentity } from '../device-master-key-credential-identity.ts';
import { requireNoninteractiveMacOSKeychain } from '../macos-keychain-policy.ts';

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

const loadDefaultKeyringBindings = async (): Promise<KeyringBindings> => {
  const { Entry, findCredentials } = await import('@napi-rs/keyring');
  return { Entry, findCredentials };
};

const encodeLinuxSecret = (secret: Uint8Array): string => Buffer.from(secret).toString('base64');

const decodeLinuxSecret = (stored: string): Uint8Array => {
  const decoded = Buffer.from(stored, 'base64');
  if (decoded.toString('base64') !== stored) {
    throw new Error('Floway device master key in Linux Secret Service is not canonical base64');
  }
  return new Uint8Array(decoded);
};

// The binding maps this service/account entry to macOS Keychain, Windows
// Credential Manager, and the Linux system keyring backend without writing a
// key file beside SQLite.
// https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs
export const createOperatingSystemCredential = async (
  identity: DeviceMasterKeyCredentialIdentity = DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY,
  platform: NodeJS.Platform = process.platform,
  bindings?: KeyringBindings,
): Promise<DeviceMasterKeyCredential> => {
  const requirePolicy = platform === 'darwin'
    ? await requireNoninteractiveMacOSKeychain()
    : () => undefined;
  const resolvedBindings = bindings ?? await loadDefaultKeyringBindings();
  if (platform !== 'linux') {
    requirePolicy();
    const entry = new resolvedBindings.Entry(identity.service, identity.account);
    return {
      getSecret: () => { requirePolicy(); return entry.getSecret(); },
      setSecret: secret => { requirePolicy(); entry.setSecret(secret); },
      deleteSecret: () => { requirePolicy(); return entry.deleteCredential(); },
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
      return resolvedBindings.findCredentials(identity.service);
    } catch (cause) {
      throw new Error('Linux Secret Service is unavailable for the Floway device master key', { cause });
    }
  };
  const readPassword = (): string | null => {
    const matches = listFromSecretService().filter(credential => credential.account === identity.account);
    if (matches.length > 1) {
      throw new Error('Linux Secret Service contains ambiguous Floway device master key entries');
    }
    return matches[0]?.password ?? null;
  };

  listFromSecretService();
  const entry = new resolvedBindings.Entry(identity.service, identity.account);
  return {
    getSecret: () => {
      const password = readPassword();
      return password === null ? null : decodeLinuxSecret(password);
    },
    setSecret: secret => {
      const encoded = encodeLinuxSecret(secret);
      entry.setPassword(encoded);
      if (readPassword() !== encoded) {
        throw new Error('Failed to verify the Floway device master key in Linux Secret Service');
      }
    },
    deleteSecret: () => {
      const deleted = entry.deleteCredential();
      if (readPassword() !== null) {
        throw new Error('Failed to delete the Floway device master key from Linux Secret Service');
      }
      return deleted;
    },
  };
};

