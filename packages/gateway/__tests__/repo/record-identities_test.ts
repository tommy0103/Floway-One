import { expect, test } from 'vitest';

import { performanceRecordIdentity, usageRecordIdentity, webSearchUsageRecordIdentity } from '../../src/repo/record-identities.ts';

test('usage storage identity normalizes null and empty upstream exactly once', () => {
  const base = { keyId: 'key', model: 'model', modelKey: 'model-key', hour: '2026-01-01T00', pricingSelector: {} };
  expect(usageRecordIdentity({ ...base, upstream: null })).toBe(usageRecordIdentity({ ...base, upstream: '' }));
});

test('metric storage identities are collision-safe for unrestricted string dimensions', () => {
  const usage = { upstream: null, modelKey: 'key', hour: 'hour', pricingSelector: {} };
  expect(usageRecordIdentity({ ...usage, keyId: 'a', model: 'b\0c' }))
    .not.toBe(usageRecordIdentity({ ...usage, keyId: 'a\0b', model: 'c' }));

  const search = { provider: 'tavily' as const, action: 'search' as const };
  expect(webSearchUsageRecordIdentity({ ...search, keyId: 'a', hour: 'b\0c' }))
    .not.toBe(webSearchUsageRecordIdentity({ ...search, keyId: 'a\0b', hour: 'c' }));

  const performance = { upstream: 'upstream', operation: 'chat' as const, runtimeLocation: 'LOCAL', hour: '2026-01-01T00' };
  expect(performanceRecordIdentity({ ...performance, keyId: 'a', model: 'b\0c' }))
    .not.toBe(performanceRecordIdentity({ ...performance, keyId: 'a\0b', model: 'c' }));
});
