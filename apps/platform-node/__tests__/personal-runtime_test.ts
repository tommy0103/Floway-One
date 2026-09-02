import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PERSONAL_PORT,
  loadPersonalRuntime,
  resolveDefaultPersonalDataDir,
} from '../src/personal-runtime.ts';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'floway-one-runtime-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('personal runtime', () => {
  it('resolves each operating system application-data location', () => {
    expect(resolveDefaultPersonalDataDir('darwin', {}, '/Users/test')).toBe(
      '/Users/test/Library/Application Support/Floway One',
    );
    expect(resolveDefaultPersonalDataDir('linux', {}, '/home/test')).toBe('/home/test/.local/share/floway-one');
    expect(resolveDefaultPersonalDataDir('linux', { XDG_DATA_HOME: '/var/user-data' }, '/home/test')).toBe(
      '/var/user-data/floway-one',
    );
    expect(resolveDefaultPersonalDataDir('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test')).toBe(
      win32.join('C:\\Users\\test\\AppData\\Roaming', 'Floway One'),
    );
  });

  it('creates a stable loopback endpoint and complete private data layout', async () => {
    if (process.platform !== 'win32') await chmod(dataDir, 0o755);
    const runtime = loadPersonalRuntime({ dataDir, env: {} });

    expect(runtime).toMatchObject({
      profile: 'personal',
      hostname: '127.0.0.1',
      port: DEFAULT_PERSONAL_PORT,
      endpoint: 'http://127.0.0.1:8788',
      dataDir,
      databasePath: join(dataDir, 'floway.db'),
      filesDir: join(dataDir, 'files'),
      logsDir: join(dataDir, 'logs'),
      runtimeStatePath: join(dataDir, 'runtime.json'),
    });
    expect(JSON.parse(await readFile(runtime.runtimeStatePath, 'utf8'))).toEqual({ version: 1, port: 8788 });
    if (process.platform !== 'win32') {
      expect((await stat(runtime.dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(runtime.filesDir)).mode & 0o777).toBe(0o700);
      expect((await stat(runtime.logsDir)).mode & 0o777).toBe(0o700);
      expect((await stat(runtime.runtimeStatePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('persists an explicit port change and warns clients once', () => {
    loadPersonalRuntime({ dataDir, env: {} });
    const warn = vi.fn();

    const changed = loadPersonalRuntime({ dataDir, env: { PORT: '9876' }, warn });
    const restarted = loadPersonalRuntime({ dataDir, env: {}, warn });

    expect(changed.endpoint).toBe('http://127.0.0.1:9876');
    expect(restarted.port).toBe(9876);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Update configured client endpoints/));
  });

  it.each(['0', '65536', '1.5', 'random'])('rejects invalid explicit port %s', port => {
    expect(() => loadPersonalRuntime({ dataDir, env: { PORT: port } })).toThrow(/integer from 1 through 65535/);
  });

  it('preserves the parse error behind invalid persisted runtime state', async () => {
    await writeFile(join(dataDir, 'runtime.json'), '{');

    try {
      loadPersonalRuntime({ dataDir, env: {} });
      throw new Error('expected invalid runtime state to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/runtime state is invalid/);
      expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('preserves the operating system error behind an unusable data directory', async () => {
    const file = join(dataDir, 'not-a-directory');
    await writeFile(file, 'occupied');

    try {
      loadPersonalRuntime({ dataDir: join(file, 'Floway One'), env: {} });
      throw new Error('expected storage initialization to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cannot use application data directory/);
      expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('ENOTDIR');
    }
  });
});
