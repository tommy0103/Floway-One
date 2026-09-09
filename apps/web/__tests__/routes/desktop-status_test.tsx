import { act, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  listen: vi.fn(async (
    _event: string,
    _listener: (event: { readonly payload: { readonly kind?: unknown; readonly restartEnabled?: unknown; readonly state?: unknown } }) => void,
  ) => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: tauri.isTauri,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { setLanguage } from '../../src/i18n';
import DesktopStatus, { parseDesktopStatus } from '../../src/routes/desktop-status.tsx';
import { renderInApp } from '../render.tsx';

afterEach(async () => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(false);
  tauri.listen.mockClear();
  await act(async () => { await setLanguage('en'); });
});

test('defaults to a bounded startup state without requiring the sidecar', () => {
  expect(parseDesktopStatus(new URLSearchParams())).toEqual({
    failureKind: 'unknown',
    failureKey: 'desktop.status.failures.unknown',
    restartEnabled: false,
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
      restartEnabled: false,
      state: 'failed',
    });
  }
});

test('rejects inherited and malformed failure kinds at the URL boundary', () => {
  for (const kind of ['constructor', 'toString', '__proto__', '', 'PORT']) {
    expect(parseDesktopStatus(new URLSearchParams({ kind, state: 'failed' }))).toEqual({
      failureKind: 'unknown',
      failureKey: 'desktop.status.failures.unknown',
      restartEnabled: false,
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
  const restart = screen.getByRole('button', { name: 'Restart Gateway' });
  expect(restart.getAttribute('aria-disabled')).toBe('true');
  expect(restart.getAttribute('href')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open logs' }).getAttribute('href')).toBe('floway-action://open-logs');
});

test('renders the exact Simplified Chinese recovery copy and actions', async () => {
  await act(async () => { await setLanguage('zh-Hans'); });
  const router = createMemoryRouter([{
    path: '/desktop-status',
    element: <DesktopStatus />,
  }], {
    initialEntries: ['/desktop-status?state=failed&kind=storage'],
  });
  renderInApp(<RouterProvider router={router} />);

  expect(screen.getByRole('heading', { name: 'Floway 无法启动本机 Gateway' })).toBeTruthy();
  expect(screen.getByText((_content, element) =>
    element?.tagName === 'P'
    && element.textContent === 'Floway 无法读取或写入本机数据或日志。 详细诊断信息可在日志中查看。'))
    .toBeTruthy();
  expect(screen.getByRole('button', { name: '重启 Gateway' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('link', { name: '打开日志' }).getAttribute('href')).toBe('floway-action://open-logs');
});

test('reports recovery only after the native IPC state has been reconciled', async () => {
  let resolveStatus: ((status: { readonly kind: string; readonly restartEnabled?: boolean; readonly state: string }) => void) | undefined;
  const currentStatus = new Promise<{ readonly kind: string; readonly restartEnabled?: boolean; readonly state: string }>(resolve => {
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
  expect(tauri.invoke).not.toHaveBeenCalledWith('report_desktop_recovery_surface', expect.anything());

  resolveStatus?.({ kind: 'compatibility', restartEnabled: true, state: 'failed' });
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    expect.objectContaining({
      surface: {
        actions: ['restart', 'open-logs'],
        failureKind: 'compatibility',
        locale: 'en',
        restartEnabled: true,
      },
    }),
  ));
});

test('does not let an older status snapshot overwrite a newer runtime event', async () => {
  let resolveStatus: ((status: { readonly kind?: string; readonly restartEnabled?: boolean; readonly state: string }) => void) | undefined;
  let publishStatus: ((event: { readonly payload: { readonly kind?: string; readonly restartEnabled?: boolean; readonly state: string } }) => void) | undefined;
  const currentStatus = new Promise<{ readonly kind?: string; readonly restartEnabled?: boolean; readonly state: string }>(resolve => {
    resolveStatus = resolve;
  });
  tauri.isTauri.mockReturnValue(true);
  tauri.listen.mockImplementation(async (_event, listener) => {
    publishStatus = listener;
    return vi.fn();
  });
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') return await currentStatus;
    return undefined;
  });
  const router = createMemoryRouter([{
    path: '/desktop-status',
    element: <DesktopStatus />,
  }], {
    initialEntries: ['/desktop-status'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('desktop_runtime_status'));
  publishStatus?.({ payload: { kind: 'port', restartEnabled: true, state: 'failed' } });
  resolveStatus?.({ state: 'starting' });

  await waitFor(() => expect(screen.getByText(/configured local port is unavailable/i)).toBeTruthy());
  expect(screen.queryByText(/starting the local gateway/i)).toBeNull();
});
