import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';

import { initPersonalDashboardBootstrap } from '../../src/control-plane/auth/personal-bootstrap.ts';
import { authMiddleware } from '../../src/middleware/auth.ts';
import { personalControlPlaneCors, remainingRoutesCors } from '../../src/middleware/control-plane-cors.ts';
import { setupAppTest } from '../test-utils/app.ts';
import { initRuntimeProfile } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

const ORIGIN = 'http://127.0.0.1:8788';

const testApp = () => new Hono()
  .use('*', personalControlPlaneCors)
  .use('*', remainingRoutesCors)
  .use('*', authMiddleware)
  .all('*', c => c.text('ok'));

afterEach(() => {
  initRuntimeProfile('server');
  initPersonalDashboardBootstrap(null);
});

test('personal control-plane CORS admits only the configured local Dashboard origin', async () => {
  const { adminSession } = await setupAppTest();
  initRuntimeProfile('personal');
  initPersonalDashboardBootstrap({ origin: ORIGIN, credential: null });
  const app = testApp();

  const allowed = await app.request('/api/keys', {
    headers: { origin: ORIGIN, 'x-floway-session': adminSession },
  });
  assertEquals(allowed.status, 200);
  assertEquals(allowed.headers.get('access-control-allow-origin'), ORIGIN);

  const rejected = await app.request('/api/keys', {
    headers: { origin: 'https://foreign.example', 'x-floway-session': adminSession },
  });
  assertEquals(rejected.status, 403);
  assertEquals(rejected.headers.get('access-control-allow-origin'), null);
});

test('personal data-plane requests retain API-key authentication and permissive CORS', async () => {
  const { apiKey } = await setupAppTest();
  initRuntimeProfile('personal');
  initPersonalDashboardBootstrap({ origin: ORIGIN, credential: null });
  const app = testApp();

  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { origin: 'https://tool.example', 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.text(), 'ok');
  assertEquals(response.headers.get('access-control-allow-origin'), '*');
});

test('server control-plane CORS remains permissive', async () => {
  const { adminSession } = await setupAppTest();
  const app = testApp();

  const response = await app.request('/api/keys', {
    headers: { origin: 'https://server-dashboard.example', 'x-floway-session': adminSession },
  });
  assertEquals(response.status, 200);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
});
