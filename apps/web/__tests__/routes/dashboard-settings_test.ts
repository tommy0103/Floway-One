import { afterEach, expect, test, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-settings.tsx';
import { useAuthStore } from '../../src/stores/auth-store.ts';
import { stubLocalStorage } from '../local-storage-stub.ts';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const authenticate = () => {
  useAuthStore.getState().primeFromLogin({
    token: 'owner-session',
    user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
  });
};

test('loads packaged runtime status for the desktop settings surface', async () => {
  authenticate();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    compatibility: {
      contractDigest: 'a'.repeat(64),
      protocolVersion: 1,
      releaseVersion: '0.1.0',
    },
    service: 'floway',
    status: 'ok',
  })));

  await expect(clientLoader()).resolves.toMatchObject({
    desktop: { compatibility: { releaseVersion: '0.1.0' } },
  });
});

test('preserves the server settings surface when no desktop runtime is present', async () => {
  authenticate();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  await expect(clientLoader()).resolves.toEqual({ desktop: null });
});
