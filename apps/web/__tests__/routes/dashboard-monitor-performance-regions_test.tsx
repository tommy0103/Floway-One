import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PerformanceOverviewResponse } from '../../src/components/performance/overview';
import DashboardMonitorPerformance from '../../src/routes/dashboard-monitor-performance';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

stubLocalStorage();

afterEach(() => { vi.unstubAllGlobals(); });

const overview: PerformanceOverviewResponse = {
  series: [],
  axes: { none: [], keyId: [], userId: [], model: [], upstream: [], operation: [], runtimeLocation: [] },
  dimensionValues: { models: [], upstreams: [], operations: [], runtimeLocations: ['LOCAL'], keyIds: [], userIds: [] },
  users: [],
  keys: [],
};

const runtimeInfo = (userManagement: boolean) => ({
  kind: 'node',
  profile: {
    mode: userManagement ? 'server' : 'personal',
    capabilities: { userManagement, remoteAccess: userManagement, desktopIntegration: !userManagement },
  },
  runtimeLocation: 'LOCAL',
});

type PerformanceLoaderData = Parameters<typeof DashboardMonitorPerformance>[0]['loaderData'];
type LoaderOverrides = Omit<Partial<PerformanceLoaderData>, 'state'> & {
  state?: Omit<Partial<PerformanceLoaderData['state']>, 'filters'> & {
    filters?: Partial<PerformanceLoaderData['state']['filters']>;
  };
};

const renderPage = (overrides: LoaderOverrides = {}) => {
  const base: PerformanceLoaderData = {
    currentUserId: '1',
    error: null,
    isAdmin: false,
    loadedAt: Date.UTC(2026, 7, 5, 12),
    overview,
    regionAvailable: false,
    state: {
      metric: 'ttft',
      percentile: 'p95',
      groupBy: 'model',
      range: 'today',
      filters: { model: [], upstream: [], operation: [], runtimeLocation: [], userId: [], keyId: [] },
      hidden: [],
    },
    upstreams: [],
    userDimensionAvailable: false,
  };
  const loaderData: PerformanceLoaderData = {
    ...base,
    ...overrides,
    state: {
      ...base.state,
      ...overrides.state,
      filters: { ...base.state.filters, ...overrides.state?.filters },
    },
  };
  const router = createMemoryRouter([{
    path: '/',
    Component: () => <DashboardMonitorPerformance loaderData={loaderData} matches={[] as never} params={{}} />,
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('Performance runtime dimensions', () => {
  it('hides Region controls and breakdowns outside Cloudflare', () => {
    renderPage();

    expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'By Region' })).toBeNull();
  });

  it('keeps Region controls and breakdowns on Cloudflare', () => {
    renderPage({ regionAvailable: true });

    expect(screen.getByRole('combobox', { name: 'Region' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'By Region' })).toBeTruthy();
  });

  it('renders capability-specific API key scope tooltips', async () => {
    const server = renderPage({
      isAdmin: true,
      state: { groupBy: 'keyId' },
      userDimensionAvailable: true,
    });
    const serverScope = screen.getByRole('button', { name: 'About API key telemetry scope' });
    fireEvent.pointerEnter(serverScope);
    expect((await screen.findByRole('tooltip')).textContent)
      .toBe('API key grouping and filters include only keys owned by your account. Choosing By API Key sets User to Only me; choosing another user clears API key filters and returns to By Model.');
    server.unmount();

    renderPage({ state: { groupBy: 'keyId' }, userDimensionAvailable: false });
    const personalScope = screen.getByRole('button', { name: 'About local-owner API key telemetry scope' });
    fireEvent.pointerEnter(personalScope);
    const copy = (await screen.findByRole('tooltip')).textContent ?? '';
    expect(copy).toBe('API key grouping and filters include keys owned by this local owner. Choosing By API Key keeps telemetry scoped to the local owner.');
    expect(copy).not.toMatch(/\bUser\b|Only me|another user/);
  });

  it('does not re-probe known capabilities', async () => {
    let overviewRequests = 0;
    let runtimeRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/runtime-info') {
        runtimeRequests += 1;
        return Response.json({ error: 'Unexpected discovery' }, { status: 500 });
      }
      if (path === '/api/performance/overview') {
        overviewRequests += 1;
        return Response.json(overview);
      }
      throw new Error(`Unexpected request to ${path}`);
    }));
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(overviewRequests).toBe(1));
    expect(runtimeRequests).toBe(0);
  });

  it('keeps telemetry idle when a capability retry still fails', async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      requestedPaths.push(path);
      if (path === '/api/runtime-info') return Response.json({ error: 'Unavailable' }, { status: 500 });
      throw new Error(`Unknown runtime reached ${path}`);
    }));
    renderPage({
      error: { status: 500, message: 'Unavailable' },
      overview: null,
      regionAvailable: null,
      upstreams: null,
      userDimensionAvailable: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(requestedPaths).toEqual(['/api/runtime-info']));
    expect(screen.getByText('This view could not be loaded')).toBeTruthy();
  });

  it('recovers server user grouping only after capability discovery', async () => {
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push(url);
      if (url.pathname === '/api/runtime-info') return Response.json(runtimeInfo(true));
      if (url.pathname === '/api/performance/overview') return Response.json(overview);
      if (url.pathname === '/api/upstream-options') return Response.json([]);
      throw new Error(`Unexpected request to ${url.pathname}`);
    }));
    renderPage({
      error: { status: 500, message: 'Unavailable' },
      isAdmin: true,
      overview: null,
      regionAvailable: null,
      state: { groupBy: 'userId' },
      upstreams: null,
      userDimensionAvailable: null,
    });

    expect(requests).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By User'));
    expect(requests.map(url => url.pathname)).toEqual([
      '/api/runtime-info',
      '/api/performance/overview',
      '/api/upstream-options',
    ]);
    expect(requests[1].searchParams.get('group_by')).toBe('userId');
  });

  it('normalizes personal user state before the first recovered telemetry request', async () => {
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push(url);
      if (url.pathname === '/api/runtime-info') return Response.json(runtimeInfo(false));
      if (url.pathname === '/api/performance/overview') return Response.json(overview);
      if (url.pathname === '/api/upstream-options') return Response.json([]);
      throw new Error(`Unexpected request to ${url.pathname}`);
    }));
    renderPage({
      error: { status: 500, message: 'Unavailable' },
      isAdmin: true,
      overview: null,
      regionAvailable: null,
      state: { groupBy: 'userId', hidden: ['2'], filters: { userId: ['2'] } },
      upstreams: null,
      userDimensionAvailable: null,
    });

    expect(requests).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));

    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Group by' }).value).toBe('By Model'));
    expect(requests.map(url => url.pathname)).toEqual([
      '/api/runtime-info',
      '/api/performance/overview',
      '/api/upstream-options',
    ]);
    expect(requests[1].searchParams.get('group_by')).toBe('model');
    expect(requests[1].searchParams.getAll('filter_user_id')).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'User' })).toBeNull();
  });

  it('reuses discovered capabilities when the first normalized overview fails', async () => {
    let overviewRequests = 0;
    let runtimeRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path === '/api/runtime-info') {
        runtimeRequests += 1;
        return Response.json(runtimeInfo(false));
      }
      if (path === '/api/performance/overview') {
        overviewRequests += 1;
        return overviewRequests === 1
          ? Response.json({ error: 'Corrected overview failed' }, { status: 500 })
          : Response.json(overview);
      }
      if (path === '/api/upstream-options') return Response.json([]);
      throw new Error(`Unexpected request to ${path}`);
    }));
    renderPage({
      isAdmin: true,
      overview: null,
      regionAvailable: null,
      state: { groupBy: 'userId' },
      upstreams: null,
      userDimensionAvailable: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(screen.getByText('Corrected overview failed')).toBeTruthy());
    expect(screen.getByText('This view could not be loaded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh performance' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy());
    expect(runtimeRequests).toBe(1);
    expect(overviewRequests).toBe(2);
  });
});
