import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths, type PersonalRuntimePaths } from '../src/personal-runtime.ts';
import {
  CREATE_UPDATE_RECOVERY_POINT_ARGUMENT,
  runNodeEntry,
  type NodeEntryOverrides,
} from '../src/run-node-entry.ts';
import { createNodeStoredSecretCodec } from '../src/stored-secrets.ts';
import {
  createUpdateRecoveryPoint,
  DESKTOP_DATA_ROOT_ENV,
  UPDATE_RECOVERY_POINT_EVENT_PREFIX,
} from '../src/update-recovery-point.ts';
import {
  BackupArchiveAuthenticationError,
  openEncryptedBackupArchive,
} from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec, type StoredSecretContext } from '@floway-dev/platform';

const storedSecretContext = (value: string): StoredSecretContext => value as StoredSecretContext;
const SENTINEL = 'update-recovery-point-sentinel-secret';
const UPSTREAM_ID = 'up_update_recovery_point';

interface InMemoryCredential {
  readonly getSecret: () => Uint8Array | null;
  readonly setSecret: (secret: Uint8Array) => void;
  readonly deleteSecret: () => boolean;
}

const inMemoryCredential = (initial: Uint8Array): InMemoryCredential => {
  let secret: Uint8Array | null = initial;
  return {
    getSecret: () => secret,
    setSecret: value => { secret = value; },
    deleteSecret: () => {
      const had = secret !== null;
      secret = null;
      return had;
    },
  };
};

const temporaryRoots: string[] = [];

const makeTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-update-recovery-point-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  delete process.env[DESKTOP_DATA_ROOT_ENV];
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { force: true, recursive: true });
  }
});

const captureStdout = (): { readonly captured: () => string; readonly restore: () => void } => {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  process.stdout.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    captured: () => buffer,
    restore: () => { process.stdout.write = original; },
  };
};

const seedPersonalData = async (
  paths: PersonalRuntimePaths,
  masterKey: Uint8Array,
): Promise<void> => {
  const db = createNodeSqliteDatabase(paths.databasePath);
  await applyMigrations(db);
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const sealedConfig = await codec.seal(
    JSON.stringify({
      baseUrl: 'https://provider.example',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: SENTINEL,
      endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
      modelsFetch: { enabled: true, endpoint: '/models' },
    }),
    storedSecretContext(`upstream:${UPSTREAM_ID}:config`),
  );
  await db.prepare(
    `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, flag_overrides, hue)
     VALUES (?, 'custom', 'Recovery point proof', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?, NULL, '{}', 120)`,
  ).bind(UPSTREAM_ID, sealedConfig).run();
};

const recoveryPointOverrides = (
  paths: PersonalRuntimePaths,
  credential: InMemoryCredential,
): NodeEntryOverrides => ({
  args: ['--profile=personal', CREATE_UPDATE_RECOVERY_POINT_ARGUMENT],
  createNodeStoredSecretCodec: async (profile, db, creationLock, _credential, options) =>
    await createNodeStoredSecretCodec(profile, db, creationLock, credential, options),
  createUpdateRecoveryPoint: async options =>
    await createUpdateRecoveryPoint({ ...options, deviceMasterKeyCredential: credential }),
  installPersonalLogging: () => ({ restore: () => undefined }),
  resolvePersonalRuntimePaths: () => paths,
});

interface RecoveryPointEvent {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

const runRecoveryPointCreation = async (
  paths: PersonalRuntimePaths,
  credential: InMemoryCredential,
): Promise<{ readonly event: RecoveryPointEvent; readonly output: string }> => {
  const capture = captureStdout();
  let info;
  try {
    info = await runNodeEntry(recoveryPointOverrides(paths, credential));
  } finally {
    capture.restore();
  }
  expect(info.port).toBe(0);
  const output = capture.captured();
  const line = output.split('\n').find(candidate => candidate.startsWith(UPDATE_RECOVERY_POINT_EVENT_PREFIX));
  expect(line, `missing recovery point diagnostic in ${output}`).toBeDefined();
  return {
    event: JSON.parse(line!.slice(UPDATE_RECOVERY_POINT_EVENT_PREFIX.length)) as RecoveryPointEvent,
    output,
  };
};

interface RecoveryPointPayload {
  readonly version: number;
  readonly data: {
    readonly users: Array<{ id: number; username: string }>;
    readonly upstreams: Array<{ id: string; config: { apiKey?: string } }>;
  };
}

const openRecoveryPoint = async (
  event: RecoveryPointEvent,
  masterKey: Uint8Array,
): Promise<RecoveryPointPayload> => {
  const source = await readFile(event.path, 'utf8');
  expect((await stat(event.path)).size).toBe(event.bytes);
  const archive = JSON.parse(source) as unknown;
  return await openEncryptedBackupArchive(archive, Buffer.from(masterKey).toString('hex')) as RecoveryPointPayload;
};

test('the personal runtime creates a device-protected recovery point beside the shell update state', async () => {
  const root = await makeTemporaryRoot();
  const paths = resolvePersonalRuntimePaths({
    dataDir: join(root, 'personal-data'),
    stableUserHome: root,
  });
  const masterKey = randomBytes(32);
  const credential = inMemoryCredential(masterKey);
  await seedPersonalData(paths, masterKey);
  process.env[DESKTOP_DATA_ROOT_ENV] = join(root, 'shell-data');

  const { event } = await runRecoveryPointCreation(paths, credential);

  expect(event.path).toBe(join(root, 'shell-data', 'update', 'recovery-point.json'));
  const payload = await openRecoveryPoint(event, masterKey);
  expect(payload.version).toBe(20);
  expect(payload.data.users.map(user => user.id)).toEqual([1]);
  const upstream = payload.data.upstreams.find(record => record.id === UPSTREAM_ID);
  // The decrypted archive restores the provider credential; the persisted
  // archive bytes must never expose it.
  expect(upstream?.config.apiKey).toBe(SENTINEL);

  const rawArchive = await readFile(event.path, 'utf8');
  expect(rawArchive).not.toContain(SENTINEL);
  await expect(openEncryptedBackupArchive(JSON.parse(rawArchive), 'definitely-wrong-password'))
    .rejects.toBeInstanceOf(BackupArchiveAuthenticationError);

  if (process.platform !== 'win32') {
    expect((await stat(event.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'shell-data', 'update'))).mode & 0o777).toBe(0o700);
  }
  await expect(stat(paths.runtimeStatePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a later update cycle replaces the recovery point atomically with fresh encryption randomness', async () => {
  const root = await makeTemporaryRoot();
  const paths = resolvePersonalRuntimePaths({
    dataDir: join(root, 'personal-data'),
    stableUserHome: root,
  });
  const masterKey = randomBytes(32);
  const credential = inMemoryCredential(masterKey);
  await seedPersonalData(paths, masterKey);

  const first = await runRecoveryPointCreation(paths, credential);
  const second = await runRecoveryPointCreation(paths, credential);

  expect(second.event.path).toBe(first.event.path);
  expect(second.event.sha256).not.toBe(first.event.sha256);
  const payload = await openRecoveryPoint(second.event, masterKey);
  expect(payload.data.upstreams.some(record => record.id === UPSTREAM_ID)).toBe(true);
});

test('the recovery point mode requires the personal runtime profile', async () => {
  const root = await makeTemporaryRoot();
  await expect(runNodeEntry({
    args: ['--profile=server', CREATE_UPDATE_RECOVERY_POINT_ARGUMENT],
    resolvePersonalRuntimePaths: () => resolvePersonalRuntimePaths({
      dataDir: join(root, 'personal-data'),
      stableUserHome: root,
    }),
  })).rejects.toThrow(/personal runtime profile/);
});

test('the recovery point flag is accepted at most once', async () => {
  await expect(runNodeEntry({
    args: ['--profile=personal', CREATE_UPDATE_RECOVERY_POINT_ARGUMENT, CREATE_UPDATE_RECOVERY_POINT_ARGUMENT],
  })).rejects.toThrow(/Usage: Floway/);
});

test('a missing device master key fails the recovery point instead of writing plaintext', async () => {
  const root = await makeTemporaryRoot();
  const paths = resolvePersonalRuntimePaths({
    dataDir: join(root, 'personal-data'),
    stableUserHome: root,
  });
  const masterKey = randomBytes(32);
  const seedingCredential = inMemoryCredential(masterKey);
  await seedPersonalData(paths, masterKey);
  // Simulate a lost credential store: the database carries sealed values but
  // the device master key can no longer be read.
  seedingCredential.deleteSecret();

  await expect(runNodeEntry(recoveryPointOverrides(paths, seedingCredential))).rejects.toThrow(/device master key/);
  await expect(stat(join(paths.dataDir, 'update', 'recovery-point.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
