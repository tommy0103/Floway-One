import { isPersonalRuntimeProfile, runtimeApiKeyDefaults } from './profile-policy.ts';
import { SEED_ADMIN_USER_ID } from '../repo/seed-admin.ts';
import type { ApiKey, Repo } from '../repo/types.ts';
import { generateApiKeyToken } from '../shared/api-key-tokens.ts';
import { generateServerSecret } from '../shared/server-secret.ts';

// The first local owner gets a usable Gateway key before adding any model
// service. A soft-deleted key still counts as prior setup, so a deliberate
// deletion is not reversed on the next app launch. An interrupted initial
// write remains retryable because the key table stays empty.
export const ensurePersonalInitialKey = async (repo: Pick<Repo, 'apiKeys'>): Promise<void> => {
  if (!isPersonalRuntimeProfile()) throw new Error('Initial local API keys require the personal profile');
  if ((await repo.apiKeys.listIncludingDeleted()).length > 0) return;

  const key: ApiKey = {
    id: crypto.randomUUID(),
    userId: SEED_ADMIN_USER_ID,
    name: 'Default',
    key: generateApiKeyToken(),
    serverSecret: generateServerSecret(),
    createdAt: new Date().toISOString(),
    ...runtimeApiKeyDefaults(),
    deletedAt: null,
  };
  await repo.apiKeys.save(key);
};
