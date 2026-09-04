import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

const execFileAsync = promisify(execFile);

// XNU owns the POSIX signal identities used by Node's typed signal boundary.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
export const TERMINATION_SIGNAL: NodeJS.Signals = 'SIGTERM';
const FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';

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

export const appEnvironmentWithoutPortOverride = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.PORT;
  return environment;
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

export const observeProductionApp = async (
  executable: string,
  expectedFragments: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> => await withFailureSafeCleanup(async cleanup => {
  const { child, output } = captureApp(executable, environment);
  cleanup.defer('fault-probe application process group', async () => await terminateProcessGroup(child));
  await waitForOutput(child, output, expectedFragments);
  await waitForChildExit(child, 5_000);
  if (child.exitCode === 0) {
    throw new Error(`Floway production app unexpectedly succeeded after fault injection\n${output()}`);
  }
  return output();
});

export const observeSetupFailureWithoutSidecar = async (
  executable: string,
  expectedFragments: readonly string[],
): Promise<string> => await withFailureSafeCleanup(async cleanup => {
  const { child, output } = captureApp(executable, appEnvironmentWithoutPortOverride());
  cleanup.defer('setup-fault application process group', async () => await terminateProcessGroup(child));
  const observedChildren = new Set<number>();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (child.pid !== undefined) {
      for (const pid of await directChildPids(child.pid)) observedChildren.add(pid);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  await waitForChildExit(child, 1_000);
  if (child.exitCode === 0) throw new Error(`Floway production setup unexpectedly succeeded\n${output()}`);
  if (observedChildren.size > 0) {
    throw new Error(`Floway production setup spawned sidecars before failing: ${[...observedChildren].join(', ')}`);
  }
  const captured = output();
  for (const fragment of expectedFragments) {
    if (!captured.includes(fragment)) {
      throw new Error(`Floway production setup omitted ${JSON.stringify(fragment)}\n${captured}`);
    }
  }
  return captured;
});
