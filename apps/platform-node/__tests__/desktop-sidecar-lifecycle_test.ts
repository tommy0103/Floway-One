import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DESKTOP_SIDECAR_GRACEFUL_STOP_LINE,
  DESKTOP_SIDECAR_OWNER_LOST_LINE,
  installDesktopSidecarLifecycle,
  type DesktopSidecarLifecycleHost,
} from '../src/desktop-sidecar-lifecycle.ts';

const LIFECYCLE_CHILD = fileURLToPath(new URL('./fixtures/desktop-sidecar-lifecycle-child.ts', import.meta.url));
const DESKTOP_CONTRACT_ENV = 'FLOWAY_DESKTOP_CONTRACT';

interface RecordedHost {
  readonly host: DesktopSidecarLifecycleHost;
  readonly exitCodes: number[];
  readonly flushedChunks: string[];
  readonly signals: string[];
  readonly sigtermListeners: Array<() => void>;
}

const recordedHost = (): RecordedHost => {
  const recorded: Omit<RecordedHost, 'host'> = {
    exitCodes: [],
    flushedChunks: [],
    signals: [],
    sigtermListeners: [],
  };
  const host: DesktopSidecarLifecycleHost = {
    on: (signal: 'SIGTERM', listener: () => void) => {
      recorded.signals.push(signal);
      recorded.sigtermListeners.push(listener);
    },
    exit: (code: number) => { recorded.exitCodes.push(code); },
    stderr: {
      write: (chunk: string, callback: () => void) => {
        recorded.flushedChunks.push(chunk);
        callback();
      },
    },
  };
  return { ...recorded, host };
};

const DESKTOP_ENVIRONMENT = { [DESKTOP_CONTRACT_ENV]: '/tmp/floway-lifecycle-test-contract.json' };

describe('installDesktopSidecarLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('stays inert outside the packaged desktop contract', () => {
    const recorded = recordedHost();
    const stdin = new PassThrough();
    installDesktopSidecarLifecycle({ environment: {}, host: recorded.host, stdin });
    expect(recorded.signals).toEqual([]);
    expect(recorded.exitCodes).toEqual([]);
    expect(stdin.listenerCount('end')).toBe(0);
  });

  test('SIGTERM exits zero after flushing the graceful-stop line', () => {
    const recorded = recordedHost();
    installDesktopSidecarLifecycle({
      environment: DESKTOP_ENVIRONMENT,
      host: recorded.host,
      stdin: new PassThrough(),
    });
    expect(recorded.signals).toEqual(['SIGTERM']);
    expect(recorded.sigtermListeners).toHaveLength(1);
    recorded.sigtermListeners[0]!();
    expect(recorded.flushedChunks).toEqual([`${DESKTOP_SIDECAR_GRACEFUL_STOP_LINE}\n`]);
    expect(recorded.exitCodes).toEqual([0]);
  });

  test('stdin EOF exits zero with the owner-lifetime line', () => {
    const recorded = recordedHost();
    const stdin = new PassThrough();
    installDesktopSidecarLifecycle({
      environment: DESKTOP_ENVIRONMENT,
      host: recorded.host,
      stdin,
    });
    stdin.emit('end');
    expect(recorded.flushedChunks).toEqual([`${DESKTOP_SIDECAR_OWNER_LOST_LINE}\n`]);
    expect(recorded.exitCodes).toEqual([0]);
  });

  test('an owner-channel error exits through the same owner-lifetime path', () => {
    const recorded = recordedHost();
    const stdin = new PassThrough();
    installDesktopSidecarLifecycle({
      environment: DESKTOP_ENVIRONMENT,
      host: recorded.host,
      stdin,
    });
    stdin.emit('error', new Error('forced owner channel failure'));
    expect(recorded.flushedChunks).toEqual([`${DESKTOP_SIDECAR_OWNER_LOST_LINE}\n`]);
    expect(recorded.exitCodes).toEqual([0]);
  });

  test('simultaneous termination signals exit exactly once', () => {
    const recorded = recordedHost();
    const stdin = new PassThrough();
    installDesktopSidecarLifecycle({
      environment: DESKTOP_ENVIRONMENT,
      host: recorded.host,
      stdin,
    });
    recorded.sigtermListeners[0]!();
    stdin.emit('end');
    expect(recorded.exitCodes).toEqual([0]);
    expect(recorded.flushedChunks).toHaveLength(1);
  });

  test('exit does not depend on the stderr flush callback', () => {
    vi.useFakeTimers();
    const exitCodes: number[] = [];
    const stdin = new PassThrough();
    installDesktopSidecarLifecycle({
      environment: DESKTOP_ENVIRONMENT,
      host: {
        on: () => {},
        exit: code => { exitCodes.push(code); },
        stderr: { write: () => {} },
      },
      stdin,
    });
    stdin.emit('end');
    expect(exitCodes).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(exitCodes).toEqual([0]);
  });
});

type ArmedChild = ChildProcessByStdio<Writable, Readable, Readable>;

const armLifecycleChild = async (environment: NodeJS.ProcessEnv): Promise<{ child: ArmedChild; output: () => string }> => {
  const child = spawn(process.execPath, ['--import', 'tsx', LIFECYCLE_CHILD], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let captured = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { captured += chunk; });
  child.stderr.on('data', chunk => { captured += chunk; });
  const deadline = Date.now() + 10_000;
  while (!captured.includes('desktop sidecar lifecycle child armed')) {
    if (Date.now() >= deadline) throw new Error(`Lifecycle child did not arm\n${captured}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Lifecycle child exited before arming: ${child.exitCode ?? child.signalCode}\n${captured}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  return { child, output: () => captured };
};

describe('desktop sidecar lifecycle in a live child process', () => {
  test('closing the owner channel exits the child zero with the owner-lifetime line', async () => {
    const { child, output } = await armLifecycleChild({ ...process.env, ...DESKTOP_ENVIRONMENT });
    child.stdin.end();
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(output()).toContain(DESKTOP_SIDECAR_OWNER_LOST_LINE);
  }, 15_000);

  test('SIGTERM exits the child zero with the graceful-stop line', async () => {
    const { child, output } = await armLifecycleChild({ ...process.env, ...DESKTOP_ENVIRONMENT });
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(output()).toContain(DESKTOP_SIDECAR_GRACEFUL_STOP_LINE);
  }, 15_000);

  test('a child without the desktop contract keeps default signal and stdin behavior', async () => {
    const environment = { ...process.env };
    delete environment[DESKTOP_CONTRACT_ENV];
    const { child, output } = await armLifecycleChild(environment);
    child.stdin.end();
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    expect(code).toBeNull();
    expect(signal).toBe('SIGTERM');
    expect(output()).not.toContain(DESKTOP_SIDECAR_OWNER_LOST_LINE);
    expect(output()).not.toContain(DESKTOP_SIDECAR_GRACEFUL_STOP_LINE);
  }, 15_000);
});
