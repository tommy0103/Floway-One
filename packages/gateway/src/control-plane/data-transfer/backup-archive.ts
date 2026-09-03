import { scryptAsync } from '@noble/hashes/scrypt.js';
import { z } from 'zod';

const ARCHIVE_FORMAT = 'floway-full-backup' as const;
const ARCHIVE_VERSION = 1 as const;

// RFC 7914 scrypt parameters: 32 MiB of working memory at N=2^15, r=8, p=1.
// https://www.rfc-editor.org/rfc/rfc7914#section-7
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAX_MEMORY = 40 * 1024 * 1024;

// AES-GCM's 96-bit IV and 128-bit tag follow NIST SP 800-38D.
// https://csrc.nist.gov/pubs/sp/800/38/d/final
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BITS = 128;
const SALT_BYTES = 16;

const archiveSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(ARCHIVE_VERSION),
  kdf: z.object({
    name: z.literal('scrypt'),
    n: z.literal(SCRYPT_N),
    r: z.literal(SCRYPT_R),
    p: z.literal(SCRYPT_P),
    salt: z.string().min(1),
  }).strict(),
  encryption: z.object({
    name: z.literal('AES-256-GCM'),
    iv: z.string().min(1),
  }).strict(),
  ciphertext: z.string().min(1),
}).strict();

export type EncryptedBackupArchive = z.infer<typeof archiveSchema>;

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

const archiveHeader = (archive: EncryptedBackupArchive) => ({
  format: archive.format,
  version: archive.version,
  kdf: archive.kdf,
  encryption: archive.encryption,
});

const deriveKey = async (password: string, salt: Uint8Array, webCrypto: Crypto): Promise<CryptoKey> => {
  if (password.length === 0) throw new InvalidBackupArchiveError('The backup password must not be empty.');
  const rawKey = await scryptAsync(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
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
  const iv = webCrypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const archive: EncryptedBackupArchive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    kdf: { name: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: bytesToBase64(salt) },
    encryption: { name: 'AES-256-GCM', iv: bytesToBase64(iv) },
    ciphertext: 'pending',
  };
  const key = await deriveKey(password, salt, webCrypto);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  try {
    const ciphertext = await webCrypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(JSON.stringify(archiveHeader(archive))),
      tagLength: AES_GCM_TAG_BITS,
    }, key, plaintext);
    archive.ciphertext = bytesToBase64(new Uint8Array(ciphertext));
    return archive;
  } finally {
    plaintext.fill(0);
  }
};

export const openEncryptedBackupArchive = async (
  rawArchive: unknown,
  password: string,
  webCrypto: Crypto = globalThis.crypto,
): Promise<unknown> => {
  const parsed = archiveSchema.safeParse(rawArchive);
  if (!parsed.success) {
    throw new InvalidBackupArchiveError(`The encrypted backup envelope is invalid: ${parsed.error.issues[0].message}`, parsed.error);
  }
  const archive = parsed.data;
  const salt = base64ToBytes(archive.kdf.salt, SALT_BYTES);
  const iv = base64ToBytes(archive.encryption.iv, AES_GCM_IV_BYTES);
  const ciphertext = base64ToBytes(archive.ciphertext);
  const key = await deriveKey(password, salt, webCrypto);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await webCrypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode(JSON.stringify(archiveHeader(archive))),
      tagLength: AES_GCM_TAG_BITS,
    }, key, ciphertext);
  } catch (cause) {
    throw new BackupArchiveAuthenticationError(cause);
  }

  try {
    return JSON.parse(textDecoder.decode(plaintext));
  } catch (cause) {
    throw new InvalidBackupArchiveError('The decrypted backup payload is not valid UTF-8 JSON.', cause);
  }
};
