import { expect, test } from 'vitest';

import {
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_ARCHIVE_KDF,
  BACKUP_ARCHIVE_VERSION,
  InvalidBackupArchiveEnvelopeError,
  parseEncryptedBackupArchive,
} from '../src/backup-archive.ts';

const ARCHIVE = {
  format: 'floway-full-backup',
  version: 1,
  kdf: { name: 'scrypt', n: 32768, r: 8, p: 1, salt: 'c2FsdA==' },
  encryption: { name: 'AES-256-GCM', iv: 'aXYtaXYtaXYtaXYt' },
  ciphertext: 'Y2lwaGVydGV4dA==',
} as const;

test('the shared backup archive contract accepts the one supported envelope', () => {
  expect(BACKUP_ARCHIVE_FORMAT).toBe('floway-full-backup');
  expect(BACKUP_ARCHIVE_VERSION).toBe(1);
  expect(BACKUP_ARCHIVE_KDF).toEqual({ name: 'scrypt', n: 32768, r: 8, p: 1 });
  expect(parseEncryptedBackupArchive(ARCHIVE)).toEqual(ARCHIVE);
});

test('the shared backup archive contract rejects altered work factors and unknown fields', () => {
  expect(() => parseEncryptedBackupArchive({
    ...ARCHIVE,
    kdf: { ...ARCHIVE.kdf, n: 2 },
  })).toThrow(InvalidBackupArchiveEnvelopeError);
  expect(() => parseEncryptedBackupArchive({ ...ARCHIVE, plaintext: { key: 'must-not-fit' } }))
    .toThrow(InvalidBackupArchiveEnvelopeError);
});
