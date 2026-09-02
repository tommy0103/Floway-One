import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { assertEquals } from '@floway-dev/test-utils';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLATFORM_NODE_ROOT = resolve(ROOT, 'apps/platform-node');
const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/device-master-key-lock-child.ts');
const children = new Set<ChildProcessWithoutNullStreams>();

const withTempState = async (operation: (state: { databasePath: string; credentialPath: string }) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-device-master-key-lock-'));
  try {
    const databasePath = join(directory, 'creation-lock.db');
    const credentialPath = join(directory, 'credential');
    await writeFile(databasePath, '');
    await operation({ databasePath, credentialPath });
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
  mode: 'create' | 'hold' | 'pause-after-write',
  databasePath: string,
  credentialPath: string,
  generatedByte: number,
): ChildProcessWithoutNullStreams => {
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, mode, databasePath, credentialPath, String(generatedByte)], {
    cwd: PLATFORM_NODE_ROOT,
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

test('spawned first-launch contenders serialize from an empty lock database and return one persisted key', () => withTempState(async state => {
  const workers = [1, 2, 3, 4].map(byte => spawnChild('create', state.databasePath, state.credentialPath, byte));
  const keys = await Promise.all(workers.map(waitForKey));

  assertEquals(new Set(keys).size, 1);
  assertEquals(Buffer.from(await readFile(state.credentialPath)).toString('hex'), keys[0]);
}));

test('process death releases the lock without a stale or partial owner record', () => withTempState(async state => {
  const crashed = spawnChild('hold', state.databasePath, state.credentialPath, 1);
  await waitForLine(crashed, /^LOCKED$/u);
  await killAndWait(crashed);

  const first = await waitForKey(spawnChild('create', state.databasePath, state.credentialPath, 2));
  const second = await waitForKey(spawnChild('create', state.databasePath, state.credentialPath, 3));
  assertEquals(first, second);
}));

test('a crash after persistence recovers the authoritative key', () => withTempState(async state => {
  const crashed = spawnChild('pause-after-write', state.databasePath, state.credentialPath, 9);
  await waitForLine(crashed, /^PERSISTED$/u);
  await killAndWait(crashed);

  const recovered = await waitForKey(spawnChild('create', state.databasePath, state.credentialPath, 10));
  assertEquals(recovered, '09'.repeat(32));
}));

test('a replacement owner survives an ABA schedule while a third process waits', () => withTempState(async state => {
  const staleOwner = spawnChild('hold', state.databasePath, state.credentialPath, 1);
  await waitForLine(staleOwner, /^LOCKED$/u);
  await killAndWait(staleOwner);

  const replacement = spawnChild('pause-after-write', state.databasePath, state.credentialPath, 11);
  await waitForLine(replacement, /^PERSISTED$/u);
  const contender = spawnChild('create', state.databasePath, state.credentialPath, 12);
  const contenderKeyPromise = waitForKey(contender);
  const earlyContender = await Promise.race([
    contenderKeyPromise.then(() => 'completed' as const),
    new Promise<'waiting'>(resolveWaiting => setTimeout(() => resolveWaiting('waiting'), 150)),
  ]);
  assertEquals(earlyContender, 'waiting');

  const replacementKeyPromise = waitForKey(replacement);
  await writeFile(`${state.credentialPath}.release-11`, 'continue');
  const [replacementKey, contenderKey] = await Promise.all([replacementKeyPromise, contenderKeyPromise]);
  assertEquals(replacementKey, '0b'.repeat(32));
  assertEquals(contenderKey, replacementKey);
}));
