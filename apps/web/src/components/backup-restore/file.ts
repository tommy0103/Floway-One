import type { InferResponseType } from 'hono/client';
import { z } from 'zod';

import type { api } from '../../api/client';
import {
  BACKUP_ARCHIVE_VERSION,
  parseEncryptedBackupArchive,
  type EncryptedBackupArchive,
} from '@floway-dev/platform/backup-archive';

// Annotated with the gateway's own literal so a bump there fails this
// assignment instead of silently rejecting every backup the deployment writes.
export const BACKUP_FILE_VERSION = 20 satisfies InferResponseType<typeof api.api.export.$get, 200>['version'];
export const ENCRYPTED_BACKUP_FILE_VERSION = BACKUP_ARCHIVE_VERSION satisfies InferResponseType<typeof api.api.export.$post, 200>['version'];

const backupFileSchema = z.object({
  version: z.literal(BACKUP_FILE_VERSION),
  exportedAt: z.string(),
  data: z.object({
    users: z.array(z.unknown()),
    apiKeys: z.array(z.unknown()),
    upstreams: z.array(z.unknown()),
    modelAliases: z.array(z.unknown()).optional(),
    proxies: z.array(z.unknown()),
    usage: z.array(z.unknown()),
    searchUsage: z.array(z.unknown()),
    performance: z.array(z.unknown()).optional(),
    performanceIncluded: z.boolean(),
    searchConfig: z.unknown(),
  }).strict().superRefine((data, ctx) => {
    if (data.performanceIncluded !== (data.performance !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'performance must be present exactly when performanceIncluded is true',
        path: ['performance'],
      });
    }
  }),
}).strict();

export type BackupFile = z.infer<typeof backupFileSchema>;
export type BackupFileData = BackupFile['data'];

export type BackupFileDiagnosticCode = 'malformed-json' | 'invalid-backup';

export class BackupFileDiagnosticError extends Error {
  readonly clientMessageKey = 'dashboard.backupRestore.import.errorInvalidFile' as const;
  readonly code: BackupFileDiagnosticCode;

  constructor(code: BackupFileDiagnosticCode, cause: unknown) {
    super(code === 'malformed-json'
      ? 'Floway backup file contains malformed JSON'
      : 'Floway backup file failed structural validation', { cause });
    this.name = 'BackupFileDiagnosticError';
    this.code = code;
  }
}

export type ParsedBackupFile =
  | { ok: true; payload: BackupFile }
  | { ok: false; error: BackupFileDiagnosticError };

type ParsedBackupJson =
  | { ok: true; value: unknown }
  | { ok: false; error: BackupFileDiagnosticError };

const parseBackupJson = (raw: string): ParsedBackupJson => {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (cause) {
    return { ok: false, error: new BackupFileDiagnosticError('malformed-json', cause) };
  }
};

export const legacyImportRequest = (payload: BackupFile, mode: 'merge' | 'replace') => ({
  version: BACKUP_FILE_VERSION,
  mode,
  data: payload.data,
} as const);

export const parseBackupFile = (raw: string): ParsedBackupFile => {
  const parsed = parseBackupJson(raw);
  if (!parsed.ok) return parsed;
  const result = backupFileSchema.safeParse(parsed.value);
  return result.success
    ? { ok: true, payload: result.data }
    : { ok: false, error: new BackupFileDiagnosticError('invalid-backup', result.error) };
};

export type EncryptedBackupFile = EncryptedBackupArchive;

export type ParsedEncryptedBackupFile =
  | { ok: true; archive: EncryptedBackupFile }
  | { ok: false; error: BackupFileDiagnosticError };

export const parseEncryptedBackupFile = (raw: string): ParsedEncryptedBackupFile => {
  const parsed = parseBackupJson(raw);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, archive: parseEncryptedBackupArchive(parsed.value) };
  } catch (cause) {
    return { ok: false, error: new BackupFileDiagnosticError('invalid-backup', cause) };
  }
};
