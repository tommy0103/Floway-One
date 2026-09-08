import { expect, test } from 'vitest';

import { waitForDashboardBootstrapSession } from './personal-runtime.ts';

const finishedDashboardLoad = 'FLOWAY_DESKTOP_PAGE_LOAD {"bootstrapAuthority":true,"event":"finished","route":"/","surface":"dashboard"}\n';
const completedBootstrap = 'FLOWAY_DASHBOARD_BOOTSTRAP {"phase":"completed"}\n';

test('starts the bootstrap deadline after a delayed initial WebView load', async () => {
  let elapsed = 0;
  let reads = 0;
  const token = await waitForDashboardBootstrapSession(
    () => `${elapsed >= 29_950 ? finishedDashboardLoad : ''}${elapsed >= 30_050 ? completedBootstrap : ''}`,
    () => {
      reads += 1;
      return 'owner-session';
    },
    {
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
    },
  );

  expect(token).toBe('owner-session');
  expect(elapsed).toBe(30_050);
  expect(reads).toBe(1);
});

test('fails at the bounded document-load deadline with captured app evidence', async () => {
  let elapsed = 0;
  await expect(waitForDashboardBootstrapSession(
    () => 'captured startup evidence',
    () => undefined,
    {
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
      timeoutMs: 100,
    },
  )).rejects.toThrow('Installed Dashboard did not finish loading its bootstrap document\ncaptured startup evidence');
  expect(elapsed).toBe(100);
});

test('fails at the bounded exchange deadline after the Dashboard document loads', async () => {
  let elapsed = 0;
  await expect(waitForDashboardBootstrapSession(
    () => finishedDashboardLoad,
    () => undefined,
    {
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
      timeoutMs: 100,
    },
  )).rejects.toThrow('Installed Dashboard did not complete its one-time bootstrap exchange after the document loaded');
  expect(elapsed).toBe(100);
});
