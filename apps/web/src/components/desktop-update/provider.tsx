import { isTauri } from '@tauri-apps/api/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';

import { ReleaseNotesDialog } from './release-notes';
import { checkDesktopUpdate, dismissDesktopUpdate, installDesktopUpdate, subscribeDesktopUpdate, updateBusy, type DesktopUpdateSnapshot } from '../../api/desktop-update';
import { useTranslation } from '../../i18n/translation';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useOutcomeToasts } from '../ui/outcome-toast';

interface UpdateContext {
  snapshot: DesktopUpdateSnapshot | null;
  error: string | null;
  pending: boolean;
  check: () => void;
  install: () => void;
  later: () => void;
  viewNotes: () => void;
}
const Context = createContext<UpdateContext | null>(null);
export const useDesktopUpdate = (): UpdateContext | null => useContext(Context);

export function DesktopUpdateProvider({ children, enabled }: PropsWithChildren<{ enabled: boolean }>) {
  const active = enabled && isTauri();
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const actionInFlight = useRef(false);
  const [notes, setNotes] = useState<{ version: string; body: string | null } | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const announcedVersion = useRef<string | null>(null);
  const receive = useCallback((next: DesktopUpdateSnapshot) => {
    setSnapshot(current => current && current.revision >= next.revision ? current : next);
  }, []);
  const fail = useCallback((cause: unknown) => {
    console.error('Floway desktop update command failed', cause);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeDesktopUpdate(next => { if (!stopped) receive(next); }, cause => { if (!stopped) fail(cause); })
      .then(stop => { if (stopped) stop(); else unsubscribe = stop; })
      .catch(cause => { if (!stopped) fail(cause); });
    return () => { stopped = true; unsubscribe?.(); };
  }, [active, fail, receive]);

  useEffect(() => {
    if (!snapshot?.updatedVersion || announcedVersion.current === snapshot.updatedVersion) return;
    announcedVersion.current = snapshot.updatedVersion;
    toasts.succeed(t('dashboard.settings.desktop.update.updated', { version: snapshot.updatedVersion }));
  }, [snapshot?.updatedVersion, t, toasts]);

  const run = useCallback((operation: () => Promise<void>) => {
    if (!active || actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(true);
    setError(null);
    void operation().catch(fail).finally(() => {
      actionInFlight.current = false;
      setPending(false);
    });
  }, [active, fail]);
  const check = useCallback(() => run(async () => receive(await checkDesktopUpdate())), [receive, run]);
  const later = useCallback(() => {
    const version = snapshot?.stagedVersion;
    if (version) run(() => dismissDesktopUpdate(version));
  }, [run, snapshot?.stagedVersion]);
  const viewNotes = useCallback(() => {
    if (!snapshot) return;
    const preferStaged = !!snapshot.stagedVersion && !updateBusy(snapshot);
    const version = preferStaged ? snapshot.stagedVersion : snapshot.version;
    if (!version) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotes({ version, body: preferStaged ? snapshot.stagedNotes : snapshot.notes });
    setNotesOpen(true);
  }, [snapshot]);
  const install = useCallback(() => {
    if (!snapshot?.stagedVersion || updateBusy(snapshot) || actionInFlight.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmOpen(true);
  }, [snapshot]);
  const restoreFocus = useCallback(() => { if (opener.current?.isConnected) opener.current.focus(); }, []);
  const value = useMemo(() => active ? { snapshot, error, pending, check, install, later, viewNotes } : null,
    [active, snapshot, error, pending, check, install, later, viewNotes]);

  return <Context.Provider value={value}>
    {children}
    {active && <>
      <ReleaseNotesDialog body={notes?.body ?? null} onExited={restoreFocus} onOpenChange={setNotesOpen} open={notesOpen} version={notes?.version ?? ''} />
      <ConfirmDialog
        actionIntent="primary"
        actionLabel={t('dashboard.settings.desktop.update.install')}
        busy={pending || snapshot?.phase === 'installing'}
        error={error ? t('dashboard.settings.desktop.update.actionFailed') : null}
        message={t('dashboard.settings.desktop.update.interruption')}
        onConfirm={() => {
          if (!snapshot?.stagedVersion || updateBusy(snapshot)) return;
          run(async () => { await installDesktopUpdate(); setConfirmOpen(false); });
        }}
        onExited={restoreFocus}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        title={t('dashboard.settings.desktop.update.installTitle')}
      />
    </>}
  </Context.Provider>;
}
