import { api, callApi } from '../../api/client';
import type { ApiKey } from '../../api/types';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

// Every region fails on its own: a gateway that cannot list upstreams still
// answers its health probe, and the page states each outcome where the region
// sits rather than blanking the page or reporting zeros it does not have.
export interface OverviewSnapshot {
  health: { ok: boolean; error: string | null };
  upstreams: { total: number; failing: number } | null;
  upstreamsError: string | null;
  keys: { total: number; lastUsedAt: string | null } | null;
  keysError: string | null;
  recentRequest: OverviewRecentRequest | null;
  recentRequestError: string | null;
}

export type OverviewRecentRequest =
  | { kind: 'record'; record: DumpMetadata }
  // A key retains dumps and none has been written yet.
  | { kind: 'no-records' }
  // No key retains dumps, which is the profile's default; the record region
  // says so instead of reading as an empty deployment.
  | { kind: 'capture-off' };

export const loadOverviewSnapshot = async (signal?: AbortSignal): Promise<OverviewSnapshot> => {
  const [healthResult, upstreamsResult, keysResult] = await Promise.all([
    callApi(() => api.api.health.$get({}, { init: { signal } })),
    callApi(() => api.api.upstreams.$get(undefined, { init: { signal } })),
    callApi(() => api.api.keys.$get(undefined, { init: { signal } })),
  ]);

  const upstreams = upstreamsResult.data ?? null;
  const keys = keysResult.data ?? null;

  return {
    health: healthResult.data?.status === 'ok'
      ? { ok: true, error: null }
      : { ok: false, error: healthResult.error?.message ?? null },
    upstreams: upstreams === null
      ? null
      : {
          total: upstreams.length,
          // The one failure an upstream reports on its own: its model catalog
          // could not be refreshed. A disabled upstream is operator intent and
          // counts nowhere.
          failing: upstreams.filter(record => record.enabled && record.modelsCache.lastError !== null).length,
        },
    upstreamsError: upstreamsResult.error?.message ?? null,
    keys: keys === null
      ? null
      : {
          total: keys.length,
          lastUsedAt: keys.map(key => key.last_used_at).reduce<string | null>(
            (latest, usedAt) => (usedAt !== null && (latest === null || usedAt > latest) ? usedAt : latest),
            null,
          ),
        },
    keysError: keysResult.error?.message ?? null,
    ...(await loadRecentRequest(keys, keysResult.error?.message ?? null, signal)),
  };
};

const loadRecentRequest = async (
  keys: ApiKey[] | null,
  keysError: string | null,
  signal?: AbortSignal,
): Promise<Pick<OverviewSnapshot, 'recentRequest' | 'recentRequestError'>> => {
  if (keys === null) return { recentRequest: null, recentRequestError: keysError };
  const retaining = keys.filter(key => key.dump_retention_seconds !== null);
  if (retaining.length === 0) return { recentRequest: { kind: 'capture-off' }, recentRequestError: null };

  const results = await Promise.all(retaining.map(key =>
    callApi(() => api.api.dump.keys[':keyId'].records.$get(
      { param: { keyId: key.id }, query: { limit: '1' } },
      { init: { signal } },
    ))));
  const failed = results.find(result => result.error);
  if (failed?.error) return { recentRequest: null, recentRequestError: failed.error.message };

  const latest = results
    .flatMap(result => result.data?.records ?? [])
    .sort((a, b) => b.startedAt - a.startedAt)
    .at(0);
  return {
    recentRequest: latest ? { kind: 'record', record: latest } : { kind: 'no-records' },
    recentRequestError: null,
  };
};
