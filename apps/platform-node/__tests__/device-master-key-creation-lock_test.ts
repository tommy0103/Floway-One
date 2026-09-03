import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { createDeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLATFORM_NODE_ROOT = resolve(ROOT, 'apps/platform-node');
const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/device-master-key-lock-child.ts');
const children = new Set<ChildProcessWithoutNullStreams>();

interface TempState {
  credentialPath: string;
  firstDatabasePath: string;
  lockDatabasePath: string;
  secondDatabasePath: string;
}

const withTempState = async (operation: (state: TempState) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-device-master-key-lock-'));
  try {
    const firstDatabasePath = join(directory, 'first-floway.db');
    const secondDatabasePath = join(directory, 'second-floway.db');
    const lockDatabasePath = join(directory, 'credential-lock', 'creation-lock.db');
    const credentialPath = join(directory, 'credential');
    await Promise.all([writeFile(firstDatabasePath, ''), writeFile(secondDatabasePath, '')]);
    await operation({ credentialPath, firstDatabasePath, lockDatabasePath, secondDatabasePath });
  } finally {
    await Promise.all([...children].map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    children.clear();
    await rm(directory, { recursive: true, force: true });
  }
};

const spawnChild = (
  mode: 'create' | 'hold' | 'pause-after-write' | 'same-process',
  databasePath: string,
  credentialPath: string,
  generatedByte: number,
  lockDatabasePath: string | null,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams => {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, mode, databasePath, credentialPath, String(generatedByte), lockDatabasePath ?? 'default'], {
    cwd: PLATFORM_NODE_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  return child;
};

const waitForLine = async (child: ChildProcessWithoutNullStreams, expected: RegExp): Promise<string> => await new Promise((resolveLine, rejectLine) => {
  let output = '';
  let errors = '';
  const timeout = setTimeout(() => rejectLine(new Error(`Timed out waiting for ${expected}\nstdout: ${output}\nstderr: ${errors}`)), 10_000);
  const inspect = (): void => {
    const line = output.split('\n').find(candidate => expected.test(candidate));
    if (line === undefined) return;
    clearTimeout(timeout);
    resolveLine(line);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; inspect(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', error => { clearTimeout(timeout); rejectLine(error); });
  child.once('exit', (code, signal) => {
    if (expected.test(output)) return;
    clearTimeout(timeout);
    rejectLine(new Error(`Child exited before ${expected} (${code ?? signal})\nstdout: ${output}\nstderr: ${errors}`));
  });
});

const waitForKey = async (child: ChildProcessWithoutNullStreams): Promise<string> => {
  const exited = once(child, 'exit');
  const line = await waitForLine(child, /^KEY [0-9a-f]{64}$/u);
  if (child.exitCode === null && child.signalCode === null) await exited;
  children.delete(child);
  return line.slice('KEY '.length);
};

const killAndWait = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  child.kill('SIGKILL');
  await once(child, 'exit');
  children.delete(child);
};

test('production default resolver gives divergent environments and two Floway databases one device-global lock', () => withTempState(async state => {
  const divergentEnvironment = (name: string): NodeJS.ProcessEnv => ({
    APPDATA: join(dirname(state.firstDatabasePath), `${name}-appdata`),
    HOME: join(dirname(state.firstDatabasePath), `${name}-home`),
    XDG_DATA_HOME: join(dirname(state.firstDatabasePath), `${name}-xdg`),
  });
  const owner = spawnChild(
    'pause-after-write',
    state.firstDatabasePath,
    state.credentialPath,
    1,
    null,
    divergentEnvironment('owner'),
  );
  const ownerLine = await waitForLine(owner, /^PERSISTED .+$/u);
  const contenders = [2, 3, 4].map((byte, index) => spawnChild(
    'create',
    index % 2 === 0 ? state.secondDatabasePath : state.firstDatabasePath,
    state.credentialPath,
    byte,
    null,
    divergentEnvironment(`contender-${byte}`),
  ));
  const contenderLines = await Promise.all(contenders.map(async child => await waitForLine(child, /^ATTEMPTING .+$/u)));
  const lockPaths = [ownerLine, ...contenderLines].map(line => line.slice(line.indexOf(' ') + 1));
  assertEquals(new Set(lockPaths).size, 1);
  assertEquals(lockPaths[0], resolvePersonalRuntimePaths().credentialLockDatabasePath);

  const keyPromises = [owner, ...contenders].map(waitForKey);
  await writeFile(`${state.credentialPath}.release-1`, 'continue');
  const keys = await Promise.all(keyPromises);
  assertEquals(new Set(keys).size, 1);
  assertEquals(Buffer.from(await readFile(state.credentialPath)).toString('hex'), keys[0]);
}));

test('two lock instances in one process serialize without blocking the event loop', () => withTempState(async state => {
  const child = spawnChild('same-process', state.firstDatabasePath, state.credentialPath, 1, state.lockDatabasePath);
  const order = await waitForLine(child, /^ORDER .+ SAME_PROCESS_SERIALIZED$/u);
  assertEquals(order, 'ORDER SECOND_ATTEMPTING SECOND_EXCLUDED SECOND_ENTERED SAME_PROCESS_SERIALIZED');
  await once(child, 'exit');
  children.delete(child);
}));

test('credential lock state is private to the current OS user', () => withTempState(async state => {
  const lock = createDeviceMasterKeyCreationLock({ lockDatabasePath: state.lockDatabasePath });
  await lock.run(async () => undefined);
  if (process.platform !== 'win32') {
    assertEquals((await stat(dirname(state.lockDatabasePath))).mode & 0o777, 0o700);
    assertEquals((await stat(state.lockDatabasePath)).mode & 0o777, 0o600);
  }
}));

test('process death releases the lock without a stale or partial owner record', () => withTempState(async state => {
  const crashed = spawnChild('hold', state.firstDatabasePath, state.credentialPath, 1, state.lockDatabasePath);
  await waitForLine(crashed, /^LOCKED .+$/u);
  await killAndWait(crashed);

  const first = await waitForKey(spawnChild('create', state.firstDatabasePath, state.credentialPath, 2, state.lockDatabasePath));
  const second = await waitForKey(spawnChild('create', state.secondDatabasePath, state.credentialPath, 3, state.lockDatabasePath));
  assertEquals(first, second);
}));

test('a crash after persistence recovers the authoritative key', () => withTempState(async state => {
  const crashed = spawnChild('pause-after-write', state.firstDatabasePath, state.credentialPath, 9, state.lockDatabasePath);
  await waitForLine(crashed, /^PERSISTED .+$/u);
  await killAndWait(crashed);

  const recovered = await waitForKey(spawnChild('create', state.secondDatabasePath, state.credentialPath, 10, state.lockDatabasePath));
  assertEquals(recovered, '09'.repeat(32));
}));

test('a replacement owner survives an ABA schedule while a third process waits', () => withTempState(async state => {
  const staleOwner = spawnChild('hold', state.firstDatabasePath, state.credentialPath, 1, state.lockDatabasePath);
  await waitForLine(staleOwner, /^LOCKED .+$/u);
  await killAndWait(staleOwner);

  const replacement = spawnChild('pause-after-write', state.firstDatabasePath, state.credentialPath, 11, state.lockDatabasePath);
  await waitForLine(replacement, /^PERSISTED .+$/u);
  const contender = spawnChild('create', state.secondDatabasePath, state.credentialPath, 12, state.lockDatabasePath);
  await waitForLine(contender, /^ATTEMPTING .+$/u);
  const contenderKeyPromise = waitForKey(contender);
  const probe = new DatabaseSync(state.lockDatabasePath);
  try {
    probe.exec('PRAGMA busy_timeout = 0');
    let busy: unknown;
    try { probe.exec('BEGIN IMMEDIATE'); } catch (error) { busy = error; }
    assert(busy instanceof Error && 'code' in busy && busy.code === 'ERR_SQLITE_ERROR');
    assertEquals(contender.exitCode, null);
  } finally {
    probe.close();
  }

  const replacementKeyPromise = waitForKey(replacement);
  await writeFile(`${state.credentialPath}.release-11`, 'continue');
  const [replacementKey, contenderKey] = await Promise.all([replacementKeyPromise, contenderKeyPromise]);
  assertEquals(replacementKey, '0b'.repeat(32));
  assertEquals(contenderKey, replacementKey);
}));
