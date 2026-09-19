import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import packageManifest from '../../package.json' with { type: 'json' };
import type { OverviewSnapshot } from '../../src/components/overview/data';
import { copyToClipboard } from '../../src/components/ui/copy-to-clipboard';
import DashboardOverview, { clientLoader } from '../../src/routes/dashboard-overview';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

vi.mock('../../src/components/ui/copy-to-clipboard', () => ({ copyToClipboard: vi.fn(async () => true) }));

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
  vi.mocked(copyToClipboard).mockClear();
});

const PERSONAL_RUNTIME = {
  kind: 'node',
  profile: {
    mode: 'personal',
    capabilities: { userManagement: false, remoteAccess: false, desktopIntegration: true },
  },
  runtimeLocation: 'LOCAL',
};

const SERVER_RUNTIME = {
  kind: 'cloudflare',
  profile: {
    mode: 'server',
    capabilities: { userManagement: true, remoteAccess: true, desktopIntegration: false },
  },
  runtimeLocation: 'LOCAL',
};

const upstream = (id: string, options: { enabled?: boolean; lastError?: { message: string; at: number } | null } = {}) => ({
  id,
  name: `Upstream ${id}`,
  kind: 'copilot',
  enabled: options.enabled ?? true,
  hue: 210,
  modelsCache: { fetchedAt: 1, lastError: options.lastError ?? null, modelCount: 2 },
});

const apiKey = (id: string, options: { lastUsedAt?: string | null; dumpRetention?: number | null } = {}) => ({
  id,
  name: `Key ${id}`,
  key: `sk-${id}`,
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: options.lastUsedAt ?? null,
  upstream_ids: null,
  dump_retention_seconds: options.dumpRetention ?? null,
  responses_retention_seconds: 0,
});

const dumpRecord = (id: string, startedAt: number, overrides: Record<string, unknown> = {}) => ({
  id,
  startedAt,
  completedAt: startedAt + 12,
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  upstream: null,
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 5,
  requestBytes: 100,
  responseBytes: 200,
  durationMs: 12,
  error: null,
  ...overrides,
});

interface GatewayOverrides {
  health?: () => Response;
  keys?: () => Response;
  records?: Record<string, () => Response>;
  runtime?: () => Response;
  upstreams?: () => Response;
}

const stubOverviewGateway = (overrides: GatewayOverrides = {}) => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const { pathname: path } = url;
    if (path === '/api/runtime-info') return overrides.runtime?.() ?? Response.json(PERSONAL_RUNTIME);
    if (path === '/api/health') return overrides.health?.() ?? Response.json({ status: 'ok', service: 'floway' });
    if (path === '/api/upstreams') return overrides.upstreams?.() ?? Response.json([upstream('up-1')]);
    if (path === '/api/keys') return overrides.keys?.() ?? Response.json([apiKey('key-1', { dumpRetention: 3600 })]);
    const records = path.match(/^\/api\/dump\/keys\/([^/]+)\/records$/);
    if (records) return overrides.records?.[records[1]!]?.() ?? Response.json({ records: [] });
    throw new Error(`Unexpected request to ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const primeOwner = () => {
  useAuthStore.getState().primeFromLogin({
    token: 'owner-session',
    user: { id: 1, username: 'admin', isAdmin: true, upstreamIds: null },
  });
};

const redirectFrom = async (run: () => Promise<unknown>): Promise<Response> => {
  try {
    await run();
  } catch (error) {
    return error as Response;
  }
  throw new Error('Expected a redirect, but the loader returned');
};

describe('dashboard overview clientLoader', () => {
  it('lands personal mode on a snapshot of the local gateway', async () => {
    primeOwner();
    stubOverviewGateway({
      keys: () => Response.json([
        apiKey('key-1', { dumpRetention: 3600, lastUsedAt: '2026-08-04T10:00:00.000Z' }),
        apiKey('key-2', { dumpRetention: 3600, lastUsedAt: '2026-08-05T11:00:00.000Z' }),
        apiKey('key-3', { lastUsedAt: null }),
      ]),
      records: {
        'key-1': () => Response.json({ records: [dumpRecord('rec-old', 100)] }),
        'key-2': () => Response.json({ records: [dumpRecord('rec-new', 200)] }),
      },
      upstreams: () => Response.json([
        upstream('up-1'),
        upstream('up-2', { lastError: { message: 'upstream returned 401', at: 1 } }),
        upstream('up-3', { enabled: false, lastError: { message: 'stale', at: 1 } }),
      ]),
    });

    const data = await clientLoader();

    expect(data.endpoint).toBe(window.location.origin);
    expect(data.version).toBe(packageManifest.version);
    expect(data.snapshot.health).toEqual({ ok: true, error: null });
    // The disabled upstream's stale catalog error is operator history, not a
    // current failure.
    expect(data.snapshot.upstreams).toEqual({ total: 3, failing: 1 });
    expect(data.snapshot.keys).toEqual({ total: 3, lastUsedAt: '2026-08-05T11:00:00.000Z' });
    expect(data.snapshot.recentRequest).toEqual({ kind: 'record', record: dumpRecord('rec-new', 200) });
  });

  it('keeps the server-mode landing on the playground', async () => {
    primeOwner();
    const fetch = stubOverviewGateway({ runtime: () => Response.json(SERVER_RUNTIME) });

    const redirect = await redirectFrom(() => clientLoader());

    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/dashboard/playground');
    const requested = fetch.mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname);
    expect(requested).toEqual(['/api/runtime-info']);
  });

  it('fails the upstream region instead of reporting zero upstreams', async () => {
    primeOwner();
    stubOverviewGateway({ upstreams: () => Response.json({ error: 'upstream storage unavailable' }, { status: 500 }) });

    const data = await clientLoader();

    expect(data.snapshot.upstreams).toBeNull();
    expect(data.snapshot.upstreamsError).toBe('upstream storage unavailable');
  });

  it('fails the key and recent-request regions together when keys fail to load', async () => {
    primeOwner();
    stubOverviewGateway({ keys: () => Response.json({ error: 'key storage unavailable' }, { status: 500 }) });

    const data = await clientLoader();

    expect(data.snapshot.keys).toBeNull();
    expect(data.snapshot.keysError).toBe('key storage unavailable');
    expect(data.snapshot.recentRequest).toBeNull();
    expect(data.snapshot.recentRequestError).toBe('key storage unavailable');
  });

  it('marks the gateway unreachable when the health probe fails', async () => {
    primeOwner();
    stubOverviewGateway({ health: () => { throw new TypeError('fetch failed'); } });

    const data = await clientLoader();

    expect(data.snapshot.health.ok).toBe(false);
    expect(data.snapshot.health.error).toBe('fetch failed');
  });

  it('reports capture-off without probing records when no key retains dumps', async () => {
    primeOwner();
    const fetch = stubOverviewGateway({ keys: () => Response.json([apiKey('key-1'), apiKey('key-2')]) });

    const data = await clientLoader();

    expect(data.snapshot.recentRequest).toEqual({ kind: 'capture-off' });
    const requested = fetch.mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname);
    expect(requested.some(path => path.includes('/api/dump/'))).toBe(false);
  });

  it('fails the recent-request region when a record listing fails', async () => {
    primeOwner();
    stubOverviewGateway({
      keys: () => Response.json([apiKey('key-1', { dumpRetention: 3600 })]),
      records: { 'key-1': () => Response.json({ error: 'Key not found' }, { status: 404 }) },
    });

    const data = await clientLoader();

    expect(data.snapshot.recentRequest).toBeNull();
    expect(data.snapshot.recentRequestError).toBe('Key not found');
  });
});

const snapshot = (overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot => ({
  health: { ok: true, error: null },
  upstreams: { total: 2, failing: 1 },
  upstreamsError: null,
  keys: { total: 2, lastUsedAt: '2026-08-05T11:00:00.000Z' },
  keysError: null,
  recentRequest: { kind: 'record', record: dumpRecord('rec-1', Date.now() - 60_000) },
  recentRequestError: null,
  ...overrides,
});

const loaderData = (value: OverviewSnapshot = snapshot()) => ({
  endpoint: 'http://127.0.0.1:8788',
  version: packageManifest.version,
  snapshot: value,
});

const renderPage = (data: ReturnType<typeof loaderData>) => {
  const router = createMemoryRouter([{
    path: '/',
    children: [{
      index: true,
      Component: () => <DashboardOverview loaderData={data} matches={[] as never} params={{}} />,
    }],
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('dashboard overview rendering', () => {
  it('shows the gateway, upstreams, keys, recent request, and diagnostics entries', () => {
    renderPage(loaderData());

    expect(screen.getByRole('heading', { name: 'Gateway' })).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:8788')).toBeTruthy();
    expect(screen.getByText(packageManifest.version)).toBeTruthy();
    expect(screen.getByText('2 upstreams')).toBeTruthy();
    expect(screen.getAllByText('1 failing').length).toBeGreaterThan(0);
    expect(screen.getByText('2 API keys')).toBeTruthy();
    expect(screen.getByText('gpt-5')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open upstreams' }).getAttribute('href')).toBe('/dashboard/providers/upstreams');
    expect(screen.getByRole('link', { name: 'Open API Keys' }).getAttribute('href')).toBe('/dashboard/services/api-keys');
    expect(screen.getByRole('link', { name: 'Open requests' }).getAttribute('href')).toBe('/dashboard/monitor/requests');
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('href')).toBe('/dashboard/monitor/requests');
    expect(screen.getByRole('link', { name: 'Usage' }).getAttribute('href')).toBe('/dashboard/monitor/usage');
    expect(screen.getByRole('link', { name: 'Performance' }).getAttribute('href')).toBe('/dashboard/monitor/performance');
    // The log entry exists only where the desktop shell can answer it.
    expect(screen.queryByRole('link', { name: 'Open logs' })).toBeNull();
  });

  it('copies the bare endpoint without any credential', async () => {
    renderPage(loaderData());

    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint' }));

    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
    expect(vi.mocked(copyToClipboard).mock.calls[0]![0]).toBe('http://127.0.0.1:8788');
  });

  it('renders unreachable health and region failures as failures, never zeros', () => {
    renderPage(loaderData(snapshot({
      health: { ok: false, error: 'fetch failed' },
      upstreams: null,
      upstreamsError: 'upstream storage unavailable',
      keys: null,
      keysError: 'key storage unavailable',
      recentRequest: null,
      recentRequestError: 'key storage unavailable',
    })));

    expect(screen.getByText('Unreachable')).toBeTruthy();
    expect(screen.getByText('fetch failed')).toBeTruthy();
    expect(screen.getByText('upstream storage unavailable')).toBeTruthy();
    expect(screen.getAllByText('key storage unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('0 upstreams')).toBeNull();
    expect(screen.queryByText('0 API keys')).toBeNull();
  });

  it('states when request capture is off', () => {
    renderPage(loaderData(snapshot({ recentRequest: { kind: 'capture-off' } })));

    expect(screen.getByText('Request capture is off. Enable dump retention on an API key to record recent requests.')).toBeTruthy();
  });

  it('states a genuinely empty deployment without reading as a failure', () => {
    renderPage(loaderData(snapshot({
      upstreams: { total: 0, failing: 0 },
      keys: { total: 0, lastUsedAt: null },
      recentRequest: { kind: 'no-records' },
    })));

    expect(screen.getByText('No upstreams yet. Connect one to start routing requests.')).toBeTruthy();
    expect(screen.getByText('No API keys yet. Create one so clients can call this gateway.')).toBeTruthy();
    expect(screen.getByText('No requests recorded yet.')).toBeTruthy();
    expect(screen.getByText('0 upstreams')).toBeTruthy();
    expect(screen.queryByText('Unreachable')).toBeNull();
  });
});
