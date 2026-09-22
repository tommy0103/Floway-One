import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import { advance, settle } from '../../settle';

const AUTHORIZE_URL_PATH = '/api/upstreams/codex/oauth/authorize-url';
const RELAY_RESULT_PATH = '/api/upstreams/codex/oauth/relay-result';

const oauth = (key: string) => i18n.t(`dashboard.upstreamEditor.oauth.${key}`);

// Only the generation is under test, so the material is handed out by the
// suite and the real stash / recall keep writing localStorage.
const { pkceResolvers } = vi.hoisted(() => ({
  pkceResolvers: [] as Array<(value: { verifier: string; challenge: string; state: string }) => void>,
}));

vi.mock('../../../src/components/upstream-editor/pkce', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/components/upstream-editor/pkce')>(),
  generatePkce: () => new Promise(resolve => { pkceResolvers.push(resolve); }),
}));

stubLocalStorage();

const material = (n: number) => ({ verifier: `verifier-${n}`, challenge: `challenge-${n}`, state: `state-${n}` });

const record = upstreamRecord('up_codex', {
  name: 'Codex',
  kind: 'codex',
  config: { accounts: [] },
  state: { accounts: [] },
});

let fetchMock: ReturnType<typeof vi.fn>;
let onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
let relayResult: () => Promise<Response>;
// Flips the authorize-url stub's `relay` answer for the fallback-path suite.
let relayArmed: boolean;

const authorizeBody = (): { challenge: string; state: string; verifier: string } => {
  const call = fetchMock.mock.calls.find(([input]) => String(input).includes(AUTHORIZE_URL_PATH));
  if (call === undefined) throw new Error('authorize-url was not requested');
  return JSON.parse(String(call[1]?.body)) as { challenge: string; state: string; verifier: string };
};

const relayPolls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(RELAY_RESULT_PATH)).length;

const openOAuthTab = async () => {
  renderInApp(<ProviderConfigHarness record={record} onPatch={onPatch} />);
  await settle();
  fireEvent.click(screen.getByRole('tab', { name: 'OAuth' }));
  await settle();
  pkceResolvers[0]!(material(1));
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  pkceResolvers.length = 0;
  onPatch = vi.fn<(patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void>();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url, 'http://localhost');
    if (pathname === AUTHORIZE_URL_PATH) {
      return Response.json({
        authorize_url: `https://auth.openai.com/oauth/authorize?state=${(await request.clone().json() as { state: string }).state}`,
        relay: relayArmed,
      });
    }
    if (pathname === RELAY_RESULT_PATH) return await relayResult();
    throw new Error(`Unexpected request to ${pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  relayResult = async () => Response.json({ status: 'pending' });
  relayArmed = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex OAuth relay completion', () => {
  it('posts the verifier, waits, and applies the relayed patch as persisted', async () => {
    await openOAuthTab();

    expect(authorizeBody().verifier).toBe('verifier-1');
    expect(screen.getByText(oauth('relayHint'))).toBeTruthy();
    expect(screen.getByText(oauth('relayWaiting'))).toBeTruthy();
    // The manual paste surface is gone while the automatic flow is armed.
    expect(screen.queryByText(oauth('callback'))).toBeNull();

    await advance(2000);
    expect(relayPolls()).toBe(1);

    relayResult = async () => Response.json({
      status: 'complete',
      patch: { config: { accounts: [{ email: 'alice@example.com' }] }, state: { accounts: [{ refresh_token: 'rt_relay' }] } },
    });
    await advance(2000);
    await settle();

    expect(onPatch).toHaveBeenCalledWith({
      config: { accounts: [{ email: 'alice@example.com' }] },
      state: { accounts: [{ refresh_token: 'rt_relay' }] },
    }, true);
    // The panel closes and the polling stops with it.
    expect(screen.queryByText(oauth('relayWaiting'))).toBeNull();
    await advance(8000);
    expect(relayPolls()).toBe(2);
  });

  it('falls back to the manual paste path with its hint when the runtime holds no relay', async () => {
    relayArmed = false;
    await openOAuthTab();

    expect(screen.getByText(oauth('manualHint'))).toBeTruthy();
    expect(screen.getByText(oauth('callback'))).toBeTruthy();
    await advance(8000);
    expect(relayPolls()).toBe(0);
  });

  it('surfaces a failed relay completion and restarts the flow on demand', async () => {
    await openOAuthTab();
    relayResult = async () => Response.json({ status: 'failed', message: 'upstream rejected the code' });

    await advance(2000);
    expect(screen.getByText('upstream rejected the code')).toBeTruthy();
    expect(screen.getByRole('button', { name: oauth('relayRestart') })).toBeTruthy();

    // Restart re-runs the flow against a pending session again.
    relayResult = async () => Response.json({ status: 'pending' });
    fireEvent.click(screen.getByRole('button', { name: oauth('relayRestart') }));
    await settle();
    pkceResolvers[pkceResolvers.length - 1]!(material(2));
    await settle();
    expect(screen.getByText(oauth('relayWaiting'))).toBeTruthy();
  });
});
