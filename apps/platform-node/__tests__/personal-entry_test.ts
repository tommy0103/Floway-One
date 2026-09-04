import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { applyMigrations } from '../src/migrate.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { createAes256GcmStoredSecretCodec, type StoredSecretContext } from '@floway-dev/platform';

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_NODE_ENTRY_URL = new URL('../src/run-node-entry.ts', import.meta.url).href;
const PERSONAL_STORAGE_URL = new URL('../src/personal-storage.ts', import.meta.url).href;
const MASTER_KEY_BYTE = 29;
const PROTECTED_SENTINEL = 'personal-entry-encrypted-upstream-secret';
const BOOTSTRAP_TOKEN = '71'.repeat(32);
const APP_CONSTRUCTION_BOUNDARY = 'PERSONAL_ENTRY_APP_CONSTRUCTION_REACHED';
const LISTENER_BIND_BOUNDARY = 'PERSONAL_ENTRY_LISTENER_BIND_REACHED';
const STORAGE_INITIALIZATION_BOUNDARY = 'PERSONAL_ENTRY_STORAGE_INITIALIZED';
const STORAGE_TREE_ACL_BOUNDARY = 'PERSONAL_ENTRY_STORAGE_TREE_ACL_APPLIED';
const STORAGE_ROOT_MKDIR_BOUNDARY = 'PERSONAL_ENTRY_STORAGE_ROOT_MKDIR:';
const STORAGE_ROOT_CHMOD_BOUNDARY = 'PERSONAL_ENTRY_STORAGE_ROOT_CHMOD:';
const MIGRATION_COMPLETE_BOUNDARY = 'PERSONAL_ENTRY_MIGRATION_AND_PROFILE_VALIDATION_COMPLETE';
const DASHBOARD_BOOTSTRAP_BOUNDARY = 'PERSONAL_ENTRY_DASHBOARD_BOOTSTRAP_INITIALIZED';
const WINDOWS_PATH_CHILD_BOUNDARY = 'PERSONAL_ENTRY_WINDOWS_PATH_CHILD_TOKEN_ABSENT';
const WINDOWS_STORAGE_CHILD_BOUNDARY = 'PERSONAL_ENTRY_WINDOWS_STORAGE_CHILD_TOKEN_ABSENT';
const FORCED_MIGRATION_BOUNDARY = 'PERSONAL_ENTRY_FORCED_MIGRATION_REACHED';
const FORCED_MIGRATION_ERROR = 'forced original migration error';
const FORCED_MIGRATION_CAUSE = 'forced original SQLite migration cause';
const storedSecretContext = (value: string): StoredSecretContext => value as StoredSecretContext;

const ownerCases: readonly {
  readonly name: string;
  readonly expectedError: string | null;
  mutateOwner(db: ReturnType<typeof createNodeSqliteDatabase>): Promise<unknown>;
}[] = [
  {
    name: 'zero owners',
    expectedError: 'Personal profile invariant violated: expected exactly the seed owner (user 1); found user ids: (none)',
    mutateOwner: db => db.prepare('DELETE FROM users').run(),
  },
  {
    name: 'one valid owner',
    expectedError: null,
    mutateOwner: () => Promise.resolve(),
  },
  {
    name: 'multiple owners',
    expectedError: 'Personal profile invariant violated: expected exactly the seed owner (user 1); found user ids: 1, 2',
    mutateOwner: db => db.prepare(
      `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(2, 'other', null, 0, null, '2026-09-03T00:00:00.000Z', null).run(),
  },
];

const storageCases = [
  { name: 'Windows ACL', platform: 'win32' },
  { name: 'POSIX modes', platform: 'linux' },
] as const;

const startupCases = ownerCases.flatMap(ownerCase =>
  storageCases.map(storageCase => ({ ownerCase, storageCase })));

for (const { ownerCase, storageCase } of startupCases) {
  test(`production personal entry handles ${ownerCase.name} with ${storageCase.name} before listener construction and binding`, async () => {
    const dir = await mkdtemp(join(APP_ROOT, '.tmp-personal-entry-'));
    try {
      const paths = resolvePersonalRuntimePaths({ dataDir: join(dir, 'personal-data') });
      const db = createNodeSqliteDatabase(paths.databasePath);
      await applyMigrations(db);
      await ownerCase.mutateOwner(db);
      const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(MASTER_KEY_BYTE));
      const upstreamId = 'up_personal_entry';
      const configJson = await codec.seal(
        JSON.stringify({ baseUrl: 'https://provider.example', authStyle: 'bearer', apiKey: PROTECTED_SENTINEL }),
        storedSecretContext(`upstream:${upstreamId}:config`),
      );
      await db.prepare(
        `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, flag_overrides, hue)
         VALUES (?, 'custom', 'Encrypted startup proof', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', ?, NULL, '{}', 210)`,
      ).bind(upstreamId, configJson).run();
      expect(Buffer.from(await readFile(paths.databasePath)).includes(Buffer.from(PROTECTED_SENTINEL))).toBe(false);

      const entry = join(dir, 'personal-entry-verification.mts');
      await writeFile(entry, `
import { runNodeEntry } from ${JSON.stringify(RUN_NODE_ENTRY_URL)};
import { initializePersonalStorage } from ${JSON.stringify(PERSONAL_STORAGE_URL)};
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { assertRuntimeProfileData } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec } from '@floway-dev/platform';
const paths = JSON.parse(process.env.FLOWAY_TEST_PERSONAL_PATHS);
const storagePlatform = process.env.FLOWAY_TEST_STORAGE_PLATFORM;
if (storagePlatform !== 'win32' && storagePlatform !== 'linux') throw new Error('Missing storage platform');
const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(${MASTER_KEY_BYTE}));
const assertBootstrapAbsentFromChild = boundary => {
  const inherited = execFileSync(process.execPath, [
    '-e',
    "process.stdout.write(process.env.FLOWAY_BOOTSTRAP_TOKEN ?? '')",
  ], { encoding: 'utf8' });
  if (inherited !== '') throw new Error(boundary + ' inherited the personal Dashboard bootstrap token');
  console.log(boundary);
};
await runNodeEntry({
  initPersonalDashboardBootstrap: configuration => {
    if (configuration?.origin !== 'http://127.0.0.1:8788') throw new Error('Unexpected personal Dashboard origin');
    if (configuration.credential?.token !== ${JSON.stringify(BOOTSTRAP_TOKEN)}) throw new Error('Bootstrap authority was not installed');
    if (process.env.FLOWAY_BOOTSTRAP_TOKEN !== undefined) throw new Error('Bootstrap authority remained in the process environment');
    console.log(${JSON.stringify(DASHBOARD_BOOTSTRAP_BOUNDARY)});
  },
  initializePersonalStorage: paths => {
    if (storagePlatform === 'win32') assertBootstrapAbsentFromChild(${JSON.stringify(WINDOWS_STORAGE_CHILD_BOUNDARY)});
    console.log(${JSON.stringify(STORAGE_INITIALIZATION_BOUNDARY)});
    const roots = new Set([paths.dataDir, paths.filesDir, paths.logsDir]);
    return initializePersonalStorage(paths, storagePlatform === 'win32'
      ? {
          platform: 'win32',
          applyWindowsAcl: (_path, kind) => {
            if (kind === 'tree') console.log(${JSON.stringify(STORAGE_TREE_ACL_BOUNDARY)});
          },
        }
      : {
          platform: 'linux',
          posixUid: userInfo().uid,
          fileSystem: {
            createDirectory: path => {
              if (roots.has(path)) console.log(${JSON.stringify(STORAGE_ROOT_MKDIR_BOUNDARY)} + path);
              mkdirSync(path, { recursive: true, mode: 0o700 });
            },
            setMode: (path, mode) => {
              if (roots.has(path)) console.log(${JSON.stringify(STORAGE_ROOT_CHMOD_BOUNDARY)} + path);
              chmodSync(path, mode);
            },
          },
        });
  },
  resolvePersonalRuntimePaths: () => {
    if (storagePlatform === 'win32') assertBootstrapAbsentFromChild(${JSON.stringify(WINDOWS_PATH_CHILD_BOUNDARY)});
    return paths;
  },
  createNodeStoredSecretCodec: () => Promise.resolve(codec),
  assertRuntimeProfileData: async repo => {
    const upstream = await repo.upstreams.getById('up_personal_entry');
    if (upstream?.config?.apiKey !== ${JSON.stringify(PROTECTED_SENTINEL)}) {
      throw new Error('Codec-backed repository was not installed before profile validation');
    }
    await assertRuntimeProfileData();
    console.log(${JSON.stringify(MIGRATION_COMPLETE_BOUNDARY)});
  },
  createLocalApp: () => {
    console.log(${JSON.stringify(APP_CONSTRUCTION_BOUNDARY)});
    return { fetch: () => Promise.resolve(new Response('listener instrument')) };
  },
  serve: async () => {
    console.log(${JSON.stringify(LISTENER_BIND_BOUNDARY)});
    return { port: 8788 };
  },
});
`);

      let failure: unknown;
      let stdout = '';
      let stderr = '';
      try {
        const result = await execFileAsync(process.execPath, ['--import', 'tsx', entry], {
          cwd: APP_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            ADMIN_KEY: 'personal-entry-test',
            FLOWAY_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
            FLOWAY_TEST_PERSONAL_PATHS: JSON.stringify(paths),
            FLOWAY_TEST_STORAGE_PLATFORM: storageCase.platform,
            FLOWAY_PROFILE: 'personal',
            NODE_ENV: 'production',
            PORT: '8788',
          },
          timeout: 10_000,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        failure = error;
        stdout = String((error as { stdout?: string }).stdout ?? '');
        stderr = String((error as { stderr?: string }).stderr ?? '');
      }
      const output = stdout + stderr;

      expect(output.match(new RegExp(STORAGE_INITIALIZATION_BOUNDARY, 'g'))).toHaveLength(1);
      expect(output.match(new RegExp(DASHBOARD_BOOTSTRAP_BOUNDARY, 'g')) ?? []).toHaveLength(
        ownerCase.expectedError === null ? 1 : 0,
      );
      expect(output).not.toContain(BOOTSTRAP_TOKEN);
      expect(output.match(new RegExp(STORAGE_TREE_ACL_BOUNDARY, 'g')) ?? []).toHaveLength(
        storageCase.platform === 'win32' ? 1 : 0,
      );
      const outputLines = output.split(/\r?\n/u);
      for (const marker of [WINDOWS_PATH_CHILD_BOUNDARY, WINDOWS_STORAGE_CHILD_BOUNDARY]) {
        expect(outputLines.filter(line => line === marker)).toHaveLength(storageCase.platform === 'win32' ? 1 : 0);
      }
      for (const root of [paths.dataDir, paths.filesDir, paths.logsDir]) {
        expect(outputLines.filter(line => line === STORAGE_ROOT_MKDIR_BOUNDARY + root)).toHaveLength(
          storageCase.platform === 'linux' ? 1 : 0,
        );
        expect(outputLines.filter(line => line === STORAGE_ROOT_CHMOD_BOUNDARY + root)).toHaveLength(
          storageCase.platform === 'linux' ? 1 : 0,
        );
      }

      if (ownerCase.expectedError === null) {
        expect(failure).toBeUndefined();
        let previousPhase = -1;
        for (const marker of [
          MIGRATION_COMPLETE_BOUNDARY,
          DASHBOARD_BOOTSTRAP_BOUNDARY,
          APP_CONSTRUCTION_BOUNDARY,
          LISTENER_BIND_BOUNDARY,
        ]) {
          const phase = outputLines.indexOf(marker);
          expect(phase, `${marker} was not observed`).toBeGreaterThan(previousPhase);
          previousPhase = phase;
        }
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(output).toContain(ownerCase.expectedError);
        expect(output).not.toContain(MIGRATION_COMPLETE_BOUNDARY);
        expect(output).not.toContain(APP_CONSTRUCTION_BOUNDARY);
        expect(output).not.toContain(LISTENER_BIND_BOUNDARY);
      }
      expect(output).not.toContain(PROTECTED_SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('a migration failure preserves its cause and prevents bootstrap activation, app construction, and listener binding', async () => {
  const dir = await mkdtemp(join(APP_ROOT, '.tmp-personal-entry-migration-failure-'));
  try {
    const paths = resolvePersonalRuntimePaths({ dataDir: join(dir, 'personal-data') });
    const entry = join(dir, 'personal-entry-migration-failure.mts');
    await writeFile(entry, `
import { runNodeEntry } from ${JSON.stringify(RUN_NODE_ENTRY_URL)};
const paths = JSON.parse(process.env.FLOWAY_TEST_PERSONAL_PATHS);
await runNodeEntry({
  applyMigrations: async () => {
    console.log(${JSON.stringify(FORCED_MIGRATION_BOUNDARY)});
    throw new Error(${JSON.stringify(FORCED_MIGRATION_ERROR)}, {
      cause: new Error(${JSON.stringify(FORCED_MIGRATION_CAUSE)}),
    });
  },
  resolvePersonalRuntimePaths: () => paths,
  initPersonalDashboardBootstrap: () => console.log(${JSON.stringify(DASHBOARD_BOOTSTRAP_BOUNDARY)}),
  createLocalApp: () => {
    console.log(${JSON.stringify(APP_CONSTRUCTION_BOUNDARY)});
    return { fetch: () => Promise.resolve(new Response('listener instrument')) };
  },
  serve: async () => {
    console.log(${JSON.stringify(LISTENER_BIND_BOUNDARY)});
    return { port: 8788 };
  },
});
`);

    let failure: unknown;
    let output = '';
    try {
      const result = await execFileAsync(process.execPath, ['--import', 'tsx', entry], {
        cwd: APP_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          FLOWAY_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
          FLOWAY_PROFILE: 'personal',
          FLOWAY_TEST_PERSONAL_PATHS: JSON.stringify(paths),
          NODE_ENV: 'production',
        },
        timeout: 10_000,
      });
      output = result.stdout + result.stderr;
    } catch (error) {
      failure = error;
      output = String((error as { stdout?: string }).stdout ?? '')
        + String((error as { stderr?: string }).stderr ?? '');
    }

    expect(failure).toBeInstanceOf(Error);
    expect(output).toContain(FORCED_MIGRATION_BOUNDARY);
    expect(output).toContain(FORCED_MIGRATION_ERROR);
    expect(output).toContain(FORCED_MIGRATION_CAUSE);
    expect(output).not.toContain(DASHBOARD_BOOTSTRAP_BOUNDARY);
    expect(output).not.toContain(APP_CONSTRUCTION_BOUNDARY);
    expect(output).not.toContain(LISTENER_BIND_BOUNDARY);
    expect(output).not.toContain(BOOTSTRAP_TOKEN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
