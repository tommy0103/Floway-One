import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { prepareNodePlatform } from '../src/run-node-entry.ts';
import { SqlRepo } from '@floway-dev/gateway';
import { createAes256GcmStoredSecretCodec, initRuntimeProfile } from '@floway-dev/platform';

afterEach(() => initRuntimeProfile('server'));

test('personal startup provisions one unrestricted key and respects later deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-initial-key-'));
  try {
    const db = createNodeSqliteDatabase(join(directory, 'floway.db'));
    const storedSecrets = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(19));
    const overrides = { createNodeStoredSecretCodec: async () => storedSecrets };
    initRuntimeProfile('personal');

    await prepareNodePlatform({ db }, 'personal', overrides);
    const repo = new SqlRepo(db, { storedSecrets });
    const [initial] = await repo.apiKeys.list();
    expect(initial).toMatchObject({ userId: 1, upstreamIds: null, deletedAt: null });

    await prepareNodePlatform({ db }, 'personal', overrides);
    expect(await repo.apiKeys.list()).toHaveLength(1);

    await repo.apiKeys.softDelete(initial!.id);
    await prepareNodePlatform({ db }, 'personal', overrides);
    expect(await repo.apiKeys.list()).toEqual([]);
    expect(await repo.apiKeys.listIncludingDeleted()).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
