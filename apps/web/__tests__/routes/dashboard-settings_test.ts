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
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requests.push(path);
    if (path === '/api/runtime-info') return Response.json({
      kind: 'node',
      profile: {
        capabilities: { desktopIntegration: true, remoteAccess: false, userManagement: false },
        mode: 'personal',
      },
      runtimeLocation: 'LOCAL',
    });
    return Response.json({
      compatibility: {
        contractDigest: 'a'.repeat(64),
        protocolVersion: 1,
        releaseVersion: '0.1.0',
      },
      service: 'floway',
      status: 'ok',
    });
  }));

  await expect(clientLoader()).resolves.toMatchObject({
    desktop: { compatibility: { releaseVersion: '0.1.0' } },
  });
  expect(requests).toEqual(['/api/runtime-info', '/api/desktop/health']);
});

test('preserves the server settings surface when no desktop runtime is present', async () => {
  authenticate();
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requests.push(path);
    return Response.json({
      kind: 'node',
      profile: {
        capabilities: { desktopIntegration: false, remoteAccess: true, userManagement: true },
        mode: 'server',
      },
      runtimeLocation: 'LOCAL',
    });
  }));
  await expect(clientLoader()).resolves.toEqual({ desktop: null });
  expect(requests).toEqual(['/api/runtime-info']);
});
