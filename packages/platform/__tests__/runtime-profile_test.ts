import { test, vi } from 'vitest';

import { getRuntimeProfile, initRuntimeProfile, type RuntimeProfileMode } from '../src/runtime-profile.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('personal profile disables server-only capabilities', () => {
  initRuntimeProfile('personal');

  assertEquals(getRuntimeProfile(), {
    mode: 'personal',
    capabilities: {
      userManagement: false,
      remoteAccess: false,
      desktopIntegration: true,
    },
  });
});

test('server profile preserves ordinary deployment capabilities', () => {
  initRuntimeProfile('server');

  assertEquals(getRuntimeProfile(), {
    mode: 'server',
    capabilities: {
      userManagement: true,
      remoteAccess: true,
      desktopIntegration: false,
    },
  });
});

test('invalid profile initialization fails visibly', () => {
  assertThrows(
    () => initRuntimeProfile('invalid' as RuntimeProfileMode),
    Error,
    'Unsupported runtime profile: invalid',
  );
});

test('reading the profile before initialization fails visibly', async () => {
  vi.resetModules();
  const uninitializedRegistry = await import('../src/runtime-profile.ts');

  assertThrows(
    () => uninitializedRegistry.getRuntimeProfile(),
    Error,
    'Runtime profile not initialized — call initRuntimeProfile() first',
  );
});
