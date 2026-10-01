import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { z } from 'zod';

const snapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: z.enum(['idle', 'disabled', 'checking', 'upToDate', 'downloading', 'verifying', 'ready', 'installing', 'error']),
  currentVersion: z.string(),
  version: z.string().nullable(),
  notes: z.string().nullable(),
  stagedVersion: z.string().nullable(),
  stagedNotes: z.string().nullable(),
  receivedBytes: z.number().nonnegative(),
  totalBytes: z.number().positive().nullable(),
  checkedAt: z.number().nonnegative().nullable(),
  dismissedVersion: z.string().nullable(),
  updatedVersion: z.string().nullable(),
  failure: z.object({
    phase: z.enum(['check', 'download', 'signature', 'install', 'recovery-point', 'health']),
    chain: z.array(z.string()),
    version: z.string().nullable(),
  }).nullable(),
});

export type DesktopUpdateSnapshot = z.infer<typeof snapshotSchema>;
export const parseDesktopUpdateSnapshot = (payload: unknown): DesktopUpdateSnapshot => snapshotSchema.parse(payload);
export const updateBusy = (snapshot: DesktopUpdateSnapshot): boolean =>
  ['checking', 'downloading', 'verifying', 'installing'].includes(snapshot.phase);

export const installableDesktopUpdate = (snapshot: DesktopUpdateSnapshot): boolean =>
  !!snapshot.stagedVersion && snapshot.phase !== 'disabled' && !(snapshot.failure?.phase === 'signature' && snapshot.failure.version === snapshot.stagedVersion);

export const desktopUpdateStatus = async (): Promise<DesktopUpdateSnapshot> =>
  parseDesktopUpdateSnapshot(await invoke('desktop_update_status'));
export const checkDesktopUpdate = async (): Promise<DesktopUpdateSnapshot> =>
  parseDesktopUpdateSnapshot(await invoke('desktop_check_for_updates'));
export const installDesktopUpdate = async (): Promise<void> => await invoke('desktop_install_update');
export const dismissDesktopUpdate = async (version: string): Promise<void> => await invoke('desktop_dismiss_update', { version });

// Listen first: a download can finish before the initial command resolves.
// Every entrypoint feeds the same revision reducer, including command replies.
export async function subscribeDesktopUpdate(onSnapshot: (snapshot: DesktopUpdateSnapshot) => void, onError: (cause: unknown) => void): Promise<() => void> {
  const unlisten = await listen<unknown>('floway-desktop-update', event => {
    try { onSnapshot(parseDesktopUpdateSnapshot(event.payload)); } catch (cause) { onError(cause); }
  });
  try { onSnapshot(await desktopUpdateStatus()); } catch (cause) { onError(cause); }
  return unlisten;
}
