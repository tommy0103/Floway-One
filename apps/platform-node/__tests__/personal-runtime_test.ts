import { test } from 'vitest';

import {
  resolveDefaultPersonalDataDir,
  resolvePersonalRuntimePaths,
} from '../src/personal-runtime.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('personal application data uses the platform-standard suffix beneath the stable OS user profile', () => {
  assertEquals(
    resolveDefaultPersonalDataDir('darwin', '/Users/stable'),
    '/Users/stable/Library/Application Support/Floway One',
  );
  assertEquals(
    resolveDefaultPersonalDataDir('linux', '/home/stable'),
    '/home/stable/.local/share/floway-one',
  );
  assertEquals(
    resolveDefaultPersonalDataDir('win32', 'C:\\Users\\stable'),
    'C:\\Users\\stable\\AppData\\Roaming\\Floway One',
  );
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
