import { get } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexOAuthRelayChannel,
} from '../src/codex-oauth-relay-listener.ts';
import type { CodexRelayOutcome } from '@floway-dev/gateway';
import { assertEquals } from '@floway-dev/test-utils';

interface ListenerHarness {
  activate: () => Promise<boolean>;
  release: () => Promise<void>;
}

const completeStub = (outcome: CodexRelayOutcome, calls: Array<{ code: string; state: string }> = []) =>
  async (input: { code: string; state: string }): Promise<CodexRelayOutcome> => {
    calls.push(input);
    return outcome;
  };

// node:http keeps the Host header fully under test control; fetch would let
// an off-loopback authority leak into real DNS. The connection always targets
// the harness's loopback port; `host` is only the header value.
const fetchPage = async (port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; contentType: string; body: string }> =>
  await new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, headers: { host } }, resp => {
      const chunks: Buffer[] = [];
      resp.on('data', chunk => chunks.push(chunk as Buffer));
      resp.on('end', () => resolve({
        status: resp.statusCode ?? 0,
        contentType: resp.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });

// A free port keeps these tests independent of whatever is running on 1455 on
// the host executing the suite.
const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:net');
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') reject(new Error('unexpected probe address'));
      else resolve(address.port);
    });
  });
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
};

const harnesses: ListenerHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.release();
  vi.restoreAllMocks();
});

const makeChannel = async (overrides: Parameters<typeof createCodexOAuthRelayChannel>[0] = {}): Promise<ListenerHarness> => {
  const harness = createCodexOAuthRelayChannel({ sweepIntervalMs: 5, ...overrides });
  harnesses.push(harness);
  return harness;
};

describe('Codex OAuth relay listener channel', () => {
  it('activates once, serves the callback page, and releases the port', async () => {
    const port = await freePort();
    const calls: Array<{ code: string; state: string }> = [];
    const channel = await makeChannel({
      port,
      complete: completeStub({ status: 'complete', patch: { config: {} as never, state: {} as never } }, calls),
      expire: () => {},
      liveCount: () => 1,
    });

    assertEquals(await channel.activate(), true);
    // A second activate while bound stays true without rebinding.
    assertEquals(await channel.activate(), true);

    const page = await fetchPage(port, '/auth/callback?code=BROWSER_CODE&state=RELAY_STATE');
    assertEquals(page.status, 200);
    assertEquals(page.contentType.includes('text/html'), true);
    assertEquals(page.body.includes('Sign-in complete'), true);
    assertEquals(page.body.includes('登录完成'), true);
    assertEquals(calls, [{ code: 'BROWSER_CODE', state: 'RELAY_STATE' }]);

    await channel.release();
    harnesses.length = 0;
    await expect(fetchPage(port, '/auth/callback?code=X&state=Y')).rejects.toThrow();
  });

  it('reports a failed completion with the escaped upstream message', async () => {
    const port = await freePort();
    const channel = await makeChannel({
      port,
      complete: completeStub({ status: 'failed', message: '<script>alert("x")</script>' }),
      expire: () => {},
      liveCount: () => 1,
    });
    assertEquals(await channel.activate(), true);

    const page = await fetchPage(port, '/auth/callback?code=BROWSER_CODE&state=RELAY_STATE');
    assertEquals(page.status, 200);
    assertEquals(page.body.includes('Sign-in failed'), true);
    assertEquals(page.body.includes('&lt;script&gt;'), true);
    assertEquals(page.body.includes('<script>'), false);
  });

  it('answers unknown for missing, stale, or malformed callbacks', async () => {
    const port = await freePort();
    const calls: Array<{ code: string; state: string }> = [];
    const channel = await makeChannel({
      port,
      complete: completeStub({ status: 'unknown' }, calls),
      expire: () => {},
      liveCount: () => 1,
    });
    assertEquals(await channel.activate(), true);

    const stale = await fetchPage(port, '/auth/callback?code=BROWSER_CODE&state=STALE');
    assertEquals(stale.body.includes('expired'), true);
    assertEquals(calls, [{ code: 'BROWSER_CODE', state: 'STALE' }]);

    const missingCode = await fetchPage(port, '/auth/callback?state=RELAY_STATE');
    assertEquals(missingCode.body.includes('expired'), true);
    assertEquals(calls.length, 1);

    assertEquals((await fetchPage(port, '/other')).status, 404);
    // A host header naming anything but the registered redirect host never
    // reaches the completer, even when it resolves to the same loopback.
    assertEquals((await fetchPage(port, '/auth/callback?code=X&state=Y', 'evil.example:1455')).status, 404);
    assertEquals(calls.length, 1);
  });

  it('refuses activation when the port is already bound (a real codex login, for example)', async () => {
    const port = await freePort();
    const { createServer } = await import('node:http');
    const occupant = createServer();
    await new Promise<void>(resolve => occupant.listen(port, '127.0.0.1', resolve));

    const channel = await makeChannel({
      port,
      complete: completeStub({ status: 'unknown' }),
      expire: () => {},
      liveCount: () => 1,
    });
    try {
      assertEquals(await channel.activate(), false);
      assertEquals(await channel.activate(), false);
    } finally {
      await new Promise<void>(resolve => occupant.close(() => resolve()));
    }
  });

  it('releases itself after repeated empty sweeps', async () => {
    const port = await freePort();
    const channel = await makeChannel({
      port,
      complete: completeStub({ status: 'unknown' }),
      expire: () => {},
      liveCount: () => 0,
    });
    assertEquals(await channel.activate(), true);
    // Three empty sweeps at a 5ms interval: poll the port until it closes.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        await fetchPage(port, '/other');
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch {
        return;
      }
    }
    throw new Error('relay listener did not release itself after empty sweeps');
  });
});
