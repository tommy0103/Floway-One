import type { Context } from 'hono';

import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { UpstreamModelsCache, UpstreamRecord } from '@floway-dev/provider';

export const reportModelsCacheWarmFailure = (
  record: Pick<UpstreamRecord, 'id'>,
  where: string,
  error: unknown,
): void => {
  console.error(`[models-cache] ${where} failed`, record.id, error);
};

// Scheduler for control-plane writes that happen outside any request (the
// OAuth relay completing on the platform listener's socket). Mirrors the
// Node entry's resolver: log rejections, because logging is the only signal
// a failed fire-and-forget task has.
export const fireAndForgetScheduler: BackgroundScheduler = promise => {
  promise.catch(err => console.error('[background]', err));
};

// Populate the SWR model cache synchronously after saving an upstream so the
// next dashboard read sees the new catalog. The cache layer persists upstream
// fetch failures in `lastError`; errors escaping that layer are internal and
// must remain observable without aborting the surrounding control-plane write.
//
// Returns what the row holds afterwards so the caller can answer with the
// freshness this warm produced rather than the snapshot it read before saving.
// Null when the upstream fetch failed and left the row with nothing to report.
export const warmModelsCacheCore = async (
  record: UpstreamRecord,
  scheduler: BackgroundScheduler,
  runtimeLocation: string,
): Promise<UpstreamModelsCache | null> => {
  const provider = createProvider(record);
  const fetcher = (await createPerRequestFetcher(runtimeLocation))(record.id);
  try {
    await fetchUpstreamModelsCached(provider, { scheduler, fetcher, force: true });
  } catch (error) {
    reportModelsCacheWarmFailure(record, 'warm', error);
  }
  // Read back rather than reconstructing: on the failure path the row keeps
  // whatever catalog it already had, annotated with this attempt's error.
  return (await getRepo().upstreams.getById(record.id))?.modelsCache ?? null;
};

export const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<UpstreamModelsCache | null> =>
  await warmModelsCacheCore(record, backgroundSchedulerFromContext(c), getRuntimeLocation(c.req.raw));
