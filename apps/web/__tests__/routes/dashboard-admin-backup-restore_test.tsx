import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { importPost } = vi.hoisted(() => ({
  importPost: vi.fn(async (_request: { json: unknown }) => Response.json({ imported: {} })),
}));
vi.mock('../../src/api/client', () => ({
  api: { api: { import: { $post: importPost } } },
  callApi: async (request: () => Promise<Response>) => ({ data: await (await request()).json() }),
}));

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminBackupRestore, { consumeFileReadCompletion, importReadFailureState } from '../../src/routes/dashboard-admin-backup-restore';
import { renderInApp } from '../render';

const backup = (marker: string) => JSON.stringify({
  version: 20,
  exportedAt: '2026-09-04T00:00:00.000Z',
  data: {
    users: marker === 'B' ? [{ marker }, { marker }] : [{ marker }],
    apiKeys: [], upstreams: [], proxies: [], usage: [], searchUsage: [],
    performanceIncluded: false, searchConfig: null,
  },
});

class ControlledFileReader {
  static pending: ControlledFileReader[] = [];
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onload: FileReader['onload'] = null;
  onerror: FileReader['onerror'] = null;
  abort = vi.fn();

  readAsText(): void { ControlledFileReader.pending.push(this); }
  succeed(value: string): void {
    this.result = value;
    this.onload?.call(this as never, new ProgressEvent('load') as never);
  }
  fail(error = new DOMException('The file could not be read.', 'NotReadableError')): void {
    this.error = error;
    this.onerror?.call(this as never, new ProgressEvent('error') as never);
  }
}

const renderPage = () => renderInApp(
  <OutcomeToastProvider>
    <DashboardAdminBackupRestore
      loaderData={{ runtime: { profile: 'server', error: null } }}
      matches={[] as never}
      params={{}}
    />
  </OutcomeToastProvider>,
);

const input = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const file = (name: string) => new File(['pending'], name, { type: 'application/json' });

describe('backup import file races', () => {
  beforeEach(() => {
    ControlledFileReader.pending = [];
    importPost.mockClear();
    vi.stubGlobal('FileReader', ControlledFileReader as unknown as typeof FileReader);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('invalidates valid A synchronously while click-selected B reads and keeps it invalid after read failure', async () => {
    const { container } = renderPage();
    fireEvent.change(input(container), { target: { files: [file('A.json')] } });
    await act(async () => ControlledFileReader.pending[0].succeed(backup('A')));
    expect(screen.getByText(/A\.json/)).toBeTruthy();

    fireEvent.change(input(container), { target: { files: [file('B.json')] } });
    expect((screen.getByRole('button', { name: 'Import Data' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import Data' }));
    expect(importPost).not.toHaveBeenCalled();
    expect(screen.queryByText(/A\.json/)).toBeNull();
    const readFailure = new DOMException('FLOWAY_FILE_READER_SECRET', 'NotReadableError');
    await act(async () => ControlledFileReader.pending[1].fail(readFailure));

    expect((screen.getByRole('button', { name: 'Import Data' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The selected backup file could not be read.')).toBeTruthy();
    expect(document.body.textContent).not.toContain(readFailure.message);
    expect(importPost).not.toHaveBeenCalled();
  });

  it('ignores an out-of-order click A completion and makes only drop-selected B importable', async () => {
    const { container } = renderPage();
    fireEvent.change(input(container), { target: { files: [file('A.json')] } });
    const picker = screen.getByRole('button', { name: /Drag and drop a backup file/ });
    fireEvent.drop(picker, { dataTransfer: { files: [file('B.json')] } });

    await act(async () => ControlledFileReader.pending[1].succeed(backup('B')));
    await act(async () => ControlledFileReader.pending[1].fail(new DOMException('late terminal callback', 'InvalidStateError')));
    await act(async () => ControlledFileReader.pending[0].succeed(backup('A')));
    expect(screen.getByText(/B\.json/)).toBeTruthy();
    expect(screen.queryByText(/A\.json/)).toBeNull();

    const importButton = screen.getByRole('button', { name: 'Import Data' }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(false);
    expect(screen.getByText('Users').closest('div')?.querySelector('dd')?.textContent).toBe('2');
    await act(async () => { fireEvent.click(importButton); });
    expect(importPost).toHaveBeenCalledTimes(1);
    const submitted = JSON.stringify(importPost.mock.calls[0][0]);
    expect(submitted).toContain('B');
    expect(submitted).not.toContain('A');
  });

  it('consumes one completion token and retains the exact read error only in diagnostic state', () => {
    const reader = new ControlledFileReader();
    const token = { reader: reader as unknown as FileReader, token: 7 };
    const original = new DOMException('FLOWAY_PRIVATE_READER_DIAGNOSTIC', 'NotReadableError');
    const completed = consumeFileReadCompletion(token, token, () => importReadFailureState('safe message', original));

    expect(completed?.archive).toEqual({ kind: 'empty', error: { message: 'safe message', cause: original } });
    expect(consumeFileReadCompletion(completed!.active, token, () => {
      throw new Error('a consumed token must not evaluate another outcome');
    })).toBeNull();
  });
});
