import { scryptAsync } from '@noble/hashes/scrypt.js';

import { secretSafeJsonSyntaxError } from '@floway-dev/platform';
import {
  BACKUP_ARCHIVE_ENCRYPTION,
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_ARCHIVE_KDF,
  BACKUP_ARCHIVE_VERSION,
  parseEncryptedBackupArchive,
  type EncryptedBackupArchive,
} from '@floway-dev/platform/backup-archive';

const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAX_MEMORY = 40 * 1024 * 1024;

const SALT_BYTES = 16;

export class BackupArchiveAuthenticationError extends Error {
  constructor(cause: unknown) {
    super('The backup password is incorrect or the archive has been modified.', { cause });
    this.name = 'BackupArchiveAuthenticationError';
  }
}

export class InvalidBackupArchiveError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InvalidBackupArchiveError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
type BackupPayloadDecoder = Pick<TextDecoder, 'decode'>;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string, expectedLength?: number): Uint8Array<ArrayBuffer> => {
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new InvalidBackupArchiveError('The encrypted backup contains invalid base64 data.', cause);
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new InvalidBackupArchiveError(`The encrypted backup field has ${bytes.length} bytes; expected ${expectedLength}.`);
  }
  return bytes;
};

type BackupArchiveHeader = Pick<EncryptedBackupArchive, 'format' | 'version' | 'kdf' | 'encryption'>;

const archiveHeader = (archive: BackupArchiveHeader) => ({
  format: archive.format,
  version: archive.version,
  kdf: archive.kdf,
  encryption: archive.encryption,
});

const deriveKey = async (password: string, salt: Uint8Array, webCrypto: Crypto): Promise<CryptoKey> => {
  if (password.length === 0) throw new InvalidBackupArchiveError('The backup password must not be empty.');
  const rawKey = await scryptAsync(password, salt, {
    N: BACKUP_ARCHIVE_KDF.n,
    r: BACKUP_ARCHIVE_KDF.r,
    p: BACKUP_ARCHIVE_KDF.p,
    dkLen: SCRYPT_KEY_BYTES,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  try {
    return await webCrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    rawKey.fill(0);
  }
};

export const createEncryptedBackupArchive = async (
  payload: unknown,
  password: string,
  webCrypto: Crypto = globalThis.crypto,
): Promise<EncryptedBackupArchive> => {
  const salt = webCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webCrypto.getRandomValues(new Uint8Array(BACKUP_ARCHIVE_ENCRYPTION.ivBytes));
  const header: BackupArchiveHeader = {
    format: BACKUP_ARCHIVE_FORMAT,
    version: BACKUP_ARCHIVE_VERSION,
    kdf: { ...BACKUP_ARCHIVE_KDF, salt: bytesToBase64(salt) },
    encryption: { name: BACKUP_ARCHIVE_ENCRYPTION.name, iv: bytesToBase64(iv) },
  };
  const key = await deriveKey(password, salt, webCrypto);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  try {
    const ciphertext = await webCrypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(JSON.stringify(archiveHeader(header))),
      tagLength: BACKUP_ARCHIVE_ENCRYPTION.tagBits,
    }, key, plaintext);
    return { ...header, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
  } finally {
    plaintext.fill(0);
  }
};

export const openEncryptedBackupArchive = async (
  rawArchive: unknown,
  password: string,
  webCrypto: Crypto = globalThis.crypto,
  decoder: BackupPayloadDecoder = textDecoder,
): Promise<unknown> => {
  let archive: EncryptedBackupArchive;
  try {
    archive = parseEncryptedBackupArchive(rawArchive);
  } catch (cause) {
    throw new InvalidBackupArchiveError(
      cause instanceof Error ? cause.message : 'The encrypted backup envelope is invalid.',
      cause,
    );
  }
  const salt = base64ToBytes(archive.kdf.salt, SALT_BYTES);
  const iv = base64ToBytes(archive.encryption.iv, BACKUP_ARCHIVE_ENCRYPTION.ivBytes);
  const ciphertext = base64ToBytes(archive.ciphertext);
  const key = await deriveKey(password, salt, webCrypto);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await webCrypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(JSON.stringify(archiveHeader(archive))),
      tagLength: BACKUP_ARCHIVE_ENCRYPTION.tagBits,
    }, key, ciphertext);
  } catch (cause) {
    throw new BackupArchiveAuthenticationError(cause);
  }

  let decoded: string;
  try {
    decoded = decoder.decode(plaintext);
  } catch (cause) {
    throw new InvalidBackupArchiveError(
      'The decrypted backup payload is not valid UTF-8.',
      cause,
    );
  }

  try {
    return JSON.parse(decoded);
  } catch (cause) {
    throw new InvalidBackupArchiveError(
      'The decrypted backup payload is not valid JSON.',
      secretSafeJsonSyntaxError(cause, 'Decrypted backup payload contains malformed JSON'),
    );
  }
};
