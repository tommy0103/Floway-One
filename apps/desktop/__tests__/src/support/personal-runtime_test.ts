import { expect, test } from 'vitest';

import { waitForDashboardBootstrapSession } from './personal-runtime.ts';

test('waits beyond the former ten-second boundary for a delayed Dashboard bootstrap', async () => {
  let elapsed = 0;
  let reads = 0;
  const token = await waitForDashboardBootstrapSession(
    () => {
      reads += 1;
      return elapsed > 10_000 ? 'owner-session' : undefined;
    },
    {
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
    },
  );

  expect(token).toBe('owner-session');
  expect(elapsed).toBe(10_050);
  expect(reads).toBe(202);
});

test('fails at the bounded deadline when the Dashboard never exchanges authority', async () => {
  let elapsed = 0;
  await expect(waitForDashboardBootstrapSession(
    () => undefined,
    {
      now: () => elapsed,
      sleep: async milliseconds => { elapsed += milliseconds; },
      timeoutMs: 100,
    },
  )).rejects.toThrow('Installed Dashboard did not exchange its one-time bootstrap authority');
  expect(elapsed).toBe(100);
});
