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
import DesktopStatus, {
  hasUpdateRecovery,
  parseDesktopStatus,
  parseDesktopUpdateRecovery,
  type DesktopUpdateRecoveryView,
} from '../../src/routes/desktop-status.tsx';
import { renderInApp } from '../render.tsx';

const emptyUpdate: DesktopUpdateRecoveryView = {
  failure: null,
  pendingVersion: null,
  previousDownloadUrl: null,
  previousVersion: null,
  recoveryPointAvailable: false,
  stagedVersion: null,
  version: null,
};

afterEach(async () => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReturnValue(false);
  tauri.listen.mockClear();
  await act(async () => { await setLanguage('en'); });
});

test('defaults to a bounded startup state without requiring the sidecar', () => {
  expect(parseDesktopStatus(new URLSearchParams())).toEqual({
    chain: [],
    failureKind: 'unknown',
    failureKey: 'desktop.status.failures.unknown',
    logsAvailable: false,
    restartEnabled: false,
    revision: 0,
    state: 'starting',
    update: emptyUpdate,
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
      chain: [],
      failureKind: kind,
      failureKey,
      logsAvailable: false,
      restartEnabled: false,
      revision: 0,
      state: 'failed',
      update: emptyUpdate,
    });
  }
});

test('rejects inherited and malformed failure kinds at the URL boundary', () => {
  for (const kind of ['constructor', 'toString', '__proto__', '', 'PORT']) {
    expect(parseDesktopStatus(new URLSearchParams({ kind, state: 'failed' }))).toEqual({
      chain: [],
      failureKind: 'unknown',
      failureKey: 'desktop.status.failures.unknown',
      logsAvailable: false,
      restartEnabled: false,
      revision: 0,
      state: 'failed',
      update: emptyUpdate,
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

test('renders the bounded original failure chain from the owning runtime status', async () => {
  let publishStatus: ((event: { readonly payload: {
    readonly chain?: readonly string[];
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
    if (command === 'desktop_runtime_status') return { logsAvailable: true, revision: 1, state: 'starting' };
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
  publishStatus?.({
    payload: {
      chain: ['Floway could not bind its local listener', 'EADDRINUSE 127.0.0.1:8788'],
      kind: 'port',
      logsAvailable: true,
      restartEnabled: true,
      revision: 3,
      state: 'failed',
    },
  });

  await waitFor(() => expect(screen.getByText(/EADDRINUSE 127\.0\.0\.1:8788/)).toBeTruthy());
  expect(screen.getByText(/Original failure/i)).toBeTruthy();
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

test('parses the shell update recovery snapshot with bounded fields', () => {
  expect(parseDesktopUpdateRecovery(null)).toEqual(emptyUpdate);
  expect(parseDesktopUpdateRecovery({ failure: 'not-an-object' })).toEqual(emptyUpdate);
  expect(parseDesktopUpdateRecovery({
    failure: {
      chain: ['manifest signature did not verify', 'caused by: minisign', 1, null],
      phase: 'signature',
      version: '0.2.0',
    },
    pendingVersion: '0.2.0',
    previousDownloadUrl: 'https://github.com/tommy0103/Floway-One/releases/tag/v0.1.0',
    previousVersion: '0.1.0',
    recoveryPointAvailable: true,
    stagedVersion: '0.2.0',
  })).toEqual({
    failure: {
      chain: ['manifest signature did not verify', 'caused by: minisign'],
      phase: 'signature',
      version: '0.2.0',
    },
    pendingVersion: '0.2.0',
    previousDownloadUrl: 'https://github.com/tommy0103/Floway-One/releases/tag/v0.1.0',
    previousVersion: '0.1.0',
    recoveryPointAvailable: true,
    stagedVersion: '0.2.0',
    version: '0.2.0',
  });
  expect(parseDesktopUpdateRecovery({
    failure: { chain: [], phase: 'health', version: '0.2.0' },
    recoveryPointAvailable: false,
  }).version).toBe('0.2.0');
});

test('treats only meaningful update snapshots as update recovery', () => {
  expect(hasUpdateRecovery(emptyUpdate)).toBe(false);
  expect(hasUpdateRecovery({ ...emptyUpdate, stagedVersion: '0.2.0' })).toBe(false);
  expect(hasUpdateRecovery({ ...emptyUpdate, version: '0.2.0', pendingVersion: '0.2.0' })).toBe(true);
  expect(hasUpdateRecovery({ ...emptyUpdate, recoveryPointAvailable: true })).toBe(true);
  expect(hasUpdateRecovery({ ...emptyUpdate, previousDownloadUrl: 'https://example.com' })).toBe(true);
});

test('renders the update recovery section with the previous-version download action', async () => {
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') {
      return {
        kind: 'migration',
        logsAvailable: true,
        restartEnabled: true,
        revision: 5,
        state: 'failed',
        update: {
          pendingVersion: '0.2.0',
          previousDownloadUrl: 'https://github.com/tommy0103/Floway-One/releases/tag/v0.1.0',
          previousVersion: '0.1.0',
          recoveryPointAvailable: true,
        },
      };
    }
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/desktop-status', element: <DesktopStatus /> }], {
    initialEntries: ['/desktop-status'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(screen.getByText('The application update did not finish')).toBeTruthy());
  expect(screen.getByText('The previous version and its data remain recoverable.')).toBeTruthy();
  expect(screen.getByText('Update version: 0.2.0')).toBeTruthy();
  expect(screen.getByText('The pre-update database recovery point is preserved on this device.')).toBeTruthy();
  expect(screen.getByText('The local database could not be upgraded safely.')).toBeTruthy();
  const download = screen.getByRole('link', { name: 'Download Floway 0.1.0' });
  expect(download.getAttribute('href')).toBe('floway-action://download-previous-version');

  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    {
      surface: {
        actions: ['restart', 'open-logs', 'download-previous-version'],
        failureKind: 'migration',
        logsAvailable: true,
        locale: 'en',
        restartEnabled: true,
        revision: 5,
        update: {
          previousVersionDownload: true,
          recoveryPointAvailable: true,
          version: '0.2.0',
        },
      },
    },
  ));
});

test('renders the Simplified Chinese update recovery copy', async () => {
  await act(async () => { await setLanguage('zh-Hans'); });
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') {
      return {
        kind: 'timeout',
        logsAvailable: true,
        restartEnabled: true,
        revision: 3,
        state: 'failed',
        update: {
          pendingVersion: '0.2.0',
          previousDownloadUrl: 'https://github.com/tommy0103/Floway-One/releases/tag/v0.1.0',
          previousVersion: '0.1.0',
          recoveryPointAvailable: true,
        },
      };
    }
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/desktop-status', element: <DesktopStatus /> }], {
    initialEntries: ['/desktop-status'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(screen.getByText('应用更新未完成')).toBeTruthy());
  expect(screen.getByText('上一版本及其数据仍可恢复。')).toBeTruthy();
  expect(screen.getByText('更新版本：0.2.0')).toBeTruthy();
  expect(screen.getByText('升级前创建的数据库恢复点已保留在本设备上。')).toBeTruthy();
  expect(screen.getByRole('link', { name: '下载 Floway 0.1.0' }).getAttribute('href'))
    .toBe('floway-action://download-previous-version');

  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    expect.objectContaining({
      surface: expect.objectContaining({
        locale: 'zh-Hans',
        update: {
          previousVersionDownload: true,
          recoveryPointAvailable: true,
          version: '0.2.0',
        },
      }),
    }),
  ));
});

test('omits the update recovery section for healthy runtime snapshots', async () => {
  tauri.isTauri.mockReturnValue(true);
  tauri.invoke.mockImplementation(async command => {
    if (command === 'desktop_runtime_status') {
      return { kind: 'port', logsAvailable: true, restartEnabled: true, revision: 2, state: 'failed' };
    }
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/desktop-status', element: <DesktopStatus /> }], {
    initialEntries: ['/desktop-status'],
  });
  renderInApp(<RouterProvider router={router} />);

  await waitFor(() => expect(screen.getByText(/configured local port is unavailable/i)).toBeTruthy());
  expect(screen.queryByText('The application update did not finish')).toBeNull();
  expect(screen.queryByRole('link', { name: /Download Floway/ })).toBeNull();
  await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith(
    'report_desktop_recovery_surface',
    {
      surface: {
        actions: ['restart', 'open-logs'],
        failureKind: 'port',
        logsAvailable: true,
        locale: 'en',
        restartEnabled: true,
        revision: 2,
      },
    },
  ));
});
