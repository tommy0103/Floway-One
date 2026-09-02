import { assert, test } from 'vitest';

import {
  resolveDefaultPersonalDataDir,
  resolvePersonalRuntimePaths,
} from '../src/personal-runtime.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('POSIX personal application data uses the platform-standard suffix beneath the stable OS user home', () => {
  assertEquals(
    resolveDefaultPersonalDataDir({ platform: 'darwin', stableUserHome: '/Users/stable' }),
    '/Users/stable/Library/Application Support/Floway One',
  );
  assertEquals(
    resolveDefaultPersonalDataDir({ platform: 'linux', stableUserHome: '/home/stable' }),
    '/home/stable/.local/share/floway-one',
  );
});

test('Windows personal application data follows the operating-system Known Folder when it is redirected', () => {
  const paths = resolvePersonalRuntimePaths({
    platform: 'win32',
    resolveWindowsRoamingAppData: () => 'R:\\Redirected\\Roaming',
  });

  assertEquals(paths.dataDir, 'R:\\Redirected\\Roaming\\Floway One');
  assertEquals(
    paths.credentialLockDatabasePath,
    'R:\\Redirected\\Roaming\\Floway One\\credential-lock\\device-master-key-v1.creation-lock.db',
  );
});

test('Windows Known Folder lookup failures preserve the operating-system cause', () => {
  const unavailable = new Error('Windows Known Folder unavailable');

  let error: unknown;
  try {
    resolvePersonalRuntimePaths({
      platform: 'win32',
      resolveWindowsRoamingAppData: () => { throw unavailable; },
    });
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof Error);
  assertEquals(error.message, 'Floway One could not resolve the Windows Roaming AppData Known Folder');
  assert(error.cause === unavailable);
});

test('default personal paths ignore mutable HOME and application-data environment variables', () => {
  const before = resolvePersonalRuntimePaths();
  const previous = {
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.APPDATA = '/tmp/divergent-appdata';
  process.env.HOME = '/tmp/divergent-home';
  process.env.XDG_DATA_HOME = '/tmp/divergent-xdg';
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
