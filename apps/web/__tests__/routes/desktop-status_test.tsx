import { act, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
  listen: vi.fn(async (
    _event: string,
    _listener: (event: { readonly payload: {
      readonly kind?: unknown;
      readonly logsAvailable?: unknown;
      readonly restartEnabled?: unknown;
      readonly revision?: unknown;
      readonly state?: unknown;
    }; }) => void,
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
    logsAvailable: false,
    restartEnabled: false,
    revision: 0,
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
      logsAvailable: false,
      restartEnabled: false,
      revision: 0,
      state: 'failed',
    });
  }
});

test('rejects inherited and malformed failure kinds at the URL boundary', () => {
  for (const kind of ['constructor', 'toString', '__proto__', '', 'PORT']) {
    expect(parseDesktopStatus(new URLSearchParams({ kind, state: 'failed' }))).toEqual({
      failureKind: 'unknown',
      failureKey: 'desktop.status.failures.unknown',
      logsAvailable: false,
      restartEnabled: false,
      revision: 0,
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
    && element.textContent === 'The configured local port is unavailable. The log directory is unavailable. Review Floway’s standard error output for the original failure.'))
    .toBeTruthy();
  expect(screen.queryByText(/secret stderr/i)).toBeNull();
  const restart = screen.getByRole('button', { name: 'Restart Gateway' });
  expect(restart.getAttribute('aria-disabled')).toBe('true');
  expect(restart.getAttribute('href')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open logs' })).toBeNull();
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
    && element.textContent === 'Floway 无法读取或写入本机数据或日志。 日志目录不可用。请查看 Floway 的标准错误输出以获取原始故障信息。'))
    .toBeTruthy();
  expect(screen.getByRole('button', { name: '重启 Gateway' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.queryByRole('link', { name: '打开日志' })).toBeNull();
});

test('reports recovery only after the native IPC state has been reconciled', async () => {
  let resolveStatus: ((status: { readonly kind: string; readonly logsAvailable: boolean; readonly restartEnabled?: boolean; readonly revision: number; readonly state: string }) => void) | undefined;
  const currentStatus = new Promise<{ readonly kind: string; readonly logsAvailable: boolean; readonly restartEnabled?: boolean; readonly revision: number; readonly state: string }>(resolve => {
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

  resolveStatus?.({ kind: 'compatibility', logsAvailable: true, restartEnabled: true, revision: 4, state: 'failed' });
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    expect.objectContaining({
      surface: {
        actions: ['restart', 'open-logs'],
        failureKind: 'compatibility',
        logsAvailable: true,
        locale: 'en',
        restartEnabled: true,
        revision: 4,
      },
    }),
  ));
});

test('does not let an older status snapshot overwrite a newer runtime event', async () => {
  let resolveStatus: ((status: { readonly kind?: string; readonly logsAvailable: boolean; readonly restartEnabled?: boolean; readonly revision: number; readonly state: string }) => void) | undefined;
  let publishStatus: ((event: { readonly payload: { readonly kind?: string; readonly logsAvailable: boolean; readonly restartEnabled?: boolean; readonly revision: number; readonly state: string } }) => void) | undefined;
  const currentStatus = new Promise<{ readonly kind?: string; readonly logsAvailable: boolean; readonly restartEnabled?: boolean; readonly revision: number; readonly state: string }>(resolve => {
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
  publishStatus?.({ payload: { kind: 'port', logsAvailable: true, restartEnabled: true, revision: 7, state: 'failed' } });
  resolveStatus?.({ logsAvailable: true, revision: 6, state: 'starting' });

  await waitFor(() => expect(screen.getByText(/configured local port is unavailable/i)).toBeTruthy());
  expect(screen.queryByText(/starting the local gateway/i)).toBeNull();
});

test('discards a stale queued event delivered after a newer snapshot', async () => {
  let publishStatus: ((event: { readonly payload: {
    readonly kind?: string;
    readonly logsAvailable: boolean;
    readonly restartEnabled?: boolean;
    readonly revision: number;
    readonly state: string;
  }; }) => void) | undefined;
  tauri.isTauri.mockReturnValue(true);
  tauri.listen.mockImplementation(async (_event, listener) => {
    publishStatus = listener;
    return vi.fn();
  });
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') {
      return { kind: 'storage', logsAvailable: false, restartEnabled: true, revision: 12, state: 'failed' };
    }
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/desktop-status', element: <DesktopStatus /> }], {
    initialEntries: ['/desktop-status'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(screen.getByText(/cannot read or write its local data or logs/i)).toBeTruthy());
  expect(screen.getByText(/log directory is unavailable/i)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Open logs' })).toBeNull();
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    {
      surface: {
        actions: ['restart'],
        failureKind: 'storage',
        logsAvailable: false,
        locale: 'en',
        restartEnabled: true,
        revision: 12,
      },
    },
  ));
  publishStatus?.({
    payload: {
      kind: 'port',
      logsAvailable: true,
      restartEnabled: false,
      revision: 11,
      state: 'failed',
    },
  });

  expect(screen.queryByText(/configured local port is unavailable/i)).toBeNull();
  expect(screen.getByText(/cannot read or write its local data or logs/i)).toBeTruthy();
});
