import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { RequestListPanel } from '../../../src/components/requests/list';
import { RequestSeverityIcon } from '../../../src/components/requests/severity-icon';
import { renderInApp } from '../../render';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

const glyphOf = (root: ParentNode): string | null | undefined =>
  root.querySelector('svg path')?.getAttribute('d');

const fillClassOf = (root: ParentNode): string =>
  root.querySelector('svg')?.getAttribute('class') ?? '';

describe('request severity icon', () => {
  it('separates warning from error by fill alone, never by glyph', () => {
    const warning = renderInApp(<RequestSeverityIcon severity="warning" />);
    const error = renderInApp(<RequestSeverityIcon severity="error" />);
    const success = renderInApp(<RequestSeverityIcon severity="success" />);

    expect(glyphOf(warning.container)).toBe(glyphOf(error.container));
    expect(glyphOf(warning.container)).not.toBe(glyphOf(success.container));
    expect(fillClassOf(warning.container)).not.toBe(fillClassOf(error.container));
    expect(fillClassOf(warning.container)).not.toBe(fillClassOf(success.container));
  });
});

const apiKey: ApiKey = {
  id: 'key-1',
  name: 'Owner key',
  key: 'sk-test',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  upstream_ids: null,
  dump_retention_seconds: 3600,
  responses_retention_seconds: 0,
};

const record = (id: string, status: number): DumpMetadata => ({
  id,
  startedAt: 1_000,
  completedAt: 1_012,
  method: 'POST',
  path: '/v1/chat/completions',
  status,
  upstream: null,
  model: 'gpt-5',
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 12,
  error: null,
});

const renderList = (records: DumpMetadata[]) => {
  const router = createMemoryRouter([{
    path: '*',
    Component: () => <RequestListPanel
      addressOfRecord={recordId => `?record=${recordId}`}
      apiKeys={[apiKey]}
      error={null}
      hasOlder={false}
      onDismissError={() => {}}
      onKeyChange={() => {}}
      onLoadOlder={() => {}}
      onRecordChange={() => {}}
      records={records}
      selectedKeyId="key-1"
      selectedRecordId={null}
    />,
  }], { initialEntries: ['/'] });
  return renderInApp(<RouterProvider router={router} />);
};

describe('request list severity reading', () => {
  it.each([200, 429, 500] as const)('reads a %s row through the shared severity icon', status => {
    const { container } = renderList([record(`rec-${status}`, status)]);
    const shared = renderInApp(<RequestSeverityIcon severity={status >= 500 ? 'error' : status >= 400 ? 'warning' : 'success'} />);

    const rowGlyph = glyphOf(container.querySelector('[role="option"]')!);
    expect(rowGlyph).toBeTruthy();
    expect(rowGlyph).toBe(glyphOf(shared.container));
  });
});
