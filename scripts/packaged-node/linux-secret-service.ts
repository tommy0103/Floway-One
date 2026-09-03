import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { createOperatingSystemCredential } from '../../apps/platform-node/src/device-master-key.ts';

const execFileAsync = promisify(execFile);

const waitForLine = async (child: ChildProcessWithoutNullStreams, stream: Readable): Promise<string> => await new Promise((resolveLine, rejectLine) => {
  let output = '';
  let errors = '';
  const timeout = setTimeout(() => rejectLine(new Error(`service startup timed out\nstdout: ${output}\nstderr: ${errors}`)), 10_000);
  stream.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  stream.on('data', chunk => {
    output += chunk;
    const line = output.split('\n').find(candidate => candidate.length > 0);
    if (line === undefined) return;
    clearTimeout(timeout);
    resolveLine(line);
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', error => { clearTimeout(timeout); rejectLine(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    rejectLine(new Error(`service exited before readiness (${code ?? signal})\nstdout: ${output}\nstderr: ${errors}`));
  });
});

const waitForPath = async (path: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`service exited before creating ${path}`, { cause: error });
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`service did not create ${path} before the startup deadline`);
};

const terminateChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};

export const startIsolatedLinuxSecretService = async (
  runtimeRoot: string,
  enabled: boolean,
): Promise<() => Promise<void>> => {
  if (!enabled) return async () => undefined;
  if (process.platform !== 'linux') throw new Error('FLOWAY_START_TEST_SECRET_SERVICE is supported only on Linux');

  const originalBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const serviceRuntimeDirectory = resolve(runtimeRoot, 'secret-service-runtime');
  await mkdir(serviceRuntimeDirectory, { recursive: true, mode: 0o700 });
  process.env.XDG_RUNTIME_DIR = serviceRuntimeDirectory;

  // Private D-Bus and Secret Service exercise the same durable API as a desktop session.
  // https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/adadbad2fdeb79a654dca37b31349e2a1d527ef0/daemon/gkd-main.c#L999-L1006
  const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let keyring: ChildProcessWithoutNullStreams | undefined;
  try {
    process.env.DBUS_SESSION_BUS_ADDRESS = await waitForLine(bus, bus.stdout);
    keyring = spawn('gnome-keyring-daemon', ['--foreground', '--login', '--components=secrets'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    keyring.stdin.end('floway-ci-secret-service\n');
    await waitForPath(resolve(serviceRuntimeDirectory, 'keyring/control'), keyring);
    await execFileAsync('gnome-keyring-daemon', ['--start', '--components=secrets'], {
      env: process.env,
      timeout: 10_000,
    });
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await createOperatingSystemCredential(`Floway Secret Service readiness ${randomUUID()}`, 'probe');
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
      }
    }
    if (lastError !== undefined) throw new Error('Isolated Linux Secret Service did not become ready', { cause: lastError });
  } catch (error) {
    await Promise.all([...(keyring === undefined ? [] : [terminateChild(keyring)]), terminateChild(bus)]);
    throw error;
  }

  return async () => {
    await Promise.all([terminateChild(keyring!), terminateChild(bus)]);
    if (originalBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = originalBusAddress;
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  };
};
