import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import DashboardAdminBackupRestore from '../../src/routes/dashboard-admin-backup-restore';
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
  onload: FileReader['onload'] = null;
  onerror: FileReader['onerror'] = null;
  abort = vi.fn();

  readAsText(): void { ControlledFileReader.pending.push(this); }
  succeed(value: string): void {
    this.result = value;
    this.onload?.call(this as never, new ProgressEvent('load') as never);
  }
  fail(): void { this.onerror?.call(this as never, new ProgressEvent('error') as never); }
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
    expect(screen.queryByText(/A\.json/)).toBeNull();
    await act(async () => ControlledFileReader.pending[1].fail());

    expect((screen.getByRole('button', { name: 'Import Data' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The selected backup file could not be read.')).toBeTruthy();
  });

  it('ignores an out-of-order click A completion and makes only drop-selected B importable', async () => {
    const { container } = renderPage();
    fireEvent.change(input(container), { target: { files: [file('A.json')] } });
    const picker = screen.getByRole('button', { name: /Drag and drop a backup file/ });
    fireEvent.drop(picker, { dataTransfer: { files: [file('B.json')] } });

    await act(async () => ControlledFileReader.pending[1].succeed(backup('B')));
    await act(async () => ControlledFileReader.pending[0].succeed(backup('A')));
    expect(screen.getByText(/B\.json/)).toBeTruthy();
    expect(screen.queryByText(/A\.json/)).toBeNull();

    const importButton = screen.getByRole('button', { name: 'Import Data' }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(false);
    expect(screen.getByText('Users').closest('div')?.querySelector('dd')?.textContent).toBe('2');
  });
});
