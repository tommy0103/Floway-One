export const BACKUP_ARCHIVE_FORMAT = 'floway-full-backup' as const;
export const BACKUP_ARCHIVE_VERSION = 1 as const;

// RFC 7914 scrypt parameters: 32 MiB of working memory at N=2^15, r=8, p=1.
// https://www.rfc-editor.org/rfc/rfc7914#section-7
export const BACKUP_ARCHIVE_KDF = Object.freeze({
  name: 'scrypt' as const,
  n: 2 ** 15,
  r: 8 as const,
  p: 1 as const,
});

export const BACKUP_ARCHIVE_ENCRYPTION = Object.freeze({
  name: 'AES-256-GCM' as const,
  ivBytes: 12,
  tagBits: 128,
});

export interface EncryptedBackupArchive {
  readonly format: typeof BACKUP_ARCHIVE_FORMAT;
  readonly version: typeof BACKUP_ARCHIVE_VERSION;
  readonly kdf: {
    readonly name: typeof BACKUP_ARCHIVE_KDF.name;
    readonly n: typeof BACKUP_ARCHIVE_KDF.n;
    readonly r: typeof BACKUP_ARCHIVE_KDF.r;
    readonly p: typeof BACKUP_ARCHIVE_KDF.p;
    readonly salt: string;
  };
  readonly encryption: {
    readonly name: typeof BACKUP_ARCHIVE_ENCRYPTION.name;
    readonly iv: string;
  };
  readonly ciphertext: string;
}

export class InvalidBackupArchiveEnvelopeError extends Error {
  constructor(message: string) {
    super(`The encrypted backup envelope is invalid: ${message}`);
    this.name = 'InvalidBackupArchiveEnvelopeError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Record<string, unknown>, expected: readonly string[], field: string): void => {
  if (Object.keys(value).toSorted().join(',') !== [...expected].toSorted().join(',')) {
    throw new InvalidBackupArchiveEnvelopeError(`${field} has unexpected or missing fields`);
  }
};

const assertNonEmptyString: (value: unknown, field: string) => asserts value is string = (value, field) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidBackupArchiveEnvelopeError(`${field} must be a non-empty string`);
  }
};

export const parseEncryptedBackupArchive = (value: unknown): EncryptedBackupArchive => {
  if (!isRecord(value)) throw new InvalidBackupArchiveEnvelopeError('archive must be an object');
  assertExactKeys(value, ['format', 'version', 'kdf', 'encryption', 'ciphertext'], 'archive');
  if (value.format !== BACKUP_ARCHIVE_FORMAT) throw new InvalidBackupArchiveEnvelopeError('format is unsupported');
  if (value.version !== BACKUP_ARCHIVE_VERSION) throw new InvalidBackupArchiveEnvelopeError('version is unsupported');

  if (!isRecord(value.kdf)) throw new InvalidBackupArchiveEnvelopeError('kdf must be an object');
  assertExactKeys(value.kdf, ['name', 'n', 'r', 'p', 'salt'], 'kdf');
  if (
    value.kdf.name !== BACKUP_ARCHIVE_KDF.name
    || value.kdf.n !== BACKUP_ARCHIVE_KDF.n
    || value.kdf.r !== BACKUP_ARCHIVE_KDF.r
    || value.kdf.p !== BACKUP_ARCHIVE_KDF.p
  ) throw new InvalidBackupArchiveEnvelopeError('kdf parameters are unsupported');
  assertNonEmptyString(value.kdf.salt, 'kdf.salt');

  if (!isRecord(value.encryption)) throw new InvalidBackupArchiveEnvelopeError('encryption must be an object');
  assertExactKeys(value.encryption, ['name', 'iv'], 'encryption');
  if (value.encryption.name !== BACKUP_ARCHIVE_ENCRYPTION.name) {
    throw new InvalidBackupArchiveEnvelopeError('encryption algorithm is unsupported');
  }
  assertNonEmptyString(value.encryption.iv, 'encryption.iv');
  assertNonEmptyString(value.ciphertext, 'ciphertext');

  return value as unknown as EncryptedBackupArchive;
};
