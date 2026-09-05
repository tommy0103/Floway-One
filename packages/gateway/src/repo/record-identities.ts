import type { PerformanceDimensions, UsageRecord, WebSearchUsageRecord } from './types.ts';
import { canonicalPricingSelectorKey } from '@floway-dev/protocols/common';

export class InvalidMetricIdentityError extends TypeError {
  readonly name = 'InvalidMetricIdentityError';

  constructor(component: string) {
    super(`${component} must not contain NUL`);
  }
}

const metricStorageIdentity = (components: readonly (readonly [name: string, value: string | null])[]): string => {
  for (const [name, value] of components) {
    if (value?.includes('\0')) throw new InvalidMetricIdentityError(name);
  }
  return JSON.stringify(components.map(([, value]) => value));
};

export const normalizeUsageUpstream = (upstream: string | null): string | null =>
  upstream === null || upstream === '' ? null : upstream;

export const usageStorageIdentity = (record: {
  keyId: string; model: string; upstream: string | null; modelKey: string; hour: string; pricingSelectorKey: string;
}): string => metricStorageIdentity([
  ['usage.keyId', record.keyId],
  ['usage.model', record.model],
  ['usage.upstream', normalizeUsageUpstream(record.upstream)],
  ['usage.modelKey', record.modelKey],
  ['usage.hour', record.hour],
  ['usage.pricingSelector', record.pricingSelectorKey],
]);

export const usageRecordIdentity = (record: Pick<UsageRecord, 'keyId' | 'model' | 'upstream' | 'modelKey' | 'hour' | 'pricingSelector'>): string =>
  usageStorageIdentity({ ...record, pricingSelectorKey: canonicalPricingSelectorKey(record.pricingSelector) });

export const webSearchUsageRecordIdentity = (record: Pick<WebSearchUsageRecord, 'provider' | 'keyId' | 'action' | 'hour'>): string =>
  metricStorageIdentity([
    ['searchUsage.provider', record.provider],
    ['searchUsage.keyId', record.keyId],
    ['searchUsage.action', record.action],
    ['searchUsage.hour', record.hour],
  ]);

export const performanceRecordIdentity = (record: PerformanceDimensions): string =>
  metricStorageIdentity([
    ['performance.hour', record.hour],
    ['performance.keyId', record.keyId],
    ['performance.model', record.model],
    ['performance.upstream', record.upstream],
    ['performance.operation', record.operation],
    ['performance.runtimeLocation', record.runtimeLocation],
  ]);
