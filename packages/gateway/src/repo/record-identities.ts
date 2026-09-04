import type { PerformanceDimensions, UsageRecord, WebSearchUsageRecord } from './types.ts';
import { canonicalPricingSelectorKey } from '@floway-dev/protocols/common';

export const usageRecordIdentity = (record: Pick<UsageRecord, 'keyId' | 'model' | 'upstream' | 'modelKey' | 'hour' | 'pricingSelector'>): string =>
  [record.keyId, record.model, record.upstream ?? '', record.modelKey, record.hour, canonicalPricingSelectorKey(record.pricingSelector)].join('\0');

export const webSearchUsageRecordIdentity = (record: Pick<WebSearchUsageRecord, 'provider' | 'keyId' | 'action' | 'hour'>): string =>
  [record.provider, record.keyId, record.action, record.hour].join('\0');

export const performanceRecordIdentity = (record: PerformanceDimensions): string =>
  [record.hour, record.keyId, record.model, record.upstream, record.operation, record.runtimeLocation].join('\0');
