import { api, callApi, type ApiResult } from '../../api/client';
import type { ApiKey } from '../../api/types';
import { errorMessage } from '../../lib/error-message';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

// A failure one region of the page is showing. `at` versions it: a background
// refresh may replace a reading only with a successful one, never with a
// failure that would quietly swap the message the operator has not read (see
// mergeOverviewSnapshot). A null message means the gateway answered outside
// its contract and has no words of its own to show.
export interface OverviewRegionFailure {
  at: number;
  message: string | null;
}

// One region of the overview: its reading, or the failure that replaced it.
// The two never stand together -- a failed region renders its failure, not a
// zero or a stale value beside it.
export interface OverviewRegion<T> {
  value: T | null;
  failure: OverviewRegionFailure | null;
}

// Every region fails on its own: a gateway that cannot list upstreams still
// answers its health probe, and the page states each outcome where the region
// sits rather than blanking the page or reporting zeros it does not have.
export interface OverviewSnapshot {
  gatheredAt: number;
  health: OverviewRegion<{ ok: true }>;
  upstreams: OverviewRegion<{ total: number; failing: number }>;
  keys: OverviewRegion<{ total: number; lastUsedAt: string | null }>;
  recentRequest: OverviewRegion<OverviewRecentRequest>;
}

export type OverviewRecentRequest =
  | { kind: 'record'; record: DumpMetadata }
  // A key retains dumps and none has been written yet.
  | { kind: 'no-records' }
  // No key retains dumps, which is the profile's default; the record region
  // says so instead of reading as an empty deployment.
  | { kind: 'capture-off' };

const gather = async <T>(load: () => Promise<T>): Promise<OverviewRegion<T>> => {
  try {
    return { value: await load(), failure: null };
  } catch (error) {
    return {
      value: null,
      failure: { at: Date.now(), message: error instanceof HealthContractError ? null : errorMessage(error) },
    };
  }
};

const unwrap = <T>(result: ApiResult<T>): T => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

export const loadOverviewSnapshot = async (signal?: AbortSignal): Promise<OverviewSnapshot> => {
  const [health, upstreams, keyRecords] = await Promise.all([
    gather(async () => {
      const data = unwrap(await callApi(() => api.api.health.$get({}, { init: { signal } })));
      // A 200 that is not the health contract is a failure with no message of
      // its own; the region renders the shared unavailable line for it.
      if (data.status !== 'ok') throw new HealthContractError();
      return { ok: true as const };
    }),
    gather(async () => unwrap(await callApi(() => api.api.upstreams.$get(undefined, { init: { signal } })))),
    gather(async () => unwrap(await callApi(() => api.api.keys.$get(undefined, { init: { signal } })))),
  ]);

  return {
    gatheredAt: Date.now(),
    health,
    upstreams: upstreams.value === null
      ? { value: null, failure: upstreams.failure }
      : {
          value: {
            total: upstreams.value.length,
            // The one failure an upstream reports on its own: its model catalog
            // could not be refreshed. A disabled upstream is operator intent and
            // counts nowhere.
            failing: upstreams.value.filter(record => record.enabled && record.modelsCache.lastError !== null).length,
          },
          failure: null,
        },
    keys: keyRecords.value === null
      ? { value: null, failure: keyRecords.failure }
      : {
          value: {
            total: keyRecords.value.length,
            lastUsedAt: keyRecords.value.map(key => key.last_used_at).reduce<string | null>(
              (latest, usedAt) => (usedAt !== null && (latest === null || usedAt > latest) ? usedAt : latest),
              null,
            ),
          },
          failure: null,
        },
    recentRequest: await loadRecentRequest(keyRecords, signal),
  };
};

// Marks the health-contract violation so its region carries no made-up
// message.
class HealthContractError extends Error {}

const loadRecentRequest = async (
  keyRecords: OverviewRegion<ApiKey[]>,
  signal?: AbortSignal,
): Promise<OverviewRegion<OverviewRecentRequest>> => {
  // The reading derives from the key list, so it inherits its failure rather
  // than probing records it cannot name.
  if (keyRecords.value === null) return { value: null, failure: keyRecords.failure };
  const retaining = keyRecords.value.filter(key => key.dump_retention_seconds !== null);
  if (retaining.length === 0) return { value: { kind: 'capture-off' }, failure: null };

  return await gather(async () => {
    const results = await Promise.all(retaining.map(key =>
      callApi(() => api.api.dump.keys[':keyId'].records.$get(
        { param: { keyId: key.id }, query: { limit: '1' } },
        { init: { signal } },
      ))));
    const latest = results
      .map(result => unwrap(result))
      .flatMap(data => data.records)
      .sort((a, b) => b.startedAt - a.startedAt)
      .at(0);
    return latest ? { kind: 'record', record: latest } : { kind: 'no-records' };
  });
};

// A background run must not clear a failure the operator has not read: a
// region already showing a failure keeps it while the new reading fails too,
// and only a successful reading replaces a shown failure. A foreground run
// (returning to the tab) commits everything, because a failure on it is one
// the operator is looking at.
export const mergeOverviewSnapshot = (
  current: OverviewSnapshot,
  next: OverviewSnapshot,
  { background }: { background: boolean },
): OverviewSnapshot => {
  if (!background) return next;
  return {
    gatheredAt: next.gatheredAt,
    health: mergeRegion(current.health, next.health),
    upstreams: mergeRegion(current.upstreams, next.upstreams),
    keys: mergeRegion(current.keys, next.keys),
    recentRequest: mergeRegion(current.recentRequest, next.recentRequest),
  };
};

const mergeRegion = <T>(current: OverviewRegion<T>, next: OverviewRegion<T>): OverviewRegion<T> =>
  next.failure !== null && current.failure !== null ? current : next;
