import { formatWithOptions } from 'node:util';

import { expect, test, vi } from 'vitest';

import {
  BackupArchiveAuthenticationError,
  createEncryptedBackupArchive,
  InvalidBackupArchiveError,
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

test('authenticated opening preserves the exact crypto failure code without exposing password or recovery data', async () => {
  const password = 'PASSWORD_NEVER_LOG_21';
  const archive = await createEncryptedBackupArchive(RECOVERY_DATA, password);
  const cryptoFailure = Object.assign(new Error('stable authenticated-decryption failure'), {
    code: 'ERR_CRYPTO_INVALID_AUTH_TAG',
  });
  const subtle = new Proxy(globalThis.crypto.subtle, {
    get(target, property) {
      if (property === 'decrypt') return async () => { throw cryptoFailure; };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const failingCrypto = new Proxy(globalThis.crypto, {
    get(target, property) {
      if (property === 'subtle') return subtle;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  let observed: BackupArchiveAuthenticationError | undefined;
  try {
    await openEncryptedBackupArchive(archive, password, failingCrypto);
  } catch (error) {
    if (error instanceof BackupArchiveAuthenticationError) observed = error;
  }

  expect(observed?.cause).toBe(cryptoFailure);
  expect((observed?.cause as typeof cryptoFailure).code).toBe('ERR_CRYPTO_INVALID_AUTH_TAG');
  const rendered = formatWithOptions({ colors: false, depth: null }, '%o', observed);
  expect(rendered).not.toContain(password);
  expect(rendered).not.toContain('sk-floway-client-secret');
  expect(rendered).not.toContain('provider-secret');
});

test('decrypted JSON failures retain safe parser diagnostics without retaining protected plaintext', async () => {
  const archive = await createEncryptedBackupArchive(RECOVERY_DATA, 'parser-password');
  const sentinel = 'DECRYPTED_JSON_SECRET_21';
  const parserFailure = new SyntaxError(`Unexpected token ${sentinel} at position 4`);
  Object.defineProperty(parserFailure, 'code', { value: 'ERR_BACKUP_JSON_PARSE' });
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw parserFailure; });
  try {
    let observed: InvalidBackupArchiveError | undefined;
    try {
      await openEncryptedBackupArchive(archive, 'parser-password');
    } catch (error) {
      if (error instanceof InvalidBackupArchiveError) observed = error;
    }
    const cause = observed?.cause as SyntaxError & { code?: string };
    expect(cause).toBeInstanceOf(SyntaxError);
    expect(cause.code).toBe('ERR_BACKUP_JSON_PARSE');
    expect(formatWithOptions({ colors: false, depth: null }, '%o', observed)).not.toContain(sentinel);
  } finally {
    parse.mockRestore();
  }
});

test('fatal UTF-8 decoding preserves the exact decoder error after reaching invalid plaintext bytes', async () => {
  const password = 'UTF8_PASSWORD_NEVER_EXPOSE_21';
  const archive = await createEncryptedBackupArchive(RECOVERY_DATA, password);
  const invalidPlaintext = Uint8Array.from([0xff, 0xfe, 0xfd]);
  const subtle = new Proxy(globalThis.crypto.subtle, {
    get(target, property) {
      if (property === 'decrypt') return async () => invalidPlaintext.buffer;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const decryptingCrypto = new Proxy(globalThis.crypto, {
    get(target, property) {
      if (property === 'subtle') return subtle;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
  let reachedBytes: number[] | undefined;
  let decoderFailure: unknown;
  const instrumentedDecoder: Pick<TextDecoder, 'decode'> = {
    decode(input) {
      reachedBytes = [...new Uint8Array(input as ArrayBuffer)];
      try {
        return fatalDecoder.decode(input);
      } catch (cause) {
        decoderFailure = cause;
        throw cause;
      }
    },
  };

  let observed: InvalidBackupArchiveError | undefined;
  try {
    await openEncryptedBackupArchive(archive, password, decryptingCrypto, instrumentedDecoder);
  } catch (error) {
    if (error instanceof InvalidBackupArchiveError) observed = error;
  }

  expect(reachedBytes).toEqual([0xff, 0xfe, 0xfd]);
  expect(decoderFailure).toBeInstanceOf(TypeError);
  expect(observed?.cause).toBe(decoderFailure);
  expect(observed?.message).toBe('The decrypted backup payload is not valid UTF-8.');
  const exposed = JSON.stringify({ error: observed?.message });
  expect(exposed).not.toContain(password);
  expect(exposed).not.toContain(archive.ciphertext);
  expect(exposed).not.toContain('255');
  expect(exposed).not.toContain('UTF8_PASSWORD');
});
