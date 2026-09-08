import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./native-window.swift', import.meta.url));
const SURFACE_PREFIX = 'FLOWAY_DESKTOP_SURFACE ';

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
    readonly renderedSurface: string;
    readonly route: string;
    readonly state: string;
    readonly title: string;
    readonly visible: boolean;
  };
}

const labels = {
  logs: ['Open Logs', '打开日志'],
  restart: ['Restart Gateway', '重启 Gateway'],
  status: ['Gateway: Needs attention', 'Gateway：需要处理'],
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

const hasLabel = (value: string, alternatives: readonly string[]): boolean => alternatives.includes(value);

export const assertNativeFailureSurface = async (
  executable: string,
  pid: number,
  output: string,
  options: {
    readonly failureKind: string;
    readonly forbiddenSnapshotText: readonly string[];
  },
): Promise<void> => {
  const { encoded, snapshot } = parseSurfaceSnapshot(output);
  for (const forbidden of options.forbiddenSnapshotText) {
    if (encoded.includes(forbidden)) {
      throw new Error(`Floway surface diagnostic exposed unrestricted text: ${JSON.stringify(forbidden)}`);
    }
  }
  if (
    snapshot.failureKind !== options.failureKind
    || snapshot.phase !== 'failed'
    || snapshot.window.failureKind !== options.failureKind
    || snapshot.window.renderedSurface !== 'recovery-actions-and-logs-only'
    || snapshot.window.route !== '/desktop-status'
    || snapshot.window.state !== 'failed'
    || snapshot.window.title !== 'Floway'
    || !snapshot.window.visible
    || !hasLabel(snapshot.tray.status.text, labels.status)
    || snapshot.tray.status.enabled
    || !hasLabel(snapshot.tray.restart.text, labels.restart)
    || !snapshot.tray.restart.enabled
    || !hasLabel(snapshot.tray.logs.text, labels.logs)
    || !snapshot.tray.logs.enabled
  ) {
    throw new Error(`Floway actual-object surface diagnostic is incomplete: ${JSON.stringify(snapshot)}`);
  }

  const { stdout } = await execFileAsync(executable, [String(pid)], { timeout: 10_000 });
  const external = JSON.parse(stdout) as { pid?: unknown; visibleWindowCount?: unknown };
  if (external.pid !== pid || typeof external.visibleWindowCount !== 'number' || external.visibleWindowCount < 1) {
    throw new Error(`CoreGraphics found no visible Floway window: ${JSON.stringify(external)}`);
  }
};
