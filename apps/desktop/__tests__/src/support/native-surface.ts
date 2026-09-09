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
  readonly logsAvailable: boolean;
  readonly locale: 'en' | 'zh-Hans';
  readonly restartEnabled: boolean;
  readonly revision: number;
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

const recoveryCopy = {
  en: {
    detailsInLogs: 'Detailed diagnostics are available in the logs.',
    detailsInStandardError: 'The log directory is unavailable. Review Floway’s standard error output for the original failure.',
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
    detailsInLogs: '详细诊断信息可在日志中查看。',
    detailsInStandardError: '日志目录不可用。请查看 Floway 的标准错误输出以获取原始故障信息。',
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
    readonly expectedLogsAvailable?: boolean;
    readonly failureKind: string;
    readonly forbiddenSnapshotText: readonly string[];
  },
): Promise<void> => {
  const { encoded, snapshot } = parseSurfaceSnapshot(output);
  const recovery = parseRecoverySurfaceSnapshot(output);
  const expectedLocale = options.expectedLocale ?? 'en';
  const expectedLogsAvailable = options.expectedLogsAvailable ?? true;
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
    || snapshot.tray.logs.enabled !== expectedLogsAvailable
  ) {
    throw new Error(`Floway actual-object surface diagnostic is incomplete: ${JSON.stringify(snapshot)}`);
  }
  if (
    recovery.failureKind !== options.failureKind
    || recovery.logsAvailable !== expectedLogsAvailable
    || recovery.locale !== expectedLocale
    || !recovery.restartEnabled
    || !Number.isSafeInteger(recovery.revision)
    || recovery.revision <= 0
    || JSON.stringify(recovery.actions) !== JSON.stringify([
      'restart',
      ...(expectedLogsAvailable ? ['open-logs'] : []),
    ])
  ) {
    throw new Error(`Floway recovery support diagnostic is incomplete: ${JSON.stringify(recovery)}`);
  }

  const { stdout } = await execFileAsync(executable, [String(pid)], { timeout: 10_000 });
  const external = JSON.parse(stdout) as {
    accessibilityActions?: unknown;
    accessibilityText?: unknown;
    pid?: unknown;
    visibleWindowCount?: unknown;
  };
  if (external.pid !== pid || typeof external.visibleWindowCount !== 'number' || external.visibleWindowCount < 1) {
    throw new Error(`CoreGraphics found no visible Floway window: ${JSON.stringify(external)}`);
  }
  if (!Array.isArray(external.accessibilityText) || !Array.isArray(external.accessibilityActions)) {
    throw new Error(`Accessibility returned no Floway recovery tree: ${JSON.stringify(external)}`);
  }
  const accessibilityText = external.accessibilityText.filter((value): value is string => typeof value === 'string');
  const accessibilityActions = external.accessibilityActions.filter((value): value is string => typeof value === 'string');
  const copy = recoveryCopy[expectedLocale];
  const failure = copy.failures[options.failureKind as keyof typeof copy.failures];
  const details = expectedLogsAvailable ? copy.detailsInLogs : copy.detailsInStandardError;
  const requiredText = [copy.title, failure, details, copy.restart];
  if (failure === undefined || requiredText.some(expected => !accessibilityText.some(value => value.includes(expected)))) {
    throw new Error(`Accessibility omitted recovery copy: ${JSON.stringify({ accessibilityText, requiredText })}`);
  }
  if (!accessibilityActions.some(value => value.includes(copy.restart))) {
    throw new Error(`Accessibility omitted the restart action: ${JSON.stringify(accessibilityActions)}`);
  }
  const hasLogsAction = accessibilityActions.some(value => value.includes(copy.logs));
  if (hasLogsAction !== expectedLogsAvailable) {
    throw new Error(`Accessibility log action did not match availability: ${JSON.stringify(accessibilityActions)}`);
  }
};
