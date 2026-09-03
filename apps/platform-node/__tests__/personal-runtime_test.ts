import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, assert, beforeEach, expect, test, vi } from 'vitest';

import {
  DEFAULT_PERSONAL_PORT,
  loadPersonalRuntime,
  resolveDefaultPersonalDataDir,
  resolvePersonalRuntimePaths,
  type PersonalRuntimePaths,
} from '../src/personal-runtime.ts';
import { assertEquals } from '@floway-dev/test-utils';

const withXdgDataHome = <T>(value: string | undefined, operation: () => T): T => {
  const previous = process.env.XDG_DATA_HOME;
  if (value === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = value;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  }
};

test('POSIX personal application data uses the platform-standard suffix beneath the stable OS user home', () => {
  assertEquals(
    resolveDefaultPersonalDataDir({ platform: 'darwin', stableUserHome: '/Users/stable' }),
    '/Users/stable/Library/Application Support/Floway One',
  );
  assertEquals(
    resolveDefaultPersonalDataDir({ platform: 'linux', stableUserHome: '/home/stable', env: {} }),
    '/home/stable/.local/share/floway-one',
  );
});

test('Windows personal application data follows the operating-system Known Folder when it is redirected', () => {
  const paths = resolvePersonalRuntimePaths({
    platform: 'win32',
    windowsKnownFolders: {
      resolveRoamingAppData: () => ({ hresult: 0, path: 'R:\\Redirected\\Roaming' }),
      throwForHresult: hresult => { throw new Error(`Unexpected HRESULT ${hresult}`); },
    },
  });

  assertEquals(paths.dataDir, 'R:\\Redirected\\Roaming\\Floway One');
  assertEquals(
    paths.credentialLockDatabasePath,
    'R:\\Redirected\\Roaming\\Floway One\\credential-lock\\device-master-key-v1.creation-lock.db',
  );
});

test('Windows Known Folder lookup failures preserve the operating-system cause', () => {
  const unavailable = Object.assign(new Error('Access is denied'), { hresult: -2147024891 });
  let observedHresult: number | undefined;

  let error: unknown;
  try {
    resolvePersonalRuntimePaths({
      platform: 'win32',
      windowsKnownFolders: {
        resolveRoamingAppData: () => ({ hresult: unavailable.hresult, path: null }),
        throwForHresult: hresult => {
          observedHresult = hresult;
          throw unavailable;
        },
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof Error);
  assertEquals(error.message, 'Floway could not resolve the Windows Roaming AppData Known Folder');
  assertEquals(observedHresult, unavailable.hresult);
  assert(error.cause === unavailable);
});

test('Linux personal data follows an absolute XDG data root while the credential lock stays OS-user-global', () => {
  const paths = resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
    env: { XDG_DATA_HOME: '/mnt/redirected-data' },
  });

  assertEquals(paths.dataDir, '/mnt/redirected-data/floway-one');
  assertEquals(
    paths.credentialLockDatabasePath,
    '/home/stable/.local/share/floway-one/credential-lock/device-master-key-v1.creation-lock.db',
  );
});

test('Linux ignores a relative XDG data root and falls back to the stable OS home', () => {
  const paths = resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
    env: { XDG_DATA_HOME: 'relative/data' },
  });

  assertEquals(paths.dataDir, '/home/stable/.local/share/floway-one');
});

test('Linux falls back to the stable OS home when XDG data root is unset', () => {
  const paths = withXdgDataHome(undefined, () => resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
  }));

  assertEquals(paths.dataDir, '/home/stable/.local/share/floway-one');
});

test('distinct absolute Linux XDG data roots share one device-global credential lock', () => {
  const first = resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
    env: { XDG_DATA_HOME: '/mnt/first' },
  });
  const second = resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
    env: { XDG_DATA_HOME: '/mnt/second' },
  });

  assertEquals(first.dataDir, '/mnt/first/floway-one');
  assertEquals(second.dataDir, '/mnt/second/floway-one');
  assertEquals(first.credentialLockDatabasePath, second.credentialLockDatabasePath);
});

test('default personal paths ignore mutable HOME and APPDATA environment variables', () => {
  const before = resolvePersonalRuntimePaths();
  const previous = {
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
  };
  process.env.APPDATA = '/tmp/divergent-appdata';
  process.env.HOME = '/tmp/divergent-home';
  try {
    assertEquals(resolvePersonalRuntimePaths(), before);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a test data override never changes the device-global credential lock identity', () => {
  const first = resolvePersonalRuntimePaths({ dataDir: '/tmp/first', stableUserHome: '/home/stable', platform: 'linux' });
  const second = resolvePersonalRuntimePaths({ dataDir: '/tmp/second', stableUserHome: '/home/stable', platform: 'linux' });

  assertEquals(first.databasePath, '/tmp/first/floway.db');
  assertEquals(second.databasePath, '/tmp/second/floway.db');
  assertEquals(first.credentialLockDatabasePath, second.credentialLockDatabasePath);
  assertEquals(first.credentialLockDatabasePath, '/home/stable/.local/share/floway-one/credential-lock/device-master-key-v1.creation-lock.db');
});

let dataDir: string;

const runtimePaths = (root: string = dataDir): PersonalRuntimePaths => ({
  dataDir: root,
  databasePath: join(root, 'floway.db'),
  filesDir: join(root, 'files'),
  logsDir: join(root, 'logs'),
  runtimeStatePath: join(root, 'runtime.json'),
  credentialLockDatabasePath: join(root, 'credential-lock', 'device-master-key-v1.creation-lock.db'),
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'floway-one-runtime-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('personal runtime creates a stable loopback endpoint and complete private data layout', async () => {
  if (process.platform !== 'win32') await chmod(dataDir, 0o755);
  const hardenedFiles: string[] = [];
  const runtime = loadPersonalRuntime({
    paths: runtimePaths(),
    env: {},
    permissions: {
      ensureDirectory: () => {},
      hardenFile: path => hardenedFiles.push(path),
      hardenSqliteFiles: () => {},
    },
  });

  expect(runtime).toMatchObject({
    profile: 'personal',
    hostname: '127.0.0.1',
    port: DEFAULT_PERSONAL_PORT,
    endpoint: 'http://127.0.0.1:8788',
    ...runtimePaths(),
  });
  expect(JSON.parse(await readFile(runtime.runtimeStatePath, 'utf8'))).toEqual({ version: 1, port: 8788 });
  expect(hardenedFiles).toEqual([runtime.runtimeStatePath]);
  if (process.platform !== 'win32') {
    expect((await stat(runtime.dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.filesDir)).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.logsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(runtime.runtimeStatePath)).mode & 0o777).toBe(0o600);
  }
});

test('personal path resolution does not load or write runtime state', async () => {
  const paths = resolvePersonalRuntimePaths({ dataDir });

  expect(paths).toMatchObject({
    dataDir,
    databasePath: join(dataDir, 'floway.db'),
    filesDir: join(dataDir, 'files'),
    logsDir: join(dataDir, 'logs'),
    runtimeStatePath: join(dataDir, 'runtime.json'),
  });
  await expect(readFile(paths.runtimeStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('personal runtime persists an explicit port change and warns clients once', () => {
  const paths = runtimePaths();
  loadPersonalRuntime({ paths, env: {} });
  const warn = vi.fn();

  const changed = loadPersonalRuntime({ paths, env: { PORT: '9876' }, warn });
  const restarted = loadPersonalRuntime({ paths, env: {}, warn });

  expect(changed.endpoint).toBe('http://127.0.0.1:9876');
  expect(restarted.port).toBe(9876);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Update configured client endpoints/));
});

test.each(['0', '65536', '1.5', 'random'])('personal runtime rejects invalid explicit port %s', port => {
  expect(() => loadPersonalRuntime({ paths: runtimePaths(), env: { PORT: port } })).toThrow(/integer from 1 through 65535/);
});

test('personal runtime preserves the parse error behind invalid persisted runtime state', async () => {
  await writeFile(join(dataDir, 'runtime.json'), '{');

  try {
    loadPersonalRuntime({ paths: runtimePaths(), env: {} });
    throw new Error('expected invalid runtime state to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/runtime state is invalid/);
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
  }
});

test('personal runtime preserves the operating-system error behind an unusable data directory', async () => {
  const file = join(dataDir, 'not-a-directory');
  await writeFile(file, 'occupied');

  try {
    loadPersonalRuntime({ paths: runtimePaths(join(file, 'Floway One')), env: {} });
    throw new Error('expected storage initialization to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cannot use application data directory/);
    expect((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBe('ENOTDIR');
  }
});
