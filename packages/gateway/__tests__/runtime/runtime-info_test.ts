import { afterEach, beforeEach, test } from 'vitest';

import { getRuntimeLocation, getRuntimeInfo } from '../../src/runtime/runtime-info.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
import { initEnv, initRuntimeKind, initRuntimeProfile } from '@floway-dev/platform';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

// vitest.setup primes the global env getter to return `''` for every key
// and the runtime kind to `'node'`; restore those defaults after each test so
// the cloudflare-runtime cases don't leak to neighbours.
afterEach(() => {
  initEnv(() => '');
  initRuntimeKind('node');
  initRuntimeProfile('server');
});

test('getRuntimeLocation on Cloudflare returns request.cf.colo, uppercased', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');
  Object.defineProperty(request, 'cf', { value: { colo: 'sjc' } });

  assertEquals(getRuntimeLocation(request), 'SJC');
});

test('getRuntimeLocation on Cloudflare throws when cf.colo is missing', () => {
  initRuntimeKind('cloudflare');
  const request = new Request('https://example.test');

  assertThrows(() => getRuntimeLocation(request), Error, 'request.cf.colo is missing');
});

test('getRuntimeLocation on Node uppercases RUNTIME_LOCATION when set', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'node-tokyo-1' : ''));

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'NODE-TOKYO-1');
});

test('getRuntimeLocation on Node defaults to LOCAL when RUNTIME_LOCATION is unset', () => {
  initEnv(() => undefined);

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'LOCAL');
});

test('getRuntimeLocation on Node defaults to LOCAL when RUNTIME_LOCATION is empty', () => {
  initEnv(() => '');

  assertEquals(getRuntimeLocation(new Request('https://example.test')), 'LOCAL');
});

test('getRuntimeInfo exposes the server profile and runtime facts', () => {
  initEnv(name => (name === 'RUNTIME_LOCATION' ? 'home' : ''));

  assertEquals(getRuntimeInfo(new Request('https://example.test')), {
    kind: 'node',
    profile: {
      mode: 'server',
      capabilities: {
        userManagement: true,
        remoteAccess: true,
        desktopIntegration: false,
      },
    },
    runtimeLocation: 'HOME',
  });
});

test('authenticated runtime information exposes an explicitly initialized personal profile on Node', async () => {
  const { adminSession } = await setupAppTest();
  initRuntimeProfile('personal');

  const response = await requestApp('/api/runtime-info', {
    headers: { 'x-floway-session': adminSession },
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    kind: 'node',
    profile: {
      mode: 'personal',
      capabilities: {
        userManagement: false,
        remoteAccess: false,
        desktopIntegration: true,
      },
    },
    runtimeLocation: 'LOCAL',
  });
});

beforeEach(() => {
  initRuntimeKind('node');
  initRuntimeProfile('server');
});
