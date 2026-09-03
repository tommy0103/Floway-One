import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  installPersonalLogging,
  PERSONAL_STDERR_LOG,
  PERSONAL_STDOUT_LOG,
} from '../src/personal-logging.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { initializePersonalStorage } from '../src/personal-storage.ts';

const execFileAsync = promisify(execFile);
const PLATFORM_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/personal-logging-child.ts', import.meta.url));
const FAILURE_CHILD = fileURLToPath(new URL('./fixtures/personal-logging-failure-child.ts', import.meta.url));
const ENTRY_FAILURE_CHILD = fileURLToPath(new URL('./fixtures/personal-entry-failure-child.ts', import.meta.url));
const MAX_BYTES = 192;
const MAX_FILES = 3;

let logsDir: string;

beforeEach(async () => {
  logsDir = await mkdtemp(join(tmpdir(), 'floway-one-logs-'));
});

afterEach(async () => {
  await rm(logsDir, { recursive: true, force: true });
});

test('personal logging consumes one initialized tree and hardens every rotated log-file incarnation', () => {
  const paths = resolvePersonalRuntimePaths({ dataDir: logsDir, platform: 'linux', stableUserHome: logsDir });
  const aclCalls: Array<{ kind: 'directory' | 'file' | 'tree'; path: string }> = [];
  const permissions = initializePersonalStorage(paths, {
    platform: 'win32',
    applyWindowsAcl: (path, kind) => aclCalls.push({ kind, path }),
  });
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  const installed = installPersonalLogging(paths.logsDir, {
    maxBytes: 16,
    maxFiles: 2,
    permissions,
    stderr,
    stdout,
  });
  try {
    stdout.write('first stdout payload');
    stdout.write('second stdout payload');
  } finally {
    installed.restore();
  }

  expect(aclCalls.filter(call => call.kind === 'tree')).toEqual([{ kind: 'tree', path: paths.dataDir }]);
  expect(aclCalls.filter(call => call.path === join(paths.logsDir, PERSONAL_STDOUT_LOG))).toHaveLength(2);
  expect(aclCalls.filter(call => call.path === join(paths.logsDir, PERSONAL_STDERR_LOG))).toHaveLength(1);
});

test('personal logging tees application streams into bounded rotating files', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    CHILD,
    logsDir,
    String(MAX_BYTES),
    String(MAX_FILES),
  ], { cwd: PLATFORM_ROOT });

  expect(stdout).toContain('application stdout 0');
  expect(stdout).toContain('raw stdout 0');
  expect(stderr).toContain('application stderr 0');
  expect(stderr).toContain('raw stderr 0');

  const files = await readdir(logsDir);
  const stdoutFiles = files.filter(file => file === PERSONAL_STDOUT_LOG || file.startsWith(`${PERSONAL_STDOUT_LOG}.`));
  const stderrFiles = files.filter(file => file === PERSONAL_STDERR_LOG || file.startsWith(`${PERSONAL_STDERR_LOG}.`));
  expect(stdoutFiles).toHaveLength(MAX_FILES);
  expect(stderrFiles).toHaveLength(MAX_FILES);

  for (const file of [...stdoutFiles, ...stderrFiles]) {
    const metadata = await stat(join(logsDir, file));
    expect(metadata.size).toBeLessThanOrEqual(MAX_BYTES);
    if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o600);
  }
  expect((await Promise.all(stdoutFiles.map(async file => await readFile(join(logsDir, file), 'utf8')))).join(''))
    .toContain('final application stdout');
  expect((await Promise.all(stderrFiles.map(async file => await readFile(join(logsDir, file), 'utf8')))).join(''))
    .toContain('final application stderr');
});

test('personal logging persists a fatal startup error chain before native process exit', async () => {
  const failure = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    FAILURE_CHILD,
    'startup',
    logsDir,
  ], { cwd: PLATFORM_ROOT }).then(
    () => null,
    (cause: unknown) => cause as Error & { code: number; stderr: string },
  );

  expect(failure).not.toBeNull();
  expect(failure?.code).not.toBe(0);
  expect(failure?.stderr).toContain('forced personal startup failure');

  const fatalLog = await readFile(join(logsDir, PERSONAL_STDERR_LOG), 'utf8');
  expect(fatalLog).toContain('FATAL: Floway One runtime failed');
  expect(fatalLog).toContain('Error: forced personal startup failure');
  expect(fatalLog).toContain('Error: forced migration failure');
  expect(fatalLog).toContain('Error: forced storage cause');
  expect(fatalLog.match(/Caused by:/g)).toHaveLength(2);
  expect(fatalLog).toContain('personal-logging-failure-child.ts');
});

test('personal logging forwards output and fails the runtime when its sink fails', async () => {
  const failure = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    FAILURE_CHILD,
    'sink',
    logsDir,
  ], { cwd: PLATFORM_ROOT }).then(
    () => null,
    (cause: unknown) => cause as Error & { code: number; stderr: string },
  );

  expect(failure).not.toBeNull();
  expect(failure?.code).not.toBe(0);
  expect(failure?.stderr).toContain('forwarded before forced sink failure');
  expect(failure?.stderr).toContain('Floway One could not write bounded log');
  expect(failure?.stderr).toContain(PERSONAL_STDERR_LOG);
  expect(failure?.stderr).toContain("code: 'EISDIR'");
  expect(failure?.stderr).toContain("syscall: 'open'");
  expect(failure?.stderr).toContain(join(logsDir, PERSONAL_STDERR_LOG));
  expect(failure?.stderr.indexOf('forwarded before forced sink failure')).toBeLessThan(
    failure?.stderr.indexOf('Floway One could not write bounded log') ?? -1,
  );
});

test.each([
  ['corrupt-state', 'runtime state is invalid', 'SyntaxError'],
  ['invalid-port', 'integer from 1 through 65535', null],
  ['state-write', 'could not persist runtime state', 'EISDIR'],
  ['migration', 'forced migration failure', 'forced SQLite cause'],
])('entry persists fatal personal %s initialization diagnostics', async (mode, expectedFailure, expectedCause) => {
  const failure = await execFileAsync(process.execPath, [
    '--import',
    'tsx',
    ENTRY_FAILURE_CHILD,
    mode,
    logsDir,
  ], { cwd: PLATFORM_ROOT }).then(
    () => null,
    (cause: unknown) => cause as Error & { code: number; stderr: string },
  );

  expect(failure).not.toBeNull();
  expect(failure?.code).not.toBe(0);
  expect(failure?.stderr).toContain(expectedFailure);
  if (expectedCause !== null) expect(failure?.stderr).toContain(expectedCause);
  const fatalLog = await readFile(join(logsDir, 'logs', PERSONAL_STDERR_LOG), 'utf8');
  expect(fatalLog.match(/FATAL: Floway One runtime failed/g)).toHaveLength(1);
  expect(fatalLog).toContain(expectedFailure);
  if (expectedCause !== null) {
    expect(fatalLog).toContain('Caused by:');
    expect(fatalLog).toContain(expectedCause);
  }
  expect(fatalLog).toContain('personal-entry-failure-child.ts');
});

test.each(['after-listen-server', 'after-listen-rejection'])(
  'entry persists one %s fatal diagnostic after the listener starts',
  async mode => {
    const failure = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      ENTRY_FAILURE_CHILD,
      mode,
      logsDir,
    ], { cwd: PLATFORM_ROOT }).then(
      () => null,
      (cause: unknown) => cause as Error & { code: number; stderr: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).not.toBe(0);
    expect(failure?.stderr).toContain(`forced ${mode} fatal failure`);
    expect(failure?.stderr).toContain('forced after-listen cause');
    const fatalLog = await readFile(join(logsDir, 'logs', PERSONAL_STDERR_LOG), 'utf8');
    expect(fatalLog.match(/FATAL: Floway One runtime failed/g)).toHaveLength(1);
    expect(fatalLog).toContain(`forced ${mode} fatal failure`);
    expect(fatalLog).toContain('forced after-listen cause');
    expect(fatalLog).toContain('personal-entry-failure-child.ts');
  },
);
