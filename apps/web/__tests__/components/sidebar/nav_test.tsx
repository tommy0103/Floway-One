import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { DashboardRuntimeCapabilities } from '../../../src/api/runtime-info';
import { Sidebar } from '../../../src/components/sidebar/nav';
import { renderInApp } from '../../render';

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
