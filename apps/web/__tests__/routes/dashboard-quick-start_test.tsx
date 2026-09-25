import { act, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

const { apiState, installPost } = vi.hoisted(() => {
  const blankClients = () => [
    { agent: 'claude', installed: true, configured: false },
    { agent: 'codex', installed: false, configured: false },
  ];
  const apiState = {
    upstreams: [] as unknown[],
    keys: [] as unknown[],
    skill: { installed: false, clients: blankClients() } as { installed: boolean; clients: unknown[] },
    blankClients,
  };
  const installPost = vi.fn(async (_request: { json: object }) => {
    apiState.skill = { installed: true, clients: blankClients() };
    return Response.json({ path: '/home/owner/.agents/skills/floway/SKILL.md' });
  });
  return { apiState, installPost };
});

vi.mock('../../src/api/client', () => ({
  api: {
    api: {
      health: { $get: async () => Response.json({ status: 'ok' }) },
      upstreams: { $get: async () => Response.json(apiState.upstreams) },
      keys: { $get: async () => Response.json(apiState.keys) },
      'agent-skill': {
        install: { $post: installPost },
        status: { $get: async () => Response.json(apiState.skill) },
      },
    },
  },
  callApi: async (request: () => Promise<Response>) => ({ data: await (await request()).json() }),
}));

import { loadActivationSnapshot } from '../../src/components/quick-start/data';
import DashboardQuickStart from '../../src/routes/dashboard-quick-start';
import { renderInApp } from '../render';

const renderPage = async () => {
  const loaderData = { snapshot: await loadActivationSnapshot() };
  const router = createMemoryRouter([
    { path: '/dashboard', Component: () => <div>Overview page</div> },
    {
      path: '/dashboard/quick-start',
      Component: () => <DashboardQuickStart loaderData={loaderData} matches={[] as never} params={{}} />,
    },
  ], { initialEntries: ['/dashboard/quick-start'] });
  renderInApp(<RouterProvider router={router} />);
  await act(async () => {});
  return router;
};

it('derives the current objective from gateway state and advances after install', async () => {
  apiState.upstreams = [];
  apiState.keys = [];
  apiState.skill = { installed: false, clients: apiState.blankClients() };
  await renderPage();

  expect(screen.getByRole('heading', { name: 'Quick Start' })).toBeTruthy();
  expect(screen.getByText('Gateway running')).toBeTruthy();
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.getByText('Current')).toBeTruthy();
  expect(screen.getByText('Install the Floway Skill')).toBeTruthy();
  expect(screen.queryByText('Set up Codex or Claude Code first')).toBeNull();

  await act(async () => { screen.getByRole('button', { name: 'Install Floway Skill' }).click(); });
  expect(installPost).toHaveBeenCalledWith({ json: {} });
  expect(screen.getByText(/Floway Skill installed at/)).toBeTruthy();
  // The page re-read the state the skill objective is derived from and moved
  // to the next one on its own, where the one recommended prompt covers the
  // whole remaining setup.
  expect(screen.getByText('Connect a model service')).toBeTruthy();
  expect(screen.getByText('In a new agent conversation, say:')).toBeTruthy();
  expect(screen.getByText('Use the Floway Skill to finish setting up Floway.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open Upstreams' })).toBeTruthy();
});

it('explains the prerequisite when no supported client is present', async () => {
  apiState.upstreams = [];
  apiState.keys = [];
  apiState.skill = {
    installed: false, clients: [
      { agent: 'claude', installed: false, configured: false },
      { agent: 'codex', installed: false, configured: false },
    ],
  };
  await renderPage();

  expect(screen.getByText('Set up Codex or Claude Code first')).toBeTruthy();
});

it('skips into the overview without completing activation', async () => {
  apiState.upstreams = [];
  apiState.keys = [];
  apiState.skill = { installed: false, clients: apiState.blankClients() };
  const router = await renderPage();

  await act(async () => { screen.getByRole('button', { name: 'Skip Quick Start' }).click(); });
  expect(router.state.location.pathname).toBe('/dashboard');
  expect(screen.getByText('Overview page')).toBeTruthy();
});

it('shows the completed state and enters the overview when every objective is observed', async () => {
  apiState.upstreams = [{ enabled: true, modelsCache: { fetchedAt: 1, lastError: null, modelCount: 2 } }];
  apiState.keys = [{ id: 'key-1', name: 'Agent key', last_used_at: '2026-09-24T00:00:00Z', dump_retention_seconds: null, upstream_ids: null }];
  apiState.skill = {
    installed: true, clients: [
      { agent: 'claude', installed: true, configured: true },
      { agent: 'codex', installed: false, configured: false },
    ],
  };
  const router = await renderPage();

  expect(screen.getByText('Setup complete')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Skip Quick Start' })).toBeNull();
  await act(async () => { screen.getByRole('button', { name: 'Open the overview' }).click(); });
  expect(router.state.location.pathname).toBe('/dashboard');
  expect(screen.getByText('Overview page')).toBeTruthy();
});
