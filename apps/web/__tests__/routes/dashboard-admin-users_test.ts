import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-admin-users';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const runtimeInfo = (userManagement: boolean) => ({
  kind: 'node',
  profile: {
    mode: userManagement ? 'server' : 'personal',
    capabilities: { userManagement, remoteAccess: userManagement, desktopIntegration: !userManagement },
  },
  runtimeLocation: 'LOCAL',
});

describe('Users route runtime capability', () => {
  it('redirects a personal owner before any user resource is requested', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'owner-session',
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    });
    const requestedPaths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      requestedPaths.push(path);
      if (path === '/api/runtime-info') return Response.json(runtimeInfo(false));
      throw new Error(`Personal Users route reached ${path}`);
    }));

    const caught = await clientLoader().then(() => null, (error: unknown) => error);

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(302);
    expect((caught as Response).headers.get('Location')).toBe('/dashboard/services/api-keys');
    expect(requestedPaths).toEqual(['/api/runtime-info']);
  });

  it('retains the complete Users loader in server mode', async () => {
    useAuthStore.getState().primeFromLogin({
      token: 'admin-session',
      user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
    });
    const requestedPaths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      requestedPaths.push(path);
      if (path === '/api/runtime-info') return Response.json(runtimeInfo(true));
      if (path === '/api/users') return Response.json([]);
      if (path === '/api/upstream-options') return Response.json([]);
      if (path === '/api/models') return Response.json({ data: [] });
      throw new Error(`Unexpected request to ${path}`);
    }));

    const data = await clientLoader();

    expect(data).toMatchObject({ users: [], upstreams: [], models: [], error: null });
    expect(requestedPaths).toEqual([
      '/api/runtime-info',
      '/api/users',
      '/api/upstream-options',
      '/api/models',
    ]);
  });
});
