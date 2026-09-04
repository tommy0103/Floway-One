import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { getSessionToken, personalDashboardBootstrapFragmentKey } from '../../src/auth/session.ts';
import { clientLoader } from '../../src/routes/home.tsx';
import { useAuthStore } from '../../src/stores/auth-store.ts';

const BOOTSTRAP_TOKEN = '56'.repeat(32);
const SESSION_TOKEN = 'owner-session';

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.getState().clear();
  window.history.replaceState(null, '', `/#${personalDashboardBootstrapFragmentKey}=${BOOTSTRAP_TOKEN}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('clears the fragment before exchanging it and primes the normal owner session', async () => {
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    expect(window.location.hash).toBe('');
    expect(JSON.parse(String(init?.body))).toEqual({ token: BOOTSTRAP_TOKEN });
    return Promise.resolve(Response.json({
      token: SESSION_TOKEN,
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    }));
  }));

  let redirectResponse: unknown;
  try {
    await clientLoader();
  } catch (error) {
    redirectResponse = error;
  }

  expect(redirectResponse).toBeInstanceOf(Response);
  expect((redirectResponse as Response).status).toBe(302);
  expect((redirectResponse as Response).headers.get('location')).toBe('/dashboard/playground');
  expect(getSessionToken()).toBe(SESSION_TOKEN);
  expect(useAuthStore.getState().session?.user.id).toBe(1);
  expect(window.location.href).not.toContain(BOOTSTRAP_TOKEN);
});
