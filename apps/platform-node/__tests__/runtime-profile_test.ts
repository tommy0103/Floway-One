import { test } from 'vitest';

import { selectNodeRuntimeProfile } from '../src/runtime-profile.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('Node launcher defaults to server and exposes an explicit personal profile', () => {
  assertEquals(selectNodeRuntimeProfile([]), 'server');
  assertEquals(selectNodeRuntimeProfile(['--profile=server']), 'server');
  assertEquals(selectNodeRuntimeProfile(['--profile=personal']), 'personal');
});

test('Node launcher rejects unsupported or ambiguous profile arguments', () => {
  assertThrows(
    () => selectNodeRuntimeProfile(['--profile=desktop']),
    Error,
    'Unsupported Floway runtime profile: desktop',
  );
  assertThrows(
    () => selectNodeRuntimeProfile(['--profile=personal', '--profile=server']),
    Error,
    'Usage: Floway [--profile=server|personal]',
  );
});
