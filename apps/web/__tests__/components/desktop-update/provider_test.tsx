import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { DesktopUpdateSnapshot } from '../../../src/api/desktop-update';
import { DesktopUpdateBanner } from '../../../src/components/desktop-update/banner';
import { DesktopUpdateProvider } from '../../../src/components/desktop-update/provider';
import { DesktopUpdateSettings } from '../../../src/components/desktop-update/settings';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { renderInApp } from '../../render';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: native.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

const snapshot = (overrides: Partial<DesktopUpdateSnapshot> = {}): DesktopUpdateSnapshot => ({
  revision: 0, phase: 'idle', currentVersion: '0.1.0', version: null, notes: null,
  stagedVersion: null, stagedNotes: null, receivedBytes: 0, totalBytes: null,
  checkedAt: null, dismissedVersion: null, updatedVersion: null, failure: null, ...overrides,
});
const ready = (revision = 2) => snapshot({
  revision, phase: 'ready', version: '0.2.0',
  stagedVersion: '0.2.0', notes: '# New version', stagedNotes: '# New version',
});
let receive: (event: { payload: unknown }) => void;
const unsubscribe = vi.fn();
const setup = (initial: DesktopUpdateSnapshot) => {
  native.listen.mockImplementation(async (_: string, listener: typeof receive) => { receive = listener; return unsubscribe; });
  native.invoke.mockImplementation(async () => initial);
};
const render = (enabled = true) => renderInApp(<OutcomeToastProvider><DesktopUpdateProvider enabled={enabled}>
  <DesktopUpdateBanner /><DesktopUpdateSettings />
</DesktopUpdateProvider></OutcomeToastProvider>);
const emit = (value: DesktopUpdateSnapshot) => act(() => receive({ payload: value }));

afterEach(() => { vi.clearAllMocks(); native.isTauri.mockReturnValue(true); });

test('subscribes before reading and rejects stale snapshots and events', async () => {
  setup(snapshot());
  let resolveInitial: (value: DesktopUpdateSnapshot) => void = () => { throw new Error('initial read did not start'); };
  native.invoke.mockImplementation(() => new Promise(resolve => { resolveInitial = resolve; }));
  render();
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('desktop_update_status'));
  expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(native.invoke.mock.invocationCallOrder[0]);
  emit(ready());
  await act(async () => resolveInitial(snapshot()));
  emit(snapshot({ revision: 1, phase: 'checking' }));
  expect(screen.getByText('Floway 0.2.0 is ready')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Update and restart' })[0].hasAttribute('disabled')).toBe(false);
});

test('unknown size, 100 percent transfer and verification never enable installation', async () => {
  setup(snapshot({ revision: 1, phase: 'downloading', version: '0.2.0', receivedBytes: 42 }));
  render();
  await screen.findByText('Downloading in the background…');
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
  emit(snapshot({ revision: 2, phase: 'downloading', version: '0.2.0', receivedBytes: 100, totalBytes: 100 }));
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
  emit(snapshot({ revision: 3, phase: 'verifying', version: '0.2.0', receivedBytes: 100, totalBytes: 100 }));
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
  emit(ready(4));
  expect(screen.getByText('Floway 0.2.0 is ready')).toBeTruthy();
});

test('Later only dismisses the named version, preserving settings installation across reload', async () => {
  const dismissed = { ...ready(3), dismissedVersion: '0.2.0' };
  setup(ready());
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'desktop_dismiss_update') { emit(dismissed); return; }
    return ready();
  });
  const first = render();
  fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
  await waitFor(() => expect(screen.queryByText('Floway 0.2.0 is ready')).toBeNull());
  expect(native.invoke).toHaveBeenCalledWith('desktop_dismiss_update', { version: '0.2.0' });
  expect(screen.getAllByRole('button', { name: 'Update and restart' })).toHaveLength(1);
  first.unmount();
  setup(dismissed);
  render();
  await screen.findByText('The update is ready to install.');
  expect(screen.queryByText('Floway 0.2.0 is ready')).toBeNull();
  emit({ ...ready(4), version: '0.3.0', stagedVersion: '0.3.0', dismissedVersion: '0.2.0' });
  expect(screen.getByText('Floway 0.3.0 is ready')).toBeTruthy();
});

test('release notes suppress raw HTML and unsafe URLs, and installation requires the restart action', async () => {
  setup({ ...ready(), stagedNotes: '# Improvements\n\n- Fixed routing\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))' });
  render();
  await screen.findByText('Floway 0.2.0 is ready');
  fireEvent.click(screen.getAllByRole('button', { name: 'View changes' })[0]);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('script')).toBeNull();
  expect(dialog.querySelector('a')?.hasAttribute('href')).toBe(false);
  expect(screen.getByText('Fixed routing')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getAllByRole('button', { name: 'Update and restart' })[0]);
  await screen.findByText('Updating restarts Floway and briefly interrupts your local API service. Active requests may fail.');
  expect(native.invoke).not.toHaveBeenCalledWith('desktop_install_update');
  fireEvent.click(screen.getAllByRole('button', { name: 'Update and restart' }).at(-1)!);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('desktop_install_update'));
});

test('errors retain ready installation, and command errors stay visible without claiming latest', async () => {
  setup({ ...ready(), phase: 'error', failure: { phase: 'check', chain: ['offline'], version: null } });
  render();
  await screen.findByText('Could not check for updates. Check your connection and try again.');
  expect(screen.queryByText('You’re up to date.')).toBeNull();
  native.invoke.mockRejectedValueOnce(new Error('connection failed'));
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await screen.findAllByText('The update action failed. Open logs for details, then try again.');
  expect(screen.getAllByRole('button', { name: 'Update and restart' })).toHaveLength(2);
  logger.mockRestore();
});

test('browser and server dashboards never subscribe or offer local installation', () => {
  setup(ready());
  native.isTauri.mockReturnValue(false);
  const browser = render();
  expect(native.listen).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(screen.queryByText('Application updates')).toBeNull();
  browser.unmount();
  native.isTauri.mockReturnValue(true);
  render(false);
  expect(native.listen).not.toHaveBeenCalled();
  expect(screen.queryByText('Application updates')).toBeNull();
});

test('a signature-rejected staged package retains its metadata without offering installation', async () => {
  setup({ ...ready(), phase: 'error', failure: { phase: 'signature', chain: ['staged bytes were modified'], version: '0.2.0' } });
  render();
  await screen.findByText('The update could not be authenticated. Check again to download a valid package.');
  expect(screen.queryByText('Floway 0.2.0 is ready')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')).toBe(false);
});

test('an open restart confirmation follows native installation permission changes', async () => {
  setup(ready());
  render();
  fireEvent.click((await screen.findAllByRole('button', { name: 'Update and restart' }))[0]);
  const dialog = await screen.findByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: 'Update and restart' });
  emit({ ...ready(3), phase: 'checking' });
  expect(confirm.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(confirm);
  expect(native.invoke).not.toHaveBeenCalledWith('desktop_install_update');
  emit({ ...ready(4), phase: 'error', failure: { phase: 'signature', chain: ['rejected'], version: '0.2.0' } });
  expect(confirm.getAttribute('aria-disabled')).toBe('true');
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(false);
  emit(ready(5));
  expect(confirm.getAttribute('aria-disabled')).not.toBe('true');
  fireEvent.click(confirm);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('desktop_install_update'));
});

test('cached release details survive rechecks and follow a newer download when its metadata arrives', async () => {
  setup({ ...ready(), phase: 'error', version: null, notes: null, failure: { phase: 'check', chain: ['offline'], version: null } });
  render();
  await screen.findByText('Update version: 0.2.0');
  emit({ ...ready(3), phase: 'checking', version: null, notes: null });
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
  expect(await screen.findByRole('heading', { name: 'New version' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  emit({ ...ready(4), phase: 'downloading', version: '0.3.0', notes: '# Upcoming changes' });
  expect(screen.getByText('Update version: 0.3.0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
  expect(await screen.findByRole('heading', { name: 'Upcoming changes' })).toBeTruthy();
});
