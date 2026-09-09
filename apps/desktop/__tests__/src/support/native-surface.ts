import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./native-window.swift', import.meta.url));
const SURFACE_PREFIX = 'FLOWAY_DESKTOP_SURFACE ';
const RECOVERY_SURFACE_PREFIX = 'FLOWAY_DESKTOP_RECOVERY_SURFACE ';

interface MenuItemSnapshot {
  readonly enabled: boolean;
  readonly text: string;
}

interface RuntimeSurfaceSnapshot {
  readonly failureKind: string;
  readonly phase: string;
  readonly tray: {
    readonly logs: MenuItemSnapshot;
    readonly restart: MenuItemSnapshot;
    readonly status: MenuItemSnapshot;
  };
  readonly window: {
    readonly failureKind: string;
    readonly route: string;
    readonly state: string;
    readonly title: string;
    readonly visible: boolean;
  };
}

interface RecoverySurfaceSnapshot {
  readonly actions: readonly string[];
  readonly failureKind: string;
  readonly locale: 'en' | 'zh-Hans';
  readonly restartEnabled: boolean;
}

const labels = {
  en: {
    logs: 'Open Logs',
    restart: 'Restart Gateway',
    status: 'Gateway: Needs attention',
  },
  'zh-Hans': {
    logs: '打开日志',
    restart: '重启 Gateway',
    status: 'Gateway：需要处理',
  },
} as const;

export const compileNativeWindowProbe = async (outputDirectory: string): Promise<string> => {
  const executable = resolve(outputDirectory, 'floway-native-window');
  await execFileAsync('/usr/bin/xcrun', [
    'swiftc',
    '-module-cache-path',
    resolve(outputDirectory, 'swift-module-cache'),
    source,
    '-o',
    executable,
  ], { timeout: 60_000 });
  return executable;
};

const parseSurfaceSnapshot = (output: string): { encoded: string; snapshot: RuntimeSurfaceSnapshot } => {
  const line = output.split('\n').findLast(candidate => candidate.startsWith(SURFACE_PREFIX));
  if (line === undefined) throw new Error(`Floway emitted no ${SURFACE_PREFIX.trim()} diagnostic`);
  const encoded = line.slice(SURFACE_PREFIX.length);
  return { encoded, snapshot: JSON.parse(encoded) as RuntimeSurfaceSnapshot };
};

const parseRecoverySurfaceSnapshot = (output: string): RecoverySurfaceSnapshot => {
  const line = output.split('\n').findLast(candidate => candidate.startsWith(RECOVERY_SURFACE_PREFIX));
  if (line === undefined) throw new Error(`Floway emitted no ${RECOVERY_SURFACE_PREFIX.trim()} diagnostic`);
  return JSON.parse(line.slice(RECOVERY_SURFACE_PREFIX.length)) as RecoverySurfaceSnapshot;
};

export const assertNativeFailureSurface = async (
  executable: string,
  pid: number,
  output: string,
  options: {
    readonly expectedLocale?: 'en' | 'zh-Hans';
    readonly failureKind: string;
    readonly forbiddenSnapshotText: readonly string[];
  },
): Promise<void> => {
  const { encoded, snapshot } = parseSurfaceSnapshot(output);
  const recovery = parseRecoverySurfaceSnapshot(output);
  const expectedLocale = options.expectedLocale ?? 'en';
  const expectedLabels = labels[expectedLocale];
  for (const forbidden of options.forbiddenSnapshotText) {
    if (encoded.includes(forbidden)) {
      throw new Error(`Floway surface diagnostic exposed unrestricted text: ${JSON.stringify(forbidden)}`);
    }
  }
  if (
    snapshot.failureKind !== options.failureKind
    || snapshot.phase !== 'failed'
    || snapshot.window.failureKind !== options.failureKind
    || snapshot.window.route !== '/desktop-status'
    || snapshot.window.state !== 'failed'
    || snapshot.window.title !== 'Floway'
    || !snapshot.window.visible
    || snapshot.tray.status.text !== expectedLabels.status
    || snapshot.tray.status.enabled
    || snapshot.tray.restart.text !== expectedLabels.restart
    || !snapshot.tray.restart.enabled
    || snapshot.tray.logs.text !== expectedLabels.logs
    || !snapshot.tray.logs.enabled
  ) {
    throw new Error(`Floway actual-object surface diagnostic is incomplete: ${JSON.stringify(snapshot)}`);
  }
  if (
    recovery.failureKind !== options.failureKind
    || recovery.locale !== expectedLocale
    || !recovery.restartEnabled
    || JSON.stringify(recovery.actions) !== JSON.stringify(['restart', 'open-logs'])
  ) {
    throw new Error(`Floway recovery support diagnostic is incomplete: ${JSON.stringify(recovery)}`);
  }

  const { stdout } = await execFileAsync(executable, [String(pid)], { timeout: 10_000 });
  const external = JSON.parse(stdout) as { pid?: unknown; visibleWindowCount?: unknown };
  if (external.pid !== pid || typeof external.visibleWindowCount !== 'number' || external.visibleWindowCount < 1) {
    throw new Error(`CoreGraphics found no visible Floway window: ${JSON.stringify(external)}`);
  }
};
