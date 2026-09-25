import { fireEvent, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { DashboardRuntimeCapabilities } from '../../../src/api/runtime-info';
import { Sidebar } from '../../../src/components/sidebar/nav';
import { renderInApp } from '../../render';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauri.invoke(...args),
  isTauri: () => tauri.isTauri,
}));

const user = { id: 1, username: 'admin', isAdmin: true, upstreamIds: null };

const renderSidebar = (capabilities: DashboardRuntimeCapabilities, personal: boolean) => {
  const router = createMemoryRouter([{
    path: '*',
    Component: () => <Sidebar capabilities={capabilities} personal={personal} user={user} />,
  }], { initialEntries: ['/dashboard/playground'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('Sidebar runtime capabilities', () => {
  it('omits Users and exposes a named Settings link in personal mode', () => {
    renderSidebar({ userManagement: false, remoteAccess: false, desktopIntegration: true }, true);

    expect(screen.queryByText('Users')).toBeNull();
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.getByText('Quick Start')).toBeTruthy();
    expect(screen.getByText('Backup / Restore')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/dashboard/settings');
    expect(screen.queryByText('admin')).toBeNull();
  });

  it('retains Users and the signed-in username in server mode', () => {
    renderSidebar({ userManagement: true, remoteAccess: true, desktopIntegration: false }, false);

    expect(screen.getByText('Users')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
    expect(screen.queryByText('Quick Start')).toBeNull();
  });
});

describe('Sidebar footer session actions', () => {
  it('offers sign out in server mode', () => {
    renderSidebar({ userManagement: true, remoteAccess: true, desktopIntegration: false }, false);

    expect(screen.getByText('Sign out')).toBeTruthy();
  });

  it('omits sign out and quit in personal mode in a plain browser', () => {
    tauri.isTauri = false;
    renderSidebar({ userManagement: false, remoteAccess: false, desktopIntegration: true }, true);

    expect(screen.queryByText('Sign out')).toBeNull();
    expect(screen.queryByText('Quit Floway')).toBeNull();
  });

  it('replaces sign out with a confirmed Quit Floway in the desktop app', () => {
    tauri.isTauri = true;
    renderSidebar({ userManagement: false, remoteAccess: false, desktopIntegration: true }, true);

    expect(screen.queryByText('Sign out')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Quit Floway' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/stops the local gateway/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Quit Floway' }));
    expect(tauri.invoke).toHaveBeenCalledWith('quit_app');
    tauri.isTauri = false;
  });
});
