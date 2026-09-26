import { screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

import type { DashboardRuntimeCapabilities } from '../../src/api/runtime-info.ts';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast.tsx';
import { clientLoader, default as DashboardSettings } from '../../src/routes/dashboard-settings.tsx';
import { useAuthStore } from '../../src/stores/auth-store.ts';
import { stubLocalStorage } from '../local-storage-stub.ts';
import { renderInApp } from '../render.tsx';

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

const DESKTOP_STATUS = {
  compatibility: { contractDigest: 'a'.repeat(64), protocolVersion: 1, releaseVersion: '0.1.0' },
  service: 'floway',
  status: 'ok',
} as const;

const renderSettings = (capabilities: DashboardRuntimeCapabilities, personal: boolean) => {
  const user = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };
  const router = createMemoryRouter([{
    path: '/dashboard',
    Component: () => <Outlet context={{ capabilities, personal, user }} />,
    children: [{
      path: 'settings',
      Component: () => <DashboardSettings loaderData={{ desktop: DESKTOP_STATUS }} matches={[] as never} params={{}} />,
    }],
  }], { initialEntries: ['/dashboard/settings'] });
  renderInApp(<OutcomeToastProvider><RouterProvider router={router} /></OutcomeToastProvider>);
};

test('personal settings keeps preferences and runtime facts without account machinery', () => {
  renderSettings({ desktopIntegration: true, remoteAccess: false, userManagement: false }, true);

  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.getByText('Language')).toBeTruthy();
  expect(screen.getByText('Local Gateway')).toBeTruthy();
  expect(screen.getByText('0.1.0')).toBeTruthy();
  // The owner has no password to change, and a page that renders proves the
  // gateway is running — neither belongs on this surface.
  expect(screen.queryByRole('heading', { name: 'Change password' })).toBeNull();
  expect(screen.queryByText('Running')).toBeNull();
  expect(screen.queryByText('Compatibility protocol')).toBeNull();
});

test('server settings keeps the password surface', () => {
  renderSettings({ desktopIntegration: false, remoteAccess: true, userManagement: true }, false);

  expect(screen.getByRole('heading', { name: 'Change password' })).toBeTruthy();
});
