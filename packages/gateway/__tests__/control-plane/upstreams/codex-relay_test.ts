import { afterEach, test, vi } from 'vitest';

import {
  completeCodexRelayCallback,
  dropCodexRelaySession,
  expireCodexRelaySessions,
  initCodexOAuthRelayChannel,
  liveCodexRelaySessionCount,
} from '../../../src/control-plane/upstreams/codex-relay.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

const encodeBase64Url = (input: string): string =>
  btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fakeIdToken = (): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_test',
      chatgpt_user_id: 'usr_test',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': { email: 'alice@example.com' },
  }));
  return `${header}.${payload}.fake-signature`;
};

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const relayBody = (overrides: JsonObject = {}): JsonObject => ({
  record: {
    id: '',
    kind: 'codex',
    config: { accounts: [] },
    state: null,
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  },
  challenge: 'TEST_CHALLENGE',
  state: 'RELAY_STATE',
  verifier: 'RELAY_VERIFIER',
  ...overrides,
});

const relayResult = async (adminSession: string, state: string): Promise<Response> =>
  await requestApp(`/api/upstreams/codex/oauth/relay-result?state=${encodeURIComponent(state)}`, {
    headers: { 'x-floway-session': adminSession },
  });

// Every test leaves the global channel unregistered so later suites see the
// "no relay here" default that server and Cloudflare runtimes run with.
afterEach(() => {
  initCodexOAuthRelayChannel(null);
  vi.useRealTimers();
});

test('authorize-url without a verifier never arms the relay', async () => {
  const { adminSession } = await setupAppTest();
  const releases: number[] = [];
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => void releases.push(1) });

  const resp = await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, {
    record: { id: '', kind: 'codex', config: { accounts: [] }, state: null },
    challenge: 'TEST_CHALLENGE',
    state: 'RELAY_STATE',
  }));

  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { relay: boolean };
  assertEquals(body.relay, false);
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});

test('authorize-url without a relay channel answers relay:false and keeps the verifier SPA-held', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));

  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string; relay: boolean };
  assertEquals(new URL(body.authorize_url).searchParams.get('state'), 'RELAY_STATE');
  assertEquals(body.relay, false);
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});

test('authorize-url reports relay:false and drops the session when the port cannot be held', async () => {
  const { adminSession } = await setupAppTest();
  initCodexOAuthRelayChannel({ activate: async () => false, release: async () => {} });

  const resp = await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));

  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { relay: boolean };
  assertEquals(body.relay, false);
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});

test('an armed relay session waits as pending and completes into a persisted row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  // A persisted edit target, created through the SPA's exchange-then-save flow.
  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_seed', refresh_token: 'rt_seed', id_token: fakeIdToken(), expires_in: 600 }),
    async () => {
      const exchange = await requestApp('/api/upstreams/codex/oauth/exchange', authed(adminSession, {
        record: { id: '', kind: 'codex', config: { accounts: [] }, state: null, proxy_fallback_list: MOCKED_FETCH_EGRESS },
        callback: { code: 'SEED_CODE', verifier: 'SEED_VERIFIER' },
      }));
      assertEquals(exchange.status, 200);
      const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
      const create = await requestApp('/api/upstreams', authed(adminSession, {
        kind: 'codex',
        name: 'ChatGPT Codex',
        hue: 210,
        config: patch.config,
        state: patch.state,
        proxy_fallback_list: MOCKED_FETCH_EGRESS,
      }));
      assertEquals(create.status, 201);
    },
  );
  const rows = await repo.upstreams.list() as UpstreamRecord[];
  const record = rows.find(row => row.kind === 'codex');
  if (record === undefined) throw new Error('expected a persisted codex row');

  const armed = await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody({
    record: { id: record.id, kind: 'codex', config: { accounts: [] }, state: null, proxy_fallback_list: MOCKED_FETCH_EGRESS },
    state: 'RELAY_STATE',
  })));
  const armedBody = (await armed.json()) as { authorize_url: string; relay: boolean };
  assertEquals(armedBody.relay, true);
  assertEquals(new URL(armedBody.authorize_url).searchParams.get('state'), 'RELAY_STATE');

  const pending = (await (await relayResult(adminSession, 'RELAY_STATE')).json()) as JsonObject;
  assertEquals(pending.status, 'pending');

  // The browser lands on 1455 and the relay listener completes the flow.
  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_relay', refresh_token: 'rt_relay', id_token: fakeIdToken(), expires_in: 600 }),
    async () => {
      const outcome = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
      assertEquals(outcome.status, 'complete');
    },
  );

  const stored = await repo.upstreams.getById(record.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_relay');

  // The SPA collects the patch once; a second poll (or a repeated callback
  // delivery) finds nothing left to report.
  const collected = (await (await relayResult(adminSession, 'RELAY_STATE')).json()) as JsonObject;
  assertEquals(collected.status, 'complete');
  const collectedPatch = collected.patch as { state: { accounts: Array<{ refresh_token: string }> } };
  assertEquals(collectedPatch.state.accounts[0].refresh_token, 'rt_relay');
  const consumed = (await (await relayResult(adminSession, 'RELAY_STATE')).json()) as JsonObject;
  assertEquals(consumed.status, 'unknown');

  // No live session remains, so a registered channel may release the port.
  assertEquals(liveCodexRelaySessionCount(), 0);
});

test('a draft relay session completes without persisting and hands the patch to the SPA', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_draft', refresh_token: 'rt_draft', id_token: fakeIdToken(), expires_in: 600 }),
    async () => {
      const outcome = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
      assertEquals(outcome.status, 'complete');
    },
  );
  assertEquals(await repo.upstreams.list() as UpstreamRecord[], []);

  const collected = (await (await relayResult(adminSession, 'RELAY_STATE')).json()) as JsonObject;
  assertEquals(collected.status, 'complete');
  const patch = collected.patch as { state: { accounts: Array<{ refresh_token: string }> } };
  assertEquals(patch.state.accounts[0].refresh_token, 'rt_draft');
});

test('a failed relay completion surfaces its message once and does not persist', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));

  await withMockedFetch(
    () => jsonResponse({ error: 'invalid_grant' }, 400),
    async () => {
      const outcome = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
      assertEquals(outcome.status, 'failed');
    },
  );
  assertEquals(await repo.upstreams.list() as UpstreamRecord[], []);

  const collected = (await (await relayResult(adminSession, 'RELAY_STATE')).json()) as { status: string; message: string };
  assertEquals(collected.status, 'failed');
  assertEquals(collected.message.length > 0, true);
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});

test('relay completion is idempotent for a repeated callback delivery', async () => {
  const { adminSession } = await setupAppTest();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_relay', refresh_token: 'rt_relay', id_token: fakeIdToken(), expires_in: 600 }),
    async () => {
      const first = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
      const second = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
      assertEquals(first.status, 'complete');
      assertEquals(second.status, 'complete');
    },
  );
});

test('relay completion with a stale state answers unknown and touches nothing', async () => {
  const { adminSession } = await setupAppTest();

  const outcome = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'NO_SUCH_STATE' });
  assertEquals(outcome.status, 'unknown');
  assertEquals((await (await relayResult(adminSession, 'NO_SUCH_STATE')).json() as JsonObject).status, 'unknown');
});

test('expired relay sessions answer unknown and stop counting as live', async () => {
  const { adminSession } = await setupAppTest();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  vi.useFakeTimers();
  await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));
  assertEquals(liveCodexRelaySessionCount(), 1);

  vi.setSystemTime(Date.now() + 11 * 60 * 1000);
  expireCodexRelaySessions();
  assertEquals(liveCodexRelaySessionCount(), 0);
  vi.useRealTimers();

  const outcome = await completeCodexRelayCallback({ code: 'BROWSER_CODE', state: 'RELAY_STATE' });
  assertEquals(outcome.status, 'unknown');
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});

test('the relay-result route requires a dashboard admin session', async () => {
  await setupAppTest();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  const resp = await requestApp('/api/upstreams/codex/oauth/relay-result?state=RELAY_STATE', {});
  assertEquals(resp.status, 401);
});

test('dropCodexRelaySession removes an armed session without completing it', async () => {
  const { adminSession } = await setupAppTest();
  initCodexOAuthRelayChannel({ activate: async () => true, release: async () => {} });

  await requestApp('/api/upstreams/codex/oauth/authorize-url', authed(adminSession, relayBody()));
  assertEquals(liveCodexRelaySessionCount(), 1);
  dropCodexRelaySession('RELAY_STATE');
  assertEquals(liveCodexRelaySessionCount(), 0);
  assertEquals((await (await relayResult(adminSession, 'RELAY_STATE')).json() as JsonObject).status, 'unknown');
});
