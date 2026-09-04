import { Hono } from 'hono';

import { type AuthVars } from '../../middleware/auth.ts';
import { zValidator } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { SEED_ADMIN_USER_ID } from '../../repo/seed-admin.ts';
import { personalDashboardBootstrapBody } from '../schemas.ts';
import { loadKnownUpstreamIds } from '../shared/upstream-ids.ts';
import { userToSessionWire } from '../users/wire.ts';
import { getRuntimeProfile, timingSafeEqual } from '@floway-dev/platform';

const NON_CACHEABLE_HEADERS = {
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'expires': '0',
  'referrer-policy': 'no-referrer',
} as const;

interface PersonalDashboardBootstrapCredential {
  readonly expiresAt: number;
  readonly token: string;
}

export interface PersonalDashboardBootstrapConfiguration {
  readonly credential: PersonalDashboardBootstrapCredential | null;
  readonly origin: string;
}

let configuration: PersonalDashboardBootstrapConfiguration | null = null;

const validateOrigin = (origin: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    throw new Error('Personal Dashboard bootstrap origin is invalid', { cause });
  }
  if (parsed.origin !== origin || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('Personal Dashboard bootstrap origin must be an HTTP(S) origin without a path');
  }
};

export const initPersonalDashboardBootstrap = (
  value: PersonalDashboardBootstrapConfiguration | null,
): void => {
  if (value !== null) {
    validateOrigin(value.origin);
    if (value.credential !== null) {
      if (!/^[0-9a-f]{64}$/.test(value.credential.token)) {
        throw new Error('Personal Dashboard bootstrap token must be 64 lowercase hexadecimal characters');
      }
      if (!Number.isFinite(value.credential.expiresAt)) {
        throw new Error('Personal Dashboard bootstrap expiry must be finite');
      }
    }
  }
  configuration = value;
};

export const getPersonalDashboardOrigin = (): string => {
  if (configuration === null) {
    throw new Error('Personal Dashboard bootstrap not initialized');
  }
  return configuration.origin;
};

export const consumePersonalDashboardBootstrap = (
  token: string,
  origin: string,
  now = Date.now(),
): boolean => {
  if (configuration === null) {
    throw new Error('Personal Dashboard bootstrap not initialized');
  }
  const credential = configuration.credential;
  if (credential === null || origin !== configuration.origin) return false;
  if (now >= credential.expiresAt) {
    configuration = { ...configuration, credential: null };
    return false;
  }

  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(token), encoder.encode(credential.token))) return false;
  configuration = { ...configuration, credential: null };
  return true;
};

const redactBootstrapToken = (value: string, token: string): string =>
  value.replaceAll(token, '[bootstrap-token]');

const bootstrapErrorDiagnostics = (error: unknown, token: string): unknown => {
  if (!(error instanceof Error)) return { thrownValueType: typeof error };
  return {
    name: error.name,
    message: redactBootstrapToken(error.message, token),
    stack: error.stack === undefined ? undefined : redactBootstrapToken(error.stack, token),
    cause: bootstrapErrorDiagnostics(error.cause, token),
  };
};

export const personalDashboardBootstrapRoutes = new Hono<{ Variables: AuthVars }>()
  .post('/auth/bootstrap', zValidator('json', personalDashboardBootstrapBody), async c => {
    const { token } = c.req.valid('json');
    try {
      if (getRuntimeProfile().mode !== 'personal') return c.body(null, 404, NON_CACHEABLE_HEADERS);
      const origin = c.req.header('origin');
      if (origin === undefined || !consumePersonalDashboardBootstrap(token, origin)) {
        return c.json({ error: 'Invalid or expired bootstrap authority' }, 401, NON_CACHEABLE_HEADERS);
      }

      const owner = await getRepo().users.getById(SEED_ADMIN_USER_ID);
      if (owner === null) throw new Error('Personal Dashboard bootstrap owner (user 1) is missing');
      const [session, knownUpstreamIds] = await Promise.all([
        getRepo().sessions.create(owner.id),
        loadKnownUpstreamIds(),
      ]);
      return c.json({ token: session.id, user: userToSessionWire(owner, knownUpstreamIds) }, 200, NON_CACHEABLE_HEADERS);
    } catch (error) {
      console.error('Personal Dashboard bootstrap exchange failed', bootstrapErrorDiagnostics(error, token));
      return c.json({ error: { type: 'internal_error' as const } }, 500, NON_CACHEABLE_HEADERS);
    }
  });
