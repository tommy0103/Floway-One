import { expect, test } from 'vitest';

import {
  BackupArchiveAuthenticationError,
  createEncryptedBackupArchive,
  openEncryptedBackupArchive,
} from '../../../src/control-plane/data-transfer/backup-archive.ts';

const RECOVERY_DATA = {
  version: 20,
  data: {
    apiKeys: [{ key: 'sk-floway-client-secret', serverSecret: '11'.repeat(32) }],
    upstreams: [{ config: { apiKey: 'provider-secret' } }],
  },
};

test('a password-protected full backup restores its recovery data without exposing plaintext credentials', async () => {
  const archive = await createEncryptedBackupArchive(RECOVERY_DATA, 'correct horse battery staple');

  expect(JSON.stringify(archive)).not.toContain('sk-floway-client-secret');
  expect(JSON.stringify(archive)).not.toContain('provider-secret');
  await expect(openEncryptedBackupArchive(archive, 'correct horse battery staple')).resolves.toEqual(RECOVERY_DATA);
});

test('a wrong password or modified ciphertext fails authenticated backup opening with the original cause', async () => {
  const archive = await createEncryptedBackupArchive(RECOVERY_DATA, 'right password');
  const tampered = {
    ...archive,
    ciphertext: `${archive.ciphertext.slice(0, -2)}AA`,
  };

  for (const [candidate, password] of [
    [archive, 'wrong password'],
    [tampered, 'right password'],
  ] as const) {
    try {
      await openEncryptedBackupArchive(candidate, password);
      throw new Error('expected authenticated opening to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BackupArchiveAuthenticationError);
      expect((error as BackupArchiveAuthenticationError).cause).toBeInstanceOf(Error);
    }
  }
});
