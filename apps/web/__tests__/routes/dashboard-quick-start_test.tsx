import { act, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

const { installPost } = vi.hoisted(() => ({
  installPost: vi.fn(async (_request: { json: object }) => Response.json({ path: '/home/owner/.agents/skills/floway/SKILL.md' })),
}));
vi.mock('../../src/api/client', () => ({
  api: { api: { 'agent-skill': { install: { $post: installPost } } } },
  callApi: async (request: () => Promise<Response>) => ({ data: await (await request()).json() }),
}));

import DashboardQuickStart from '../../src/routes/dashboard-quick-start';
import { renderInApp } from '../render';

it('installs Floway Skill once from Quick Start without choosing an agent', async () => {
  const router = createMemoryRouter([{ path: '/dashboard/quick-start', Component: DashboardQuickStart }], {
    initialEntries: ['/dashboard/quick-start'],
  });
  renderInApp(<RouterProvider router={router} />);

  expect(screen.getByRole('heading', { name: 'Quick Start' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Codex' })).toBeNull();
  await act(async () => { screen.getByRole('button', { name: 'Install Floway Skill' }).click(); });
  expect(installPost).toHaveBeenCalledWith({ json: {} });
  expect(screen.getByText(/Floway Skill installed at/)).toBeTruthy();
});
