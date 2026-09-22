// Platform half of the Codex OAuth relay (issue #44): a minimal HTTP server
// on `127.0.0.1:1455` — the redirect URI port registered to the Codex CLI
// OAuth client, which no other Floway surface may move — that turns OpenAI's
// browser callback into a completed sign-in via the gateway's relay sessions.
//
// The port is held only while a sign-in is pending: the channel activates it
// when the dashboard starts a relay flow and releases it once no live session
// remains, so a real `codex login` in a terminal can bind the same port at
// any other time. When the port is already taken at activation time the
// channel reports failure and the dashboard falls back to its manual
// paste path.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  CODEX_REDIRECT_PORT,
  completeCodexRelayCallback,
  expireCodexRelaySessions,
  liveCodexRelaySessionCount,
  type CodexOAuthRelayChannel,
  type CodexRelayOutcome,
} from '@floway-dev/gateway';

// The port is owned by the Codex OAuth client registration (see
// CODEX_REDIRECT_URI in @floway-dev/provider-codex); tests may retarget it.
export const CODEX_OAUTH_RELAY_PORT = CODEX_REDIRECT_PORT;
const RELAY_CALLBACK_PATH = '/auth/callback';
const SWEEP_INTERVAL_MS = 5_000;
// Three consecutive empty sweeps (~15s) before letting go of the port, so a
// normal completion race (session consumed by its poll right after the
// callback) never tears the listener down between the two hops.
const EMPTY_SWEEPS_BEFORE_RELEASE = 3;

type Completer = typeof completeCodexRelayCallback;

export interface CodexOAuthRelayListenerDeps {
  complete?: Completer;
  expire?: typeof expireCodexRelaySessions;
  liveCount?: typeof liveCodexRelaySessionCount;
  port?: number;
  sweepIntervalMs?: number;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');

// The callback page renders in whatever browser finished the sign-in, so it
// carries both dashboard locales and no state of its own.
const relayPage = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Floway</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f5;color:#1a1a1a}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.1rem}p{font-size:.9rem;line-height:1.5}</style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`;

const pageFor = (outcome: CodexRelayOutcome): { status: number; html: string } => {
  switch (outcome.status) {
  case 'complete':
    return {
      status: 200,
      html: relayPage(
        'Sign-in complete | 登录完成',
        'You can close this window and return to Floway.<br>您可以关闭此窗口并返回 Floway。',
      ),
    };
  case 'failed':
    return {
      status: 200,
      html: relayPage(
        'Sign-in failed | 登录失败',
        `Floway could not complete the sign-in: ${escapeHtml(outcome.message)}<br>`
            + 'Return to Floway and restart the flow, or paste the callback URL manually.<br>'
            + '请返回 Floway 重新发起登录，或手动粘贴回调地址。',
      ),
    };
  default:
    return {
      status: 200,
      html: relayPage(
        'Sign-in link expired | 登录回链已失效',
        'This sign-in is no longer active. Return to Floway and restart the flow.<br>'
            + '该登录已失效。请返回 Floway 重新发起登录。',
      ),
    };
  }
};

const handleCallback = async (
  req: IncomingMessage,
  res: ServerResponse,
  complete: Completer,
  port: number,
): Promise<void> => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  // Loopback-only service addressed by the registered redirect URI: accept
  // exactly the localhost / loopback hosts that URI names. Anything else —
  // including rebinding names that resolve to 127.0.0.1 — is refused;
  // completing a flow still additionally requires its SPA-minted state.
  const host = (req.headers.host ?? '').toLowerCase();
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (req.method !== 'GET' || url.pathname !== RELAY_CALLBACK_PATH || !allowedHosts.has(host)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const outcome = code.length > 0 && state.length > 0
    ? await complete({ code, state })
    : ({ status: 'unknown' } as const);
  const page = pageFor(outcome);
  res.statusCode = page.status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(page.html);
};

export const createCodexOAuthRelayChannel = (deps: CodexOAuthRelayListenerDeps = {}): CodexOAuthRelayChannel => {
  const complete = deps.complete ?? completeCodexRelayCallback;
  const expire = deps.expire ?? expireCodexRelaySessions;
  const liveCount = deps.liveCount ?? liveCodexRelaySessionCount;
  const port = deps.port ?? CODEX_OAUTH_RELAY_PORT;
  const sweepIntervalMs = deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

  let server: Server | null = null;
  let sweeper: ReturnType<typeof setInterval> | null = null;
  let emptySweeps = 0;

  const stop = async (): Promise<void> => {
    if (sweeper !== null) {
      clearInterval(sweeper);
      sweeper = null;
    }
    const current = server;
    server = null;
    emptySweeps = 0;
    if (current === null) return;
    // In-flight callback responses are already rendered; anything lingering
    // (keep-alive sockets) must not pin close() open.
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      current.close(error => (error ? reject(error) : resolve()));
    });
  };

  const sweep = (): void => {
    expire();
    if (liveCount() > 0) {
      emptySweeps = 0;
      return;
    }
    emptySweeps += 1;
    if (emptySweeps >= EMPTY_SWEEPS_BEFORE_RELEASE) {
      void stop().catch(error => console.error('[codex-oauth-relay] release failed', error));
    }
  };

  return {
    activate: () => new Promise<boolean>(resolve => {
      if (server !== null) {
        resolve(true);
        return;
      }
      emptySweeps = 0;
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const next = createServer((req, res) => {
        void handleCallback(req, res, complete, port).catch(error => {
          console.error('[codex-oauth-relay] callback handling failed', error);
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
      });
      next.on('error', error => {
        if (!settled) {
          settle(false);
          next.close(() => {});
          return;
        }
        console.error('[codex-oauth-relay] listener error', error);
      });
      next.listen(port, '127.0.0.1', () => {
        server = next;
        sweeper = setInterval(sweep, sweepIntervalMs);
        settle(true);
      });
    }),
    release: stop,
  };
};
