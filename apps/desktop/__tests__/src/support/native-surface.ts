import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./native-window.swift', import.meta.url));
const SURFACE_PREFIX = 'FLOWAY_DESKTOP_SURFACE ';
const RENDERED_SURFACE_PREFIX = 'FLOWAY_DESKTOP_RENDERED_SURFACE ';

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

interface RenderedSurfaceSnapshot {
  readonly actions: readonly string[];
  readonly copyDigest: string;
  readonly failureKind: string;
  readonly locale: 'en' | 'zh-Hans';
}

const labels = {
  logs: ['Open Logs', '打开日志'],
  restart: ['Restart Gateway', '重启 Gateway'],
  status: ['Gateway: Needs attention', 'Gateway：需要处理'],
} as const;

const renderedCopy = {
  en: {
    details: 'Detailed diagnostics are available in the logs.',
    failures: {
      asset: 'Dashboard files are missing or do not match this Floway release.',
      compatibility: 'The desktop shell, local runtime, and Dashboard are not from the same compatible release.',
      migration: 'The local database could not be upgraded safely.',
      'native-dependency': 'A packaged native dependency does not match this computer.',
      port: 'The configured local port is unavailable.',
      storage: 'Floway cannot read or write its local data or logs.',
      timeout: 'The local Gateway did not become healthy before the startup deadline.',
      'unexpected-exit': 'The local Gateway stopped unexpectedly.',
      unknown: 'The local Gateway reported an unexpected failure.',
    },
    logs: 'Open logs',
    restart: 'Restart Gateway',
    title: 'Floway could not start the local Gateway',
  },
  'zh-Hans': {
    details: '详细诊断信息可在日志中查看。',
    failures: {
      asset: 'Dashboard 文件缺失，或与当前 Floway 版本不匹配。',
      compatibility: '桌面壳、本机运行时和 Dashboard 并非来自同一个兼容版本。',
      migration: '无法安全升级本机数据库。',
      'native-dependency': '打包的原生依赖与当前计算机不匹配。',
      port: '配置的本机端口不可用。',
      storage: 'Floway 无法读取或写入本机数据或日志。',
      timeout: '本机 Gateway 未能在启动时限内进入健康状态。',
      'unexpected-exit': '本机 Gateway 意外停止。',
      unknown: '本机 Gateway 报告了意外故障。',
    },
    logs: '打开日志',
    restart: '重启 Gateway',
    title: 'Floway 无法启动本机 Gateway',
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

const parseRenderedSurfaceSnapshot = (output: string): RenderedSurfaceSnapshot => {
  const line = output.split('\n').findLast(candidate => candidate.startsWith(RENDERED_SURFACE_PREFIX));
  if (line === undefined) throw new Error(`Floway emitted no ${RENDERED_SURFACE_PREFIX.trim()} diagnostic`);
  return JSON.parse(line.slice(RENDERED_SURFACE_PREFIX.length)) as RenderedSurfaceSnapshot;
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
  const rendered = parseRenderedSurfaceSnapshot(output);
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
    || !hasLabel(snapshot.tray.status.text, labels.status)
    || snapshot.tray.status.enabled
    || !hasLabel(snapshot.tray.restart.text, labels.restart)
    || !snapshot.tray.restart.enabled
    || !hasLabel(snapshot.tray.logs.text, labels.logs)
    || !snapshot.tray.logs.enabled
  ) {
    throw new Error(`Floway actual-object surface diagnostic is incomplete: ${JSON.stringify(snapshot)}`);
  }
  const localeCopy = renderedCopy[rendered.locale];
  const failureCopy = localeCopy?.failures[options.failureKind as keyof typeof localeCopy.failures];
  const expectedDigest = failureCopy === undefined
    ? undefined
    : createHash('sha256').update(JSON.stringify([
        localeCopy.title,
        `${failureCopy} ${localeCopy.details}`,
        localeCopy.restart,
        'floway-action://restart',
        localeCopy.logs,
        'floway-action://open-logs',
      ])).digest('hex');
  if (
    rendered.failureKind !== options.failureKind
    || JSON.stringify(rendered.actions) !== JSON.stringify(['restart', 'open-logs'])
    || expectedDigest === undefined
    || rendered.copyDigest !== expectedDigest
  ) {
    throw new Error(`Floway rendered recovery surface diagnostic is incomplete: ${JSON.stringify(rendered)}`);
  }

  const { stdout } = await execFileAsync(executable, [String(pid)], { timeout: 10_000 });
  const external = JSON.parse(stdout) as { pid?: unknown; visibleWindowCount?: unknown };
  if (external.pid !== pid || typeof external.visibleWindowCount !== 'number' || external.visibleWindowCount < 1) {
    throw new Error(`CoreGraphics found no visible Floway window: ${JSON.stringify(external)}`);
  }
};
