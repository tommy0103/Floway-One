import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, test } from 'vitest';

import DesktopStatus, { parseDesktopStatus } from '../../src/routes/desktop-status.tsx';
import { renderInApp } from '../render.tsx';

test('defaults to a bounded startup state without requiring the sidecar', () => {
  expect(parseDesktopStatus(new URLSearchParams())).toEqual({
    failureKey: 'desktop.status.failures.unknown',
    state: 'starting',
  });
});

test('maps every shell failure code to typed localized recovery copy', () => {
  for (const [kind, failureKey] of [
    ['asset', 'desktop.status.failures.asset'],
    ['compatibility', 'desktop.status.failures.compatibility'],
    ['migration', 'desktop.status.failures.migration'],
    ['native-dependency', 'desktop.status.failures.nativeDependency'],
    ['port', 'desktop.status.failures.port'],
    ['storage', 'desktop.status.failures.storage'],
    ['timeout', 'desktop.status.failures.timeout'],
    ['unexpected-exit', 'desktop.status.failures.unexpectedExit'],
  ] as const) {
    expect(parseDesktopStatus(new URLSearchParams({
      detail: 'outer context\n\ncaused by: original cause',
      kind,
      state: 'failed',
    }))).toEqual({
      failureKey,
      state: 'failed',
    });
  }
});

test('renders typed recovery information without echoing arbitrary URL detail', () => {
  const router = createMemoryRouter([{
    path: '/desktop-status',
    element: <DesktopStatus />,
  }], {
    initialEntries: ['/desktop-status?state=failed&kind=port&detail=secret%20stderr%20must%20not%20render'],
  });
  renderInApp(<RouterProvider router={router} />);

  expect(screen.getByRole('heading', { name: 'Floway could not start the local Gateway' })).toBeTruthy();
  expect(screen.getByText(/The configured local port is unavailable.*Detailed diagnostics are available in the logs/).textContent)
    .toBe('The configured local port is unavailable. Detailed diagnostics are available in the logs.');
  expect(screen.queryByText(/secret stderr/i)).toBeNull();
  expect(screen.getByRole('link', { name: 'Restart Gateway' }).getAttribute('href')).toBe('floway-action://restart');
  expect(screen.getByRole('link', { name: 'Open logs' }).getAttribute('href')).toBe('floway-action://open-logs');
});
