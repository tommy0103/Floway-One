import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { PERSONAL_STDERR_LOG, PERSONAL_STDOUT_LOG } from '../src/personal-logging.ts';

const execFileAsync = promisify(execFile);
const PLATFORM_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/personal-logging-child.ts', import.meta.url));
const MAX_BYTES = 192;
const MAX_FILES = 3;

let logsDir: string;

beforeEach(async () => {
  logsDir = await mkdtemp(join(tmpdir(), 'floway-one-logs-'));
});

afterEach(async () => {
  await rm(logsDir, { recursive: true, force: true });
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
