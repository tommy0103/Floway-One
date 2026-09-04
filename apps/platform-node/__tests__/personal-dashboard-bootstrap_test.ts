import { expect, test } from 'vitest';

import {
  PERSONAL_DASHBOARD_BOOTSTRAP_ENV,
  PERSONAL_DASHBOARD_BOOTSTRAP_TTL_MS,
  preparePersonalDashboardBootstrap,
  takePersonalDashboardBootstrapToken,
} from '../src/personal-dashboard-bootstrap.ts';
import { assertEquals } from '@floway-dev/test-utils';

const ORIGIN = 'http://127.0.0.1:8788';
const TOKEN = '12'.repeat(32);

test('takes bootstrap authority out of the inherited process environment exactly once', () => {
  const env = { [PERSONAL_DASHBOARD_BOOTSTRAP_ENV]: TOKEN };

  assertEquals(takePersonalDashboardBootstrapToken(env), TOKEN);
  expect(env).not.toHaveProperty(PERSONAL_DASHBOARD_BOOTSTRAP_ENV);
  assertEquals(takePersonalDashboardBootstrapToken(env), undefined);
});

test('resolves a bounded in-memory authority for the active local Dashboard origin', () => {
  const now = 123_000;
  expect(preparePersonalDashboardBootstrap({
    origin: ORIGIN,
    production: true,
    token: TOKEN,
  }).activate(now)).toEqual({
    origin: ORIGIN,
    credential: {
      token: TOKEN,
      expiresAt: now + PERSONAL_DASHBOARD_BOOTSTRAP_TTL_MS,
    },
  });
});

test('requires well-formed desktop authority in personal production without echoing it', () => {
  expect(() => preparePersonalDashboardBootstrap({
    origin: ORIGIN,
    production: true,
    token: undefined,
  })).toThrow(`Personal production startup requires ${PERSONAL_DASHBOARD_BOOTSTRAP_ENV}`);

  const malformed = `sensitive-${TOKEN}`;
  let error: unknown;
  try {
    preparePersonalDashboardBootstrap({
      origin: ORIGIN,
      production: true,
      token: malformed,
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('must be 64 lowercase hexadecimal characters');
  expect(String(error)).not.toContain(malformed);
});

test('keeps personal development usable without manufacturing bootstrap authority', () => {
  expect(preparePersonalDashboardBootstrap({
    origin: ORIGIN,
    production: false,
    token: undefined,
  }).activate()).toEqual({ origin: ORIGIN, credential: null });
});
