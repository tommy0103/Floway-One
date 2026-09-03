import { assert, test } from 'vitest';

import {
  resolveDefaultPersonalDataDir,
  resolvePersonalRuntimePaths,
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
    withXdgDataHome(undefined, () => resolveDefaultPersonalDataDir({ platform: 'linux', stableUserHome: '/home/stable' })),
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
  assertEquals(error.message, 'Floway One could not resolve the Windows Roaming AppData Known Folder');
  assertEquals(observedHresult, unavailable.hresult);
  assert(error.cause === unavailable);
});

test('Linux personal data follows an absolute XDG data root while the credential lock stays OS-user-global', () => {
  const paths = withXdgDataHome('/mnt/redirected-data', () => resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
  }));

  assertEquals(paths.dataDir, '/mnt/redirected-data/floway-one');
  assertEquals(
    paths.credentialLockDatabasePath,
    '/home/stable/.local/share/floway-one/credential-lock/device-master-key-v1.creation-lock.db',
  );
});

test('Linux ignores a relative XDG data root and falls back to the stable OS home', () => {
  const paths = withXdgDataHome('relative/data', () => resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
  }));

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
  const first = withXdgDataHome('/mnt/first', () => resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
  }));
  const second = withXdgDataHome('/mnt/second', () => resolvePersonalRuntimePaths({
    platform: 'linux',
    stableUserHome: '/home/stable',
  }));

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
