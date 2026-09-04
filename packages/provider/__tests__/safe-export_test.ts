import { expect, test } from 'vitest';

import { routingBaseForSafeExport, routingUrlForSafeExport, upstreamModelsForSafeExport } from '../src/safe-export.ts';

test('safe routing URLs retain origin and path but cannot carry authority, query, or fragment credentials', () => {
  expect(routingUrlForSafeExport('https://user:password@example.com:8443/v1?api_key=query-secret#fragment-secret'))
    .toBe('https://example.com:8443/v1');
  expect(routingUrlForSafeExport('https://example.com')).toBe('https://example.com');
});

test('safe routing bases retain only origin and non-usable path presence', () => {
  expect(routingBaseForSafeExport('https://user:password@example.com:8443/capability/path?api_key=secret#secret'))
    .toEqual({ baseUrl: 'https://example.com:8443', basePathConfigured: true });
  expect(routingBaseForSafeExport('https://example.com')).toEqual({ baseUrl: 'https://example.com' });
});

test('safe model projections allow only explicit routing identity and capability fields', () => {
  const models = upstreamModelsForSafeExport([{
    kind: 'chat',
    endpoints: { openaiChatCompletions: { futureCredential: 'endpoint-secret' } },
    upstreamModelId: 'model-a',
    publicModelId: 'public-a',
    display_name: 'Model A',
    futureCredential: 'model-secret',
  } as never]);

  expect(models).toEqual([{
    kind: 'chat',
    endpoints: { openaiChatCompletions: {} },
    upstreamModelId: 'model-a',
    publicModelId: 'public-a',
    display_name: 'Model A',
  }]);
  expect(JSON.stringify(models)).not.toContain('secret');
});

test('safe model projections sanitize rerank paths and ignore future open fields', () => {
  const models = upstreamModelsForSafeExport([{
    kind: 'rerank',
    endpoints: { rerank: {} },
    upstreamModelId: 'rerank-a',
    rerankTarget: {
      protocol: 'cohere-v2',
      path: '/rerank?api_key=rerank-secret#rerank-fragment-secret',
      futureCredential: 'target-secret',
    },
    futureCredential: 'model-secret',
  } as never]);

  expect(models).toEqual([{
    kind: 'rerank',
    endpoints: { rerank: {} },
    upstreamModelId: 'rerank-a',
    rerankTarget: { protocol: 'cohere-v2', pathConfigured: true },
  }]);
  expect(JSON.stringify(models)).not.toContain('secret');
});
