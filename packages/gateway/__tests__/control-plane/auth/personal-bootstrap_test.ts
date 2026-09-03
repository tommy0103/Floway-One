import { afterEach, expect, test, vi } from 'vitest';

import {
  consumePersonalDashboardBootstrap,
  initPersonalDashboardBootstrap,
} from '../../../src/control-plane/auth/personal-bootstrap.ts';
import { getRepo } from '../../../src/repo/index.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initRuntimeProfile } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const ORIGIN = 'http://127.0.0.1:8788';
const TOKEN = 'ab'.repeat(32);

const initialize = (expiresAt = Date.now() + 60_000): void => {
  initRuntimeProfile('personal');
  initPersonalDashboardBootstrap({
    origin: ORIGIN,
    credential: { token: TOKEN, expiresAt },
  });
};

const exchange = (token = TOKEN, origin: string | null = ORIGIN): Promise<Response> =>
  requestApp('/auth/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
    },
    body: JSON.stringify({ token }),
  });

afterEach(() => {
  initRuntimeProfile('server');
  initPersonalDashboardBootstrap(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('exchanges the personal bootstrap authority once without reaching the access logger', async () => {
  const { repo } = await setupAppTest();
  initialize();
  const accessLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  const response = await exchange();
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('access-control-allow-origin'), ORIGIN);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as { token: string; user: { id: number; isAdmin: boolean } };
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
  expect(await repo.sessions.getByIdAndTouch(body.token)).not.toBeNull();
  expect(accessLog).not.toHaveBeenCalled();

  const replay = await exchange();
  assertEquals(replay.status, 401);
  expect(await replay.text()).not.toContain(TOKEN);
  expect(accessLog).not.toHaveBeenCalled();
});

test('rejects foreign and missing origins without consuming the valid authority', async () => {
  await setupAppTest();
  initialize();

  assertEquals((await exchange(TOKEN, 'https://foreign.example')).status, 403);
  assertEquals((await exchange(TOKEN, null)).status, 403);
  assertEquals((await exchange()).status, 200);
});

test('rejects expired and mismatched authorities without issuing sessions', async () => {
  const { repo } = await setupAppTest();
  const createSession = vi.spyOn(repo.sessions, 'create');
  initialize(Date.now() - 1);

  assertEquals((await exchange()).status, 401);
  expect(createSession).not.toHaveBeenCalled();

  initialize();
  assertEquals((await exchange('cd'.repeat(32))).status, 401);
  expect(createSession).not.toHaveBeenCalled();
  assertEquals((await exchange()).status, 200);
  expect(createSession).toHaveBeenCalledTimes(1);
});

test('consumption is atomic before asynchronous session persistence begins', async () => {
  await setupAppTest();
  initialize();

  expect(consumePersonalDashboardBootstrap(TOKEN, ORIGIN)).toBe(true);
  expect(consumePersonalDashboardBootstrap(TOKEN, ORIGIN)).toBe(false);
});

test('seals a failed exchange while retaining the redacted internal error chain', async () => {
  await setupAppTest();
  initialize();
  const cause = new Error(`inner persistence failure ${TOKEN}`);
  getRepo().sessions.create = () => {
    throw new Error('outer session failure', { cause });
  };
  const diagnostics: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    diagnostics.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  });

  const response = await exchange();
  assertEquals(response.status, 500);
  const raw = await response.text();
  expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
  expect(raw).not.toContain(TOKEN);

  const logged = diagnostics.join('\n');
  expect(logged).toContain('outer session failure');
  expect(logged).toContain('inner persistence failure [bootstrap-token]');
  expect(logged).not.toContain(TOKEN);
  assertEquals((await exchange()).status, 401);
});

test('personal production refuses both reusable ADMIN_KEY and passwordless owner login', async () => {
  const { adminKey } = await setupAppTest();
  initialize();
  vi.stubEnv('NODE_ENV', 'production');

  for (const password of [adminKey, '']) {
    const response = await requestApp('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '', password }),
    });
    assertEquals(response.status, 401);
  }
});
