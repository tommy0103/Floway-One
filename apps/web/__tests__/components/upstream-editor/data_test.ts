import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { canFetchModelCatalog, createBody, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [
      { key: 'x-pass', value: null },
      { key: 'x-empty', value: '' },
      { key: 'x-route', value: 'fast' },
    ],
    modelsFetch: { enabled: false },
    models: [],
  },
  state: null,
}) as CustomRecord;

test('Custom editor values add one blank ingress row and never serialize it', () => {
  const values = valuesFromRecord(record);
  const config = values.config as CustomRecord['config'];
  expect(config.ingressHeadersRules).toEqual([
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
    { key: '', value: null },
  ]);

  config.ingressHeadersRules[0]!.key = ' X-PASS ';
  const expected = [
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
  ];
  expect((createBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((updateBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((previewRecord(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
});

test('Floway does not probe a reset upstream before its credentials are restored', () => {
  const seeds: Parameters<typeof upstreamRecord>[1][] = [
    record,
    { kind: 'azure', config: { endpoint: '', apiKey: '', models: [] }, state: null },
    { kind: 'copilot', config: { githubHost: 'github.com', githubToken: '', user: { login: '', avatar_url: '', name: null, id: 0 } }, state: null },
    { kind: 'codex', config: { accounts: [] }, state: { accounts: [] } },
    { kind: 'claude-code', config: { accounts: [] }, state: { accounts: [] } },
    { kind: 'ollama', config: { baseUrl: '', apiKey: '', cloudUsage: false, models: [] }, state: null },
  ];
  for (const seed of seeds) {
    const pending = upstreamRecord(`pending_${seed.kind}`, { ...seed, configuration_required: true });
    expect(canFetchModelCatalog(pending, pending.config)).toBe(false);
  }
});
