import { expect, it } from 'vitest';

import type { ApiKey, UpstreamRecord } from '../../../src/api/types';
import type { OverviewRegion } from '../../../src/components/overview/data';
import type { ActivationSnapshot } from '../../../src/components/quick-start/data';
import { currentObjective, deriveObjectives } from '../../../src/components/quick-start/objectives';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const region = <T>(value: T): OverviewRegion<T> => ({ value, failure: null });
const failedRegion = <T>(): OverviewRegion<T> => ({ value: null, failure: { at: 1, message: 'gateway unreachable' } });

const usableUpstream = { enabled: true, modelsCache: { fetchedAt: 1, lastError: null, modelCount: 3 } } as unknown as UpstreamRecord;
const usedKey = { last_used_at: '2026-09-01T00:00:00Z', dump_retention_seconds: null } as unknown as ApiKey;
const record = (status: number | null, error: DumpMetadata['error']) =>
  ({ kind: 'record', record: { status, error, startedAt: 1 } as unknown as DumpMetadata }) as const;

const snapshot = (overrides: Partial<ActivationSnapshot> = {}): ActivationSnapshot => ({
  gatheredAt: 0,
  health: region({ ok: true as const }),
  upstreams: region([]),
  keys: region([]),
  skill: region({ installed: false, clients: [] }),
  recentRequest: region({ kind: 'capture-off' }),
  ...overrides,
});

const objective = (snap: ActivationSnapshot, id: string) =>
  deriveObjectives(snap).find(entry => entry.id === id)!;

it('derives each objective from its own observable state', () => {
  const blank = deriveObjectives(snapshot());
  expect(blank.map(entry => [entry.id, entry.complete])).toEqual([
    ['gateway', true],
    ['skill', false],
    ['modelService', false],
    ['apiKey', false],
    ['agentSetup', false],
    ['firstRequest', false],
  ]);
  expect(currentObjective(blank)?.id).toBe('skill');

  const ready = snapshot({
    upstreams: region([usableUpstream]),
    keys: region([usedKey]),
    skill: region({ installed: true, clients: [{ agent: 'claude', installed: true, configured: true }] }),
  });
  expect(currentObjective(deriveObjectives(ready))).toBeNull();
});

it('surfaces a region failure on its objective and never completes from it', () => {
  const snap = snapshot({ health: failedRegion() });
  const gateway = objective(snap, 'gateway');
  expect(gateway.complete).toBe(false);
  expect(gateway.failure?.message).toBe('gateway unreachable');
  expect(currentObjective(deriveObjectives(snap))?.id).toBe('gateway');
});

it('counts only an enabled model service with listed models', () => {
  const disabled = snapshot({ upstreams: region([{ ...usableUpstream, enabled: false } as UpstreamRecord]) });
  expect(objective(disabled, 'modelService').complete).toBe(false);
  const empty = snapshot({ upstreams: region([{ ...usableUpstream, modelsCache: { fetchedAt: null, lastError: null, modelCount: null } } as UpstreamRecord]) });
  expect(objective(empty, 'modelService').complete).toBe(false);
});

it('treats a failed latest request as incomplete with its own diagnostic', () => {
  const failed = snapshot({ keys: region([usedKey]), recentRequest: region(record(500, { kind: 'failed', reason: 'connection reset' })) });
  const firstRequest = objective(failed, 'firstRequest');
  expect(firstRequest.complete).toBe(false);
  expect(firstRequest.detail).toBe('connection reset');

  const rejected = snapshot({ keys: region([usedKey]), recentRequest: region(record(400, null)) });
  expect(objective(rejected, 'firstRequest').detail).toBe('HTTP 400');

  const succeeded = snapshot({ recentRequest: region(record(200, null)) });
  expect(objective(succeeded, 'firstRequest').complete).toBe(true);
});

it('falls back to key usage when no request record is observable', () => {
  const unused = snapshot({ keys: region([{ ...usedKey, last_used_at: null } as ApiKey]) });
  expect(objective(unused, 'firstRequest').complete).toBe(false);

  const noRecords = snapshot({ keys: region([usedKey]), recentRequest: region({ kind: 'no-records' }) });
  expect(objective(noRecords, 'firstRequest').complete).toBe(true);
});
