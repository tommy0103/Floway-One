// Codex OAuth relay sessions: the server-side half of the automatic
// localhost:1455 callback completion (issue #44).
//
// The registered `redirect_uri` (`http://localhost:1455/auth/callback`) is
// fixed to the Codex CLI OAuth client, so the OAuth browser always lands on
// port 1455. When the local runtime can hold that port, the SPA hands the
// PKCE verifier to the gateway at authorize-url time; this module keeps the
// pending sign-in in memory, the platform relay listener (personal profile
// only) completes it when OpenAI calls back, and the SPA learns the outcome
// by polling `GET /api/upstreams/codex/oauth/relay-result`.
//
// The verifier lives only in process memory and only on runtimes that
// registered a relay channel — never persisted, never logged. On Cloudflare
// (and any server profile) no channel exists, so nothing is stored and the
// dashboard keeps its SPA-held manual paste flow.

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { getRepo } from '../../repo/index.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { fireAndForgetScheduler, warmModelsCacheCore } from '../shared/warm-models-cache.ts';
import type { ProxyFallbackEntry, UpstreamRecord } from '@floway-dev/provider';
import {
  importCodexFromCallback,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
} from '@floway-dev/provider-codex';

// A sign-in that is not completed within ten minutes has lost its browser;
// the authorization code itself expires far sooner upstream. The SPA poll
// treats an expired session as `unknown` and asks the operator to restart.
const SESSION_TTL_MS = 10 * 60 * 1000;

// The platform half of the relay: bind `127.0.0.1:1455` while a flow is
// pending and let go as soon as none is. Personal runtimes register an
// implementation at startup; every other runtime keeps this null, which is
// what makes the whole feature opt-in by deployment shape.
export interface CodexOAuthRelayChannel {
  activate: () => Promise<boolean>;
  release: () => Promise<void>;
}

let relayChannel: CodexOAuthRelayChannel | null = null;

export const initCodexOAuthRelayChannel = (channel: CodexOAuthRelayChannel | null): void => {
  relayChannel = channel;
};

export const getCodexOAuthRelayChannel = (): CodexOAuthRelayChannel | null => relayChannel;

interface CodexRelaySession {
  verifier: string;
  // Only the envelope fields the completion needs: fetcher resolution reads
  // the in-progress proxy policy, and persistence targets the row by id.
  record: { id: string; kind: string; proxy_fallback_list?: readonly ProxyFallbackEntry[] };
  result: { config: CodexUpstreamConfig; state: CodexUpstreamState } | null;
  error: string | null;
  expiresAt: number;
}

// Keyed by the OAuth `state` — the value OpenAI echoes back verbatim on the
// callback, and the only capability a caller of the relay result endpoint
// needs. Random per flow, minted by the SPA.
const sessions = new Map<string, CodexRelaySession>();

export const expireCodexRelaySessions = (): void => {
  const now = Date.now();
  for (const [state, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(state);
  }
};

// Sessions still waiting for their browser. A completed session is no longer
// live even before the SPA collects its result, so the relay listener can
// release the port while the operator reads the success page.
export const liveCodexRelaySessionCount = (): number => {
  expireCodexRelaySessions();
  let count = 0;
  for (const session of sessions.values()) {
    if (session.result === null && session.error === null) count += 1;
  }
  return count;
};

export const stashCodexRelaySession = (input: {
  state: string;
  verifier: string;
  record: { id: string; kind: string; proxy_fallback_list?: readonly ProxyFallbackEntry[] };
}): void => {
  sessions.set(input.state, {
    verifier: input.verifier,
    record: input.record,
    result: null,
    error: null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
};

export const dropCodexRelaySession = (state: string): void => {
  sessions.delete(state);
};

export type CodexRelayOutcome =
  | { status: 'complete'; patch: { config: CodexUpstreamConfig; state: CodexUpstreamState } }
  | { status: 'failed'; message: string }
  | { status: 'pending' }
  | { status: 'unknown' };

// The SPA's answer to "did my sign-in land?". Terminal outcomes are consumed
// by the first poll (the session is gone afterwards); `pending` and
// `unknown` leave the map alone so a slow browser can still complete.
export const pollCodexRelayResult = (state: string): CodexRelayOutcome => {
  const session = sessions.get(state);
  if (session === undefined) return { status: 'unknown' };
  if (session.error !== null) {
    sessions.delete(state);
    return { status: 'failed', message: session.error };
  }
  if (session.result !== null) {
    sessions.delete(state);
    return { status: 'complete', patch: session.result };
  }
  return { status: 'pending' };
};

const releaseChannelWhenIdle = (): void => {
  if (relayChannel === null) return;
  if (liveCodexRelaySessionCount() > 0) return;
  void relayChannel.release().catch(error => console.error('[codex-oauth-relay] release failed', error));
};

// Runs on the platform relay listener's socket when OpenAI redirects the
// browser back to `http://localhost:1455/auth/callback`. Idempotent for a
// repeated callback delivery: a session that already holds an outcome answers
// with it again instead of exchanging a second time (the first authorization
// code was burned by that exchange anyway).
export const completeCodexRelayCallback = async (input: {
  code: string;
  state: string;
}): Promise<CodexRelayOutcome> => {
  expireCodexRelaySessions();
  const session = sessions.get(input.state);
  if (session === undefined) return { status: 'unknown' };
  if (session.result !== null) return { status: 'complete', patch: session.result };
  if (session.error !== null) return { status: 'failed', message: session.error };

  try {
    // The relay only exists on Node runtimes, where the runtime location
    // comes from the operator-set env var rather than a request property.
    const runtimeLocation = getRuntimeLocation(new Request('http://127.0.0.1/auth/callback'));
    const fetcher = await resolveControlPlaneFetcher({
      override: session.record.proxy_fallback_list,
      upstreamId: session.record.id || undefined,
      runtimeLocation,
    });
    const ingestion = await importCodexFromCallback({
      code: input.code,
      codeVerifier: session.verifier,
      fetcher,
    });

    if (session.record.id !== '') {
      const dbRecord = await getRepo().upstreams.getById(session.record.id);
      if (!dbRecord) throw new Error('Upstream not found');
      if (dbRecord.kind !== 'codex') throw new Error('Upstream is not a Codex upstream');
      const next: UpstreamRecord = {
        ...dbRecord,
        config: ingestion.config,
        state: ingestion.state,
        updatedAt: new Date().toISOString(),
      };
      await getRepo().upstreams.save(next);
      // Parity with the manual exchange route: a persisted import warms the
      // model cache so the next dashboard read sees the fresh catalog. The
      // relay has no request context, so the warm runs on the plain
      // fire-and-forget scheduler the Node runtime would have built anyway.
      await warmModelsCacheCore(next, fireAndForgetScheduler, runtimeLocation);
    }

    session.result = { config: ingestion.config, state: ingestion.state };
    releaseChannelWhenIdle();
    return { status: 'complete', patch: session.result };
  } catch (error) {
    session.error = error instanceof Error ? error.message : String(error);
    releaseChannelWhenIdle();
    return { status: 'failed', message: session.error };
  }
};
