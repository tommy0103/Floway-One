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
const MASTER_KEY_BYTE = 29;
const PROTECTED_SENTINEL = 'personal-entry-encrypted-upstream-secret';
const APP_CONSTRUCTION_BOUNDARY = 'PERSONAL_ENTRY_APP_CONSTRUCTION_REACHED';
const LISTENER_BIND_BOUNDARY = 'PERSONAL_ENTRY_LISTENER_BIND_REACHED';
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

for (const ownerCase of ownerCases) {
  test(`production personal entry handles ${ownerCase.name} before listener construction and binding`, async () => {
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
import { assertRuntimeProfileData } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec } from '@floway-dev/platform';
const paths = JSON.parse(process.env.FLOWAY_TEST_PERSONAL_PATHS);
const codec = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(${MASTER_KEY_BYTE}));
await runNodeEntry({
  resolvePersonalRuntimePaths: () => paths,
  createNodeStoredSecretCodec: () => Promise.resolve(codec),
  assertRuntimeProfileData: async repo => {
    const upstream = await repo.upstreams.getById('up_personal_entry');
    if (upstream?.config?.apiKey !== ${JSON.stringify(PROTECTED_SENTINEL)}) {
      throw new Error('Codec-backed repository was not installed before profile validation');
    }
    await assertRuntimeProfileData();
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
            FLOWAY_TEST_PERSONAL_PATHS: JSON.stringify(paths),
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

      if (ownerCase.expectedError === null) {
        expect(failure).toBeUndefined();
        expect(output).toContain(APP_CONSTRUCTION_BOUNDARY);
        expect(output).toContain(LISTENER_BIND_BOUNDARY);
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(output).toContain(ownerCase.expectedError);
        expect(output).not.toContain(APP_CONSTRUCTION_BOUNDARY);
        expect(output).not.toContain(LISTENER_BIND_BOUNDARY);
      }
      expect(output).not.toContain(PROTECTED_SENTINEL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
