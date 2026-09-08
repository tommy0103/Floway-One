import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { assertNativeFailureSurface } from './native-surface.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

const execFileAsync = promisify(execFile);

// XNU owns the POSIX signal identities used by Node's typed signal boundary.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
export const TERMINATION_SIGNAL: NodeJS.Signals = 'SIGTERM';
const FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';
const MAXIMUM_SIDECAR_LOG_BYTES = 1024 * 1024;

export type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

export const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

export const waitForProcessStopped = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Packaged verification left process ${pid} running`);
};

const waitForProcessGroupStopped = async (groupId: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Packaged verification left process group ${groupId} running`);
};

const directChildPids = async (parentPid: number): Promise<number[]> => {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)]);
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return [];
    throw error;
  }
};

export const assertNoDirectChildren = async (parentPid: number): Promise<void> => {
  const children = await directChildPids(parentPid);
  if (children.length > 0) {
    throw new Error(`Floway application ${parentPid} still owns sidecars: ${children.join(', ')}`);
  }
};

export const waitForDirectChild = async (
  parent: CapturedChild,
  output: () => string,
): Promise<number> => {
  if (parent.pid === undefined) throw new Error('Floway production app process has no PID');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && parent.exitCode === null && parent.signalCode === null) {
    const [pid] = await directChildPids(parent.pid);
    if (pid !== undefined) return pid;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Floway production app did not start its packaged sidecar (pid ${parent.pid ?? 'unknown'})\n${output()}`);
};

export const waitForChildExit = async (child: CapturedChild, timeoutMs: number): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Process ${child.pid ?? 'unknown'} did not exit`)), timeoutMs);
      timeout.unref();
    }),
  ]);
};

export const terminateProcessGroup = async (child: CapturedChild): Promise<void> => {
  if (child.pid === undefined) return;
  const observedPids = [child.pid, ...await directChildPids(child.pid)];
  try {
    process.kill(-child.pid, TERMINATION_SIGNAL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  try {
    await waitForChildExit(child, 3_000);
  } catch {
    try {
      process.kill(-child.pid, FORCE_KILL_SIGNAL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await waitForChildExit(child, 3_000);
  }
  await Promise.all(observedPids.map(waitForProcessStopped));
  await waitForProcessGroupStopped(child.pid);
};

export const captureApp = (executable: string, environment: NodeJS.ProcessEnv): {
  readonly child: CapturedChild;
  readonly output: () => string;
} => {
  const child = spawn(executable, [], {
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let captured = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { captured += chunk; });
  child.stderr.on('data', chunk => { captured += chunk; });
  child.once('error', error => { captured += `${error.stack ?? error.message}\n`; });
  return { child, output: () => captured };
};

export const requestNormalApplicationExit = async (appRoot: string): Promise<void> => {
  // A standard application quit request reaches Tauri's RunEvent::ExitRequested
  // without defining #17's tray, window-close, signal, or graceful-quit policy.
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    `tell application ${JSON.stringify(appRoot)} to quit`,
  ]);
};

// The personal runtime owns this stable port, and the desktop Dashboard origin
// must use the same authority for bootstrap and control-plane CORS.
// https://github.com/tommy0103/Floway-One/blob/dae7ba3773b50648b8a7ed75c5565b24f988919e/apps/platform-node/src/personal-runtime.ts#L18-L20
export const PERSONAL_DASHBOARD_PORT = 8788;

export const reserveNonDefaultLoopbackPort = async (): Promise<number> => await withFailureSafeCleanup(async cleanup => {
  const server = createServer();
  cleanup.defer('custom-port reservation', async () => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  if (port === PERSONAL_DASHBOARD_PORT) throw new Error('Operating system reserved the default port for the custom-port probe');
  return port;
});

export const appEnvironmentWithoutPortOverride = (applicationHome: string): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.PORT;
  environment.FLOWAY_DESKTOP_LOGS_DIR = resolve(applicationHome, 'logs');
  return environment;
};

export const assertBoundedSidecarLogs = async (
  applicationHome: string,
  expectedFragments: readonly string[],
): Promise<void> => {
  const logsDirectory = resolve(applicationHome, 'logs');
  const names = (await readdir(logsDirectory)).filter(name => name.startsWith('floway.sidecar.log')).sort();
  if (names.length === 0 || names.length > 4 || names[0] !== 'floway.sidecar.log') {
    throw new Error(`Floway persisted an unexpected bounded-log inventory: ${JSON.stringify(names)}`);
  }
  let persisted = '';
  for (const name of names) {
    const path = resolve(logsDirectory, name);
    const size = (await stat(path)).size;
    if (size > MAXIMUM_SIDECAR_LOG_BYTES) {
      throw new Error(`Floway persisted oversized sidecar log ${path}: ${size} bytes`);
    }
    const bytes = await readFile(path);
    persisted += new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  for (const fragment of expectedFragments) {
    if (!persisted.includes(fragment)) {
      throw new Error(`Floway persisted logs omitted ${JSON.stringify(fragment)} beneath ${applicationHome}`);
    }
  }
};

export const assertLoopbackPortReleased = async (port: number): Promise<void> => {
  await withFailureSafeCleanup(async cleanup => {
    const server = createServer();
    cleanup.defer('listener-release probe', async () => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', resolveListen);
      });
    } catch (cause) {
      throw new Error(`Floway verification listener still owns 127.0.0.1:${port}`, { cause });
    }
  });
};

export const waitForOutput = async (
  child: CapturedChild,
  output: () => string,
  expectedFragments: readonly string[],
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = output();
    if (expectedFragments.every(fragment => captured.includes(fragment))) return captured;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Floway production app omitted ${JSON.stringify(expectedFragments)}\n${output()}`);
};

export const observePackagedFailureSurface = async (options: {
  readonly applicationHome: string;
  readonly executable: string;
  readonly expectedFragments: readonly string[];
  readonly failureKind: string;
  readonly forbiddenSnapshotText?: readonly string[];
  readonly nativeWindowProbe: string;
  readonly persistedLogFragments?: readonly string[];
  readonly sidecarMustNotStart?: boolean;
}): Promise<string> => await withFailureSafeCleanup(async cleanup => {
  await mkdir(options.applicationHome, { recursive: true });
  cleanup.defer('isolated shell application data', async () => {
    await rm(options.applicationHome, { force: true, recursive: true });
    await access(options.applicationHome).then(
      () => { throw new Error(`Floway shell application data remains at ${options.applicationHome}`); },
      error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      },
    );
  });
  const { child, output } = captureApp(
    options.executable,
    appEnvironmentWithoutPortOverride(options.applicationHome),
  );
  cleanup.defer('fault-probe application process group', async () => await terminateProcessGroup(child));
  const observedChildren = new Set<number>();
  let captured = '';
  const failureEvidence = [
    ...options.expectedFragments,
    `Floway desktop runtime state: failed kind=${options.failureKind}`,
  ];
  const surfaceEvidence = [
    'FLOWAY_DESKTOP_SURFACE ',
    'FLOWAY_DESKTOP_RENDERED_SURFACE ',
  ];
  const observeUntil = async (deadline: number, expected: readonly string[]): Promise<void> => {
    while (Date.now() < deadline) {
      if (options.sidecarMustNotStart && child.pid !== undefined) {
        for (const pid of await directChildPids(child.pid)) observedChildren.add(pid);
      }
      captured = output();
      if (expected.every(fragment => captured.includes(fragment))) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  };
  await observeUntil(Date.now() + 10_000, failureEvidence);
  if (failureEvidence.every(fragment => captured.includes(fragment))) {
    await observeUntil(Date.now() + 10_000, surfaceEvidence);
  }
  for (const fragment of [...failureEvidence, ...surfaceEvidence]) {
    if (!captured.includes(fragment)) {
      throw new Error(`Floway production setup omitted ${JSON.stringify(fragment)}\n${captured}`);
    }
  }
  if (child.pid === undefined || !processIsRunning(child.pid)) {
    throw new Error(`Floway production app did not retain its visible failure surface\n${output()}`);
  }
  if (options.sidecarMustNotStart && observedChildren.size > 0) {
    throw new Error(`Floway production setup spawned sidecars before failing: ${[...observedChildren].join(', ')}`);
  }
  await assertNativeFailureSurface(options.nativeWindowProbe, child.pid, captured, {
    failureKind: options.failureKind,
    forbiddenSnapshotText: options.forbiddenSnapshotText ?? options.expectedFragments,
  });
  if (options.persistedLogFragments !== undefined) {
    await assertBoundedSidecarLogs(options.applicationHome, options.persistedLogFragments);
  }
  await assertNoDirectChildren(child.pid);
  await terminateProcessGroup(child);
  return captured;
});
