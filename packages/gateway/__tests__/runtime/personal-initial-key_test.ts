import { afterEach, expect, test } from 'vitest';

import { ensurePersonalInitialKey } from '../../src/runtime/personal-initial-key.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { initRuntimeProfile } from '@floway-dev/platform';

afterEach(() => initRuntimeProfile('server'));

test('a fresh personal owner gets one unrestricted API key with private retention disabled', async () => {
  initRuntimeProfile('personal');
  const repo = new InMemoryRepo();

  await ensurePersonalInitialKey(repo);
  await ensurePersonalInitialKey(repo);

  const keys = await repo.apiKeys.listIncludingDeleted();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatchObject({
    userId: 1,
    name: 'Default',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  });
  expect(keys[0]?.key).toMatch(/^sk-[A-Za-z0-9]+$/);
  expect(keys[0]?.serverSecret).toMatch(/^[0-9a-f]{64}$/);
});

test('restarting after the owner deletes every key does not recreate one', async () => {
  initRuntimeProfile('personal');
  const repo = new InMemoryRepo();
  await ensurePersonalInitialKey(repo);
  const [key] = await repo.apiKeys.list();
  await repo.apiKeys.softDelete(key!.id);

  await ensurePersonalInitialKey(repo);

  expect(await repo.apiKeys.list()).toEqual([]);
  expect(await repo.apiKeys.listIncludingDeleted()).toHaveLength(1);
});

test('server profile cannot acquire a personal default key', async () => {
  initRuntimeProfile('server');
  const repo = new InMemoryRepo();

  await expect(ensurePersonalInitialKey(repo)).rejects.toThrow('personal profile');
  expect(await repo.apiKeys.list()).toEqual([]);
});
