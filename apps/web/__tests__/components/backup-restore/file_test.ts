import { describe, expect, it } from 'vitest';

import { BACKUP_FILE_VERSION, legacyImportRequest, parseBackupFile, parseEncryptedBackupFile } from '../../../src/components/backup-restore/file';

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
