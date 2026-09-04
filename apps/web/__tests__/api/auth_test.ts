import { afterEach, expect, test, vi } from 'vitest';

import { exchangePersonalDashboardBootstrap } from '../../src/api/auth.ts';
import { flowaySessionHeader, flowayTokenStorageKey } from '../../src/auth/session.ts';

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

test('exchanges desktop bootstrap authority without attaching or invalidating an existing session', async () => {
  const bootstrapToken = '34'.repeat(32);
  const existingSession = 'existing-session';
  window.localStorage.setItem(flowayTokenStorageKey, existingSession);
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return Promise.resolve(Response.json({ error: 'Invalid or expired bootstrap authority' }, { status: 401 }));
  });

  const result = await exchangePersonalDashboardBootstrap({ token: bootstrapToken });

  expect(result.error?.status).toBe(401);
  expect(requestUrl).toBe('/auth/bootstrap');
  expect(new Headers(requestInit?.headers).get(flowaySessionHeader)).toBeNull();
  expect(JSON.parse(String(requestInit?.body))).toEqual({ token: bootstrapToken });
  expect(window.localStorage.getItem(flowayTokenStorageKey)).toBe(existingSession);
});
