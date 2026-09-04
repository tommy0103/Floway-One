import { expect, test } from 'vitest';

import { InvalidMetricIdentityError, performanceRecordIdentity, usageRecordIdentity, webSearchUsageRecordIdentity } from '../../src/repo/record-identities.ts';

test('usage storage identity normalizes null and empty upstream exactly once', () => {
  const base = { keyId: 'key', model: 'model', modelKey: 'model-key', hour: '2026-01-01T00', pricingSelector: {} };
  expect(usageRecordIdentity({ ...base, upstream: null })).toBe(usageRecordIdentity({ ...base, upstream: '' }));
});

test('metric storage identities are collision-safe for representable string dimensions', () => {
  const usage = { upstream: null, modelKey: 'key', hour: 'hour', pricingSelector: {} };
  expect(usageRecordIdentity({ ...usage, keyId: 'a', model: 'b","c' }))
    .not.toBe(usageRecordIdentity({ ...usage, keyId: 'a","b', model: 'c' }));

  const search = { provider: 'tavily' as const, action: 'search' as const };
  expect(webSearchUsageRecordIdentity({ ...search, keyId: 'a', hour: 'b","c' }))
    .not.toBe(webSearchUsageRecordIdentity({ ...search, keyId: 'a","b', hour: 'c' }));

  const performance = { upstream: 'upstream', operation: 'chat' as const, runtimeLocation: 'LOCAL', hour: '2026-01-01T00' };
  expect(performanceRecordIdentity({ ...performance, keyId: 'a', model: 'b","c' }))
    .not.toBe(performanceRecordIdentity({ ...performance, keyId: 'a","b', model: 'c' }));
});

test('metric storage identities reject NUL components that SQLite cannot represent', () => {
  expect(() => usageRecordIdentity({ keyId: 'key', model: 'model\0token', upstream: null, modelKey: 'model-key', hour: '2026-01-01T00', pricingSelector: {} }))
    .toThrowError(InvalidMetricIdentityError);
  expect(() => webSearchUsageRecordIdentity({ provider: 'tavily', keyId: 'key\0token', action: 'search', hour: '2026-01-01T00' }))
    .toThrowError(InvalidMetricIdentityError);
  expect(() => performanceRecordIdentity({ hour: '2026-01-01T00', keyId: 'key', model: 'model\0token', upstream: 'upstream', operation: 'chat', runtimeLocation: 'LOCAL' }))
    .toThrowError(InvalidMetricIdentityError);
});
