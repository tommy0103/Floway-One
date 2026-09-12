import { afterEach, expect, test, vi } from 'vitest';

import { loadDesktopRuntimeStatus } from '../../src/api/desktop-runtime.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('accepts the exact packaged Dashboard compatibility version', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    compatibility: {
      contractDigest: 'a'.repeat(64),
      protocolVersion: 1,
      releaseVersion: '0.1.0',
    },
    service: 'floway',
    status: 'ok',
  })));

  await expect(loadDesktopRuntimeStatus()).resolves.toMatchObject({
    compatibility: { protocolVersion: 1, releaseVersion: '0.1.0' },
  });
});

test('leaves server and non-shell personal deployments unchanged', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  await expect(loadDesktopRuntimeStatus()).resolves.toBeNull();
});

test.each([
  { protocolVersion: 2, releaseVersion: '0.1.0' },
  { protocolVersion: 1, releaseVersion: '0.2.0' },
])('rejects incompatible desktop status $protocolVersion/$releaseVersion', async compatibility => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    compatibility: { contractDigest: 'a'.repeat(64), ...compatibility },
    service: 'floway',
    status: 'ok',
  })));

  await expect(loadDesktopRuntimeStatus()).rejects.toMatchObject({
    translationKey: 'common.errors.desktopCompatibilityMismatch',
  });
});
