import { expect, test } from 'vitest';

import { initRepo } from '../../src/repo/index.ts';
import type { ApiKey, User } from '../../src/repo/types.ts';
import { assertRuntimeProfileData, personalApiKeyOwnerId } from '../../src/runtime/profile-policy.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { initRuntimeProfile } from '@floway-dev/platform';

const EXTRA_USER: User = {
  id: 2,
  username: 'other',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-09-02T00:00:00.000Z',
  deletedAt: null,
};

const EXTRA_USER_KEY: ApiKey = {
  id: 'key-other',
  userId: EXTRA_USER.id,
  name: 'Other key',
  key: 'raw-other',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-09-02T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

const withProfile = async (mode: 'personal' | 'server', run: () => Promise<void>): Promise<void> => {
  initRuntimeProfile(mode);
  try {
    await run();
  } finally {
    initRuntimeProfile('server');
  }
};

test('fresh personal data contains the unrestricted seed owner and satisfies startup validation', () =>
  withProfile('personal', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);

    await expect(assertRuntimeProfileData()).resolves.toBeUndefined();
    expect(await repo.users.listIncludingDeleted()).toEqual([
      expect.objectContaining({ id: 1, isAdmin: true, upstreamIds: null, deletedAt: null }),
    ]);
  }));

test.each([
  {
    name: 'an additional active user',
    arrange: async (repo: InMemoryRepo) => await repo.users.save(EXTRA_USER),
    error: 'expected exactly the seed owner (user 1); found user ids: 1, 2',
  },
  {
    name: 'an additional soft-deleted user',
    arrange: async (repo: InMemoryRepo) => await repo.users.save({ ...EXTRA_USER, deletedAt: '2026-09-02T01:00:00.000Z' }),
    error: 'expected exactly the seed owner (user 1); found user ids: 1, 2',
  },
  {
    name: 'a demoted owner',
    arrange: async (repo: InMemoryRepo) => {
      const owner = await repo.users.getById(1);
      if (!owner) throw new Error('seed owner missing from test repository');
      await repo.users.save({ ...owner, isAdmin: false });
    },
    error: 'the seed owner (user 1) must remain an administrator',
  },
  {
    name: 'an upstream-limited owner',
    arrange: async (repo: InMemoryRepo) => {
      const owner = await repo.users.getById(1);
      if (!owner) throw new Error('seed owner missing from test repository');
      await repo.users.save({ ...owner, upstreamIds: ['upstream-limited'] });
    },
    error: 'the seed owner (user 1) must have unrestricted upstream access',
  },
  {
    name: 'an API key owned by another user',
    arrange: async (repo: InMemoryRepo) => await repo.apiKeys.save(EXTRA_USER_KEY),
    error: 'API key key-other belongs to user 2 instead of the seed owner (user 1)',
  },
])('personal startup rejects $name', ({ arrange, error }) => withProfile('personal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await arrange(repo);

  await expect(assertRuntimeProfileData()).rejects.toThrow(`Personal profile invariant violated: ${error}`);
}));

test('server profile preserves multi-user data and actor-owned API keys', () =>
  withProfile('server', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    await repo.users.save(EXTRA_USER);
    await repo.apiKeys.save(EXTRA_USER_KEY);

    await expect(assertRuntimeProfileData()).resolves.toBeUndefined();
    expect(personalApiKeyOwnerId(EXTRA_USER.id)).toBe(EXTRA_USER.id);
  }));

test('personal API key writes always resolve to the seed owner', () =>
  withProfile('personal', async () => {
    expect(personalApiKeyOwnerId(EXTRA_USER.id)).toBe(1);
  }));
