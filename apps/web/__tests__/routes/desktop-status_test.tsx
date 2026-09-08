import { screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: tauri.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import DesktopStatus, { parseDesktopStatus } from '../../src/routes/desktop-status.tsx';
import { renderInApp } from '../render.tsx';

afterEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(false);
  tauri.listen.mockClear();
});

test('defaults to a bounded startup state without requiring the sidecar', () => {
  expect(parseDesktopStatus(new URLSearchParams())).toEqual({
    failureKind: 'unknown',
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
      failureKind: kind,
      failureKey,
      state: 'failed',
    });
  }
});

test('rejects inherited and malformed failure kinds at the URL boundary', () => {
  for (const kind of ['constructor', 'toString', '__proto__', '', 'PORT']) {
    expect(parseDesktopStatus(new URLSearchParams({ kind, state: 'failed' }))).toEqual({
      failureKind: 'unknown',
      failureKey: 'desktop.status.failures.unknown',
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
  expect(screen.getByText((_content, element) =>
    element?.tagName === 'P'
    && element.textContent === 'The configured local port is unavailable. Detailed diagnostics are available in the logs.'))
    .toBeTruthy();
  expect(screen.queryByText(/secret stderr/i)).toBeNull();
  expect(screen.getByRole('link', { name: 'Restart Gateway' }).getAttribute('href')).toBe('floway-action://restart');
  expect(screen.getByRole('link', { name: 'Open logs' }).getAttribute('href')).toBe('floway-action://open-logs');
});

test('reports recovery only after the native IPC state has been reconciled', async () => {
  let resolveStatus: ((status: { readonly kind: string; readonly state: string }) => void) | undefined;
  const currentStatus = new Promise<{ readonly kind: string; readonly state: string }>(resolve => {
    resolveStatus = resolve;
  });
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') return await currentStatus;
    return undefined;
  });
  const router = createMemoryRouter([{
    path: '/desktop-status',
    element: <DesktopStatus />,
  }], {
    initialEntries: ['/desktop-status?state=failed&kind=compatibility'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('desktop_runtime_status'));
  expect(tauri.invoke).not.toHaveBeenCalledWith('report_desktop_rendered_surface', expect.anything());

  resolveStatus?.({ kind: 'compatibility', state: 'failed' });
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_rendered_surface',
    expect.objectContaining({
      surface: expect.objectContaining({ failureKind: 'compatibility' }),
    }),
  ));
});
