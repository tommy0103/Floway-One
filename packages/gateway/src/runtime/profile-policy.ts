import { getRepo } from '../repo/index.ts';
import { SEED_ADMIN_USER_ID } from '../repo/seed-admin.ts';
import type { ApiKey, User } from '../repo/types.ts';
import { getRuntimeProfile, type RuntimeProfileMode } from '@floway-dev/platform';

export const PERSONAL_USER_MANAGEMENT_ERROR = 'User management is unavailable in the personal profile.';
export const PERSONAL_OWNER_ADMIN_ERROR = 'The personal profile owner must remain an administrator.';
export const PERSONAL_OWNER_UPSTREAMS_ERROR = 'The personal profile owner must have unrestricted upstream access.';

export type RuntimeApiKeyDefaults = Readonly<Pick<
  ApiKey,
  'upstreamIds' | 'dumpRetentionSeconds' | 'openaiResponsesRetentionSeconds'
>>;

// Keep creation defaults at the profile-policy boundary instead of relying on
// optional request fields to imply them. Personal mode's privacy contract is
// explicit here: all upstreams are inherited, request capture is off, and
// durable Stateful OpenAI Responses storage is off. Server mode deliberately
// retains the same existing defaults.
const RUNTIME_API_KEY_DEFAULTS = Object.freeze({
  personal: Object.freeze({
    upstreamIds: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  }),
  server: Object.freeze({
    upstreamIds: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  }),
}) satisfies Readonly<Record<RuntimeProfileMode, RuntimeApiKeyDefaults>>;

export const isPersonalRuntimeProfile = (): boolean => getRuntimeProfile().mode === 'personal';

export const runtimeApiKeyDefaults = (): RuntimeApiKeyDefaults =>
  RUNTIME_API_KEY_DEFAULTS[getRuntimeProfile().mode];

export const personalUserCreationError = (): string | null =>
  isPersonalRuntimeProfile() ? PERSONAL_USER_MANAGEMENT_ERROR : null;

export const personalUserDeletionError = (): string | null =>
  isPersonalRuntimeProfile() ? PERSONAL_USER_MANAGEMENT_ERROR : null;

export const personalUserUpdateError = (
  userId: number,
  patch: { isAdmin?: boolean; upstreamIds?: readonly string[] | null },
): string | null => {
  if (!isPersonalRuntimeProfile()) return null;
  if (userId !== SEED_ADMIN_USER_ID) return PERSONAL_USER_MANAGEMENT_ERROR;
  if (patch.isAdmin === false) return PERSONAL_OWNER_ADMIN_ERROR;
  if (patch.upstreamIds !== undefined && patch.upstreamIds !== null) return PERSONAL_OWNER_UPSTREAMS_ERROR;
  return null;
};

export const personalApiKeyOwnerId = (actorUserId: number): number =>
  isPersonalRuntimeProfile() ? SEED_ADMIN_USER_ID : actorUserId;

export const runtimeProfileDataError = (
  users: readonly User[],
  apiKeys: readonly ApiKey[],
): string | null => {
  if (!isPersonalRuntimeProfile()) return null;

  if (users.length !== 1 || users[0]?.id !== SEED_ADMIN_USER_ID) {
    const ids = users.length === 0 ? '(none)' : users.map(user => user.id).join(', ');
    return `expected exactly the seed owner (user 1); found user ids: ${ids}`;
  }

  const [owner] = users;
  if (owner.deletedAt !== null) return 'the seed owner (user 1) must remain active';
  if (!owner.isAdmin) return 'the seed owner (user 1) must remain an administrator';
  if (owner.upstreamIds !== null) return 'the seed owner (user 1) must have unrestricted upstream access';

  const foreignKey = apiKeys.find(key => key.userId !== SEED_ADMIN_USER_ID);
  if (foreignKey) {
    return `API key ${foreignKey.id} belongs to user ${foreignKey.userId} instead of the seed owner (user 1)`;
  }
  return null;
};

export const assertRuntimeProfileData = async (): Promise<void> => {
  if (!isPersonalRuntimeProfile()) return;
  const repo = getRepo();
  const [users, apiKeys] = await Promise.all([
    repo.users.listIncludingDeleted(),
    repo.apiKeys.listIncludingDeleted(),
  ]);
  const error = runtimeProfileDataError(users, apiKeys);
  if (error) throw new Error(`Personal profile invariant violated: ${error}`);
};
