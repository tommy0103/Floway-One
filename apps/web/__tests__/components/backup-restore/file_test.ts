import { describe, expect, it, vi } from 'vitest';

import { BACKUP_FILE_VERSION, BackupFileDiagnosticError, legacyImportRequest, parseBackupFile, parseEncryptedBackupFile } from '../../../src/components/backup-restore/file';

const data = {
  users: [],
  apiKeys: [],
  upstreams: [],
  proxies: [],
  usage: [],
  searchUsage: [],
  performanceIncluded: false,
  searchConfig: null,
};

const backup = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  version: BACKUP_FILE_VERSION,
  exportedAt: '2026-07-28T00:00:00.000Z',
  data,
  ...overrides,
});

describe('backup file validation', () => {
  it('accepts the envelope version this deployment writes', () => {
    expect(parseBackupFile(backup()).ok).toBe(true);
  });

  it('rejects a superseded envelope version outright', () => {
    expect(parseBackupFile(backup({ version: BACKUP_FILE_VERSION - 1 })).ok).toBe(false);
  });

  it('rejects unknown fields instead of stripping them', () => {
    expect(parseBackupFile(backup({ typo: true })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, typo: [] } })).ok).toBe(false);
  });

  it('keeps performance presence synchronized with its flag', () => {
    expect(parseBackupFile(backup({ data: { ...data, performance: [] } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true } })).ok).toBe(false);
    expect(parseBackupFile(backup({ data: { ...data, performanceIncluded: true, performance: [] } })).ok).toBe(true);
  });

  it('preserves omitted and explicit-empty model aliases from parsing through the import request', () => {
    const omitted = parseBackupFile(backup());
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    const omittedRequest = legacyImportRequest(omitted.payload, 'replace');
    expect(Object.hasOwn(omitted.payload.data, 'modelAliases')).toBe(false);
    expect(Object.hasOwn(omittedRequest.data, 'modelAliases')).toBe(false);

    const explicit = parseBackupFile(backup({ data: { ...data, modelAliases: [] } }));
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    const explicitRequest = legacyImportRequest(explicit.payload, 'replace');
    expect(Object.hasOwn(explicit.payload.data, 'modelAliases')).toBe(true);
    expect(explicitRequest.data.modelAliases).toEqual([]);
  });

  it('retains a secret-bearing JSON parser cause internally without exposing or logging its excerpt', () => {
    const sentinel = 'BROWSER_BACKUP_PARSE_SECRET_21';
    const parserFailure = new SyntaxError(`Unexpected token near ${sentinel}`);
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw parserFailure; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = parseBackupFile(`{"credential":"${sentinel}",broken}`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(BackupFileDiagnosticError);
      expect(result.error.code).toBe('malformed-json');
      expect(result.error.cause).toBe(parserFailure);
      expect(result.error.clientMessageKey).toBe('dashboard.backupRestore.import.errorInvalidFile');
      expect(result.error.message).not.toContain(sentinel);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
      log.mockRestore();
      parse.mockRestore();
    }
  });
});

describe('encrypted backup file validation', () => {
  const archive = {
    format: 'floway-full-backup',
    version: 1,
    kdf: { name: 'scrypt', n: 32768, r: 8, p: 1, salt: 'c2FsdA==' },
    encryption: { name: 'AES-256-GCM', iv: 'aXYtaXYtaXYtaXYt' },
    ciphertext: 'Y2lwaGVydGV4dA==',
  };

  it('accepts only the authenticated archive envelope and fixed memory-hard KDF parameters', () => {
    expect(parseEncryptedBackupFile(JSON.stringify(archive))).toEqual({ ok: true, archive });
    expect(parseEncryptedBackupFile(JSON.stringify({ ...archive, kdf: { ...archive.kdf, n: 2 } })).ok).toBe(false);
    expect(parseEncryptedBackupFile(JSON.stringify({ ...archive, plaintext: data })).ok).toBe(false);
  });
});
