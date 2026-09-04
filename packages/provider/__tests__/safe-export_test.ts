import { expect, test } from 'vitest';

import { routingPathForSafeExport, routingUrlForSafeExport, upstreamModelsForSafeExport } from '../src/safe-export.ts';

test('safe routing URLs retain origin and path but cannot carry authority, query, or fragment credentials', () => {
  expect(routingUrlForSafeExport('https://user:password@example.com:8443/v1?api_key=query-secret#fragment-secret'))
    .toBe('https://example.com:8443/v1');
  expect(routingUrlForSafeExport('https://example.com')).toBe('https://example.com');
});

test('safe routing paths retain only the pathname for relative and future full-URL carriers', () => {
  expect(routingPathForSafeExport('/models?api_key=query-secret#fragment-secret')).toBe('/models');
  expect(routingPathForSafeExport('https://user:password@example.com/rerank?token=query-secret#fragment-secret'))
    .toBe('/rerank');
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
    rerankTarget: { protocol: 'cohere-v2', path: '/rerank' },
  }]);
  expect(JSON.stringify(models)).not.toContain('secret');
});
