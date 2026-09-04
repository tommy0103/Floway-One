import type { PerformanceDimensions, UsageRecord, WebSearchUsageRecord } from './types.ts';
import { canonicalPricingSelectorKey } from '@floway-dev/protocols/common';

export const normalizeUsageUpstream = (upstream: string | null): string | null =>
  upstream === null || upstream === '' ? null : upstream;

export const usageStorageIdentity = (record: {
  keyId: string; model: string; upstream: string | null; modelKey: string; hour: string; pricingSelectorKey: string;
}): string => JSON.stringify([
  record.keyId,
  record.model,
  normalizeUsageUpstream(record.upstream),
  record.modelKey,
  record.hour,
  record.pricingSelectorKey,
]);

export const usageRecordIdentity = (record: Pick<UsageRecord, 'keyId' | 'model' | 'upstream' | 'modelKey' | 'hour' | 'pricingSelector'>): string =>
  usageStorageIdentity({ ...record, pricingSelectorKey: canonicalPricingSelectorKey(record.pricingSelector) });

export const webSearchUsageRecordIdentity = (record: Pick<WebSearchUsageRecord, 'provider' | 'keyId' | 'action' | 'hour'>): string =>
  JSON.stringify([record.provider, record.keyId, record.action, record.hour]);

export const performanceRecordIdentity = (record: PerformanceDimensions): string =>
  JSON.stringify([record.hour, record.keyId, record.model, record.upstream, record.operation, record.runtimeLocation]);
