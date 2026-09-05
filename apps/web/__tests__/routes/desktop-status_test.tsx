import { screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, test } from 'vitest';

import DesktopStatus, { parseDesktopStatus } from '../../src/routes/desktop-status.tsx';
import { renderInApp } from '../render.tsx';

test('defaults to a bounded startup state without requiring the sidecar', () => {
  expect(parseDesktopStatus(new URLSearchParams())).toEqual({
    detail: null,
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
      detail: 'outer context\n\ncaused by: original cause',
      failureKey,
      state: 'failed',
    });
  }
});

test('renders a readable failure chain with restart and log recovery actions', () => {
  const router = createMemoryRouter([{
    path: '/desktop-status',
    element: <DesktopStatus />,
  }], {
    initialEntries: ['/desktop-status?state=failed&kind=port&detail=listen%20failed%0Acaused%20by%3A%20EADDRINUSE'],
  });
  renderInApp(<RouterProvider router={router} />);

  expect(screen.getByRole('heading', { name: 'Floway could not start the local Gateway' })).toBeTruthy();
  expect(screen.getByText('The configured local port is unavailable.')).toBeTruthy();
  expect(screen.getByText(/EADDRINUSE/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Restart Gateway' }).getAttribute('href')).toBe('floway-action://restart');
  expect(screen.getByRole('link', { name: 'Open logs' }).getAttribute('href')).toBe('floway-action://open-logs');
});
