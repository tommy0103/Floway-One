import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Route } from './+types/dashboard-admin-backup-restore';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { legacyImportRequest, parseBackupFile, parseEncryptedBackupFile, type BackupFile, type EncryptedBackupFile } from '../components/backup-restore/file';
import { BackupFilePicker, BackupFileStats, BackupFileSummary } from '../components/backup-restore/file-picker';
import { resolveBackupRestoreRuntime } from '../components/backup-restore/runtime';
import { countRecords, PREVIEW_LABEL_KEYS, recordSummary } from '../components/backup-restore/summary';
import { ActionRow } from '../components/ui/action-row';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';
import { formatCount } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';

const {
  Button,
  Checkbox,
  Field,
  Input,
  Spinner,
} = fluentComponents;

export async function clientLoader() {
  await requireDashboardAdmin();
  const runtime = await callApi(() => api.api['runtime-info'].$get());
  return { runtime: resolveBackupRestoreRuntime(runtime) };
}

type ImportSelection =
  | { kind: 'encrypted'; archive: EncryptedBackupFile }
  | { kind: 'legacy'; payload: BackupFile };
type ImportArchiveError = { message: string; cause: unknown };

type ImportArchiveState =
  | { kind: 'empty'; error: ImportArchiveError | null }
  | { kind: 'reading'; file: File; token: number }
  | { kind: 'ready'; error: ImportArchiveError | null; file: File; selection: ImportSelection; token: number };

interface ActiveFileRead {
  readonly file: File;
  readonly reader: FileReader;
  readonly token: number;
}

const importReadFailureState = (message: string, cause: unknown): ImportArchiveState => ({
  kind: 'empty',
  error: { message, cause },
});

export const consumeFileReadCompletion = (
  active: ActiveFileRead | null,
  completion: ActiveFileRead,
  outcome: () => ImportArchiveState,
): { active: null; archive: ImportArchiveState } | null =>
  active === completion ? { active: null, archive: outcome() } : null;

export const startImportArchiveRead = (
  read: ActiveFileRead,
  complete: (completion: ActiveFileRead, outcome: () => ImportArchiveState) => void,
  parse: (raw: string) => ImportArchiveState,
  readErrorMessage: string,
): void => {
  read.reader.onload = () => complete(read, () => parse(read.reader.result as string));
  read.reader.onerror = () => complete(read, () => importReadFailureState(readErrorMessage, read.reader.error));
  read.reader.readAsText(read.file);
};

const transitionCurrentImport = (
  current: ImportArchiveState,
  token: number,
  transition: (ready: Extract<ImportArchiveState, { kind: 'ready' }>) => ImportArchiveState,
): ImportArchiveState => current.kind === 'ready' && current.token === token ? transition(current) : current;

const downloadJson = (data: unknown, name: string): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

export default function DashboardAdminBackupRestore({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const toasts = useOutcomeToasts();
  const runtime = loaderData.runtime;
  const personal = runtime.profile === 'personal';

  const [includePerformance, setIncludePerformance] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [backupPassword, setBackupPassword] = useState('');

  const [importArchive, setImportArchive] = useState<ImportArchiveState>({ kind: 'empty', error: null });
  const [restorePassword, setRestorePassword] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const confirmDialog = useDialogInvocation<void>();

  const handleExport = useCallback(async (kind: 'full' | 'legacy' | 'safe') => {
    setExporting(true);
    setExportError(null);

    const handle = toasts.start(t('dashboard.backupRestore.export.pending'));
    const result = kind === 'full'
      ? await callApi(() => api.api.export.$post({
          json: { password: backupPassword, includePerformance },
        }))
      : await callApi(() => api.api.export.$get({
          query: {
            ...(includePerformance ? { include_performance: '1' } : {}),
            ...(kind === 'safe' ? { kind: 'safe' as const } : {}),
          },
        }));

    if (result.error) {
      handle.settle();
      setExportError(result.error.message);
      setExporting(false);
      return;
    }

    const date = 'exportedAt' in result.data
      ? result.data.exportedAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const name = kind === 'full'
      ? `floway-full-backup-${date}.json`
      : kind === 'safe'
        ? `floway-safe-export-${date}.json`
        : `floway-export-${date}.json`;
    downloadJson(result.data, name);

    setExporting(false);
    if (kind === 'full') setBackupPassword('');
    handle.succeed(t('dashboard.backupRestore.export.success', { name }));
  }, [backupPassword, includePerformance, t, toasts]);

  // Without aborting, a second file dropped mid-read leaves two reads racing and
  // the later-finishing one wins. `abort()` raises neither `load` nor `error`,
  // so the losing read reaches no state at all.
  const activeReadRef = useRef<ActiveFileRead | null>(null);
  const readSequenceRef = useRef(0);
  useEffect(() => () => {
    readSequenceRef.current++;
    const active = activeReadRef.current;
    activeReadRef.current = null;
    active?.reader.abort();
  }, []);

  const invalidateImportArchive = useCallback((error: ImportArchiveError | null = null) => {
    readSequenceRef.current++;
    const active = activeReadRef.current;
    activeReadRef.current = null;
    active?.reader.abort();
    setImportArchive({ kind: 'empty', error });
  }, []);

  const completeFileRead = useCallback((completion: ActiveFileRead, outcome: () => ImportArchiveState) => {
    const transition = consumeFileReadCompletion(activeReadRef.current, completion, outcome);
    if (transition === null) return;
    activeReadRef.current = transition.active;
    setImportArchive(transition.archive);
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      const readSequence = ++readSequenceRef.current;
      const previous = activeReadRef.current;
      activeReadRef.current = null;
      previous?.reader.abort();
      setImportArchive({ kind: 'reading', file, token: readSequence });

      const reader = new FileReader();
      const activeRead = { file, reader, token: readSequence };
      activeReadRef.current = activeRead;
      startImportArchiveRead(activeRead, completeFileRead, raw => {
        if (personal) {
          const result = parseEncryptedBackupFile(raw);
          return result.ok
            ? { kind: 'ready', error: null, file, selection: { kind: 'encrypted', archive: result.archive }, token: readSequence }
            : { kind: 'empty', error: { message: t(result.error.clientMessageKey), cause: result.error } };
        }
        const result = parseBackupFile(raw);
        return result.ok
          ? { kind: 'ready', error: null, file, selection: { kind: 'legacy', payload: result.payload }, token: readSequence }
          : { kind: 'empty', error: { message: t(result.error.clientMessageKey), cause: result.error } };
      }, t('dashboard.backupRestore.import.errorReadFile'));
    },
    [completeFileRead, personal, t],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset so re-selecting the same file triggers onChange again
      e.target.value = '';
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const dropHandlers = useMemo(
    () => ({ onDragLeave: handleDragLeave, onDragOver: handleDragOver, onDrop: handleDrop }),
    [handleDragLeave, handleDragOver, handleDrop],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);

  const handleChangeFile = useCallback(() => {
    invalidateImportArchive();
    fileInputRef.current?.click();
  }, [invalidateImportArchive]);

  const doImport = useCallback(async () => {
    if (importArchive.kind !== 'ready') return;
    const selection = importArchive.selection;
    const token = importArchive.token;
    setImporting(true);
    setImportArchive({ ...importArchive, error: null });

    const handle = toasts.start(t('dashboard.backupRestore.import.pending'));
    const mode = replaceExisting ? 'replace' as const : 'merge' as const;
    const result = selection.kind === 'encrypted'
      ? await callApi(() => api.api.import.$post({
          json: { mode, archive: selection.archive, password: restorePassword },
        }))
      : await callApi(() => api.api.import.$post({
          json: legacyImportRequest(selection.payload, mode),
        }));

    if (result.error) {
      handle.settle();
      setImportArchive(current => transitionCurrentImport(current, token, ready => ({ ...ready, error: { message: result.error.message, cause: result.error } })));
      setImporting(false);
      return;
    }

    setImportArchive(current => transitionCurrentImport(current, token, () => ({ kind: 'empty', error: null })));
    setRestorePassword('');
    setImporting(false);
    const summary = recordSummary(result.data.imported, t, locale);
    handle.succeed(summary
      ? t('dashboard.backupRestore.import.success', { summary })
      : t('dashboard.backupRestore.import.successEmpty'));
  }, [importArchive, locale, replaceExisting, restorePassword, t, toasts]);

  const handleImportClick = useCallback(() => {
    if (importArchive.kind !== 'ready') return;
    if (replaceExisting) {
      confirmDialog.open();
      return;
    }
    void doImport();
  }, [confirmDialog, doImport, importArchive.kind, replaceExisting]);

  const legacyImportPayload = importArchive.kind === 'ready' && importArchive.selection.kind === 'legacy'
    ? importArchive.selection.payload
    : null;

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.backupRestore')} title={t('dashboard.nav.backupRestore')} />

      {runtime.error ? <Panel>
        <OutcomeMessageBar intent="error" title={t('dashboard.backupRestore.runtimeError.title')}>
          {t('dashboard.backupRestore.runtimeError.message', { message: runtime.error.message })}
        </OutcomeMessageBar>
      </Panel> : <>
        <Panel className={PANEL_STACK_CLASS}>
          <SectionHeader
            description={t(personal ? 'dashboard.backupRestore.export.personalDescription' : 'dashboard.backupRestore.export.description')}
            level={2}
            title={t('dashboard.backupRestore.export.heading')}
          />

          {personal && <Field
            hint={t('dashboard.backupRestore.export.passwordHint')}
            label={t('dashboard.backupRestore.export.password')}
          >
            <Input
              autoComplete="new-password"
              maxLength={1024}
              onChange={(_, data) => setBackupPassword(data.value)}
              type="password"
              value={backupPassword}
            />
          </Field>}

          {/* A check box rather than a switch, because nothing is exported until
            the command below is pressed: "Use a checkbox when the user has to
            perform extra steps for changes to be effective."
            https://github.com/MicrosoftDocs/windows-dev-docs/blob/d084ff89ad3d6da237a8737e325a6407ddb0ee41/hub/apps/develop/ui/controls/toggles.md#L41 */}
          <Field hint={t('dashboard.backupRestore.export.includePerformanceHint')}>
            <Checkbox
              checked={includePerformance}
              label={t('dashboard.backupRestore.export.includePerformance')}
              onChange={(_, data) => setIncludePerformance(!!data.checked)}
            />
          </Field>

          {exportError && (
            <OutcomeMessageBar onDismiss={() => setExportError(null)}>{exportError}</OutcomeMessageBar>
          )}

          <div className="pt-1">
            <ActionRow
              aria-label={t('dashboard.backupRestore.export.actionsLabel')}
              role="group"
            >
              <Button
                appearance="primary"
                disabled={personal && backupPassword.length === 0}
                disabledFocusable={exporting}
                icon={exporting ? <Spinner size="tiny" /> : <ArrowDownloadRegular />}
                onClick={() => void handleExport(personal ? 'full' : 'legacy')}
              >
                {t(personal ? 'dashboard.backupRestore.export.fullButton' : 'dashboard.backupRestore.export.button')}
              </Button>
              {personal && <Button
                disabledFocusable={exporting}
                icon={<ArrowDownloadRegular />}
                onClick={() => void handleExport('safe')}
              >
                {t('dashboard.backupRestore.export.safeButton')}
              </Button>}
            </ActionRow>
          </div>
        </Panel>

        <Panel className={PANEL_STACK_CLASS}>
          <SectionHeader
            description={t(personal ? 'dashboard.backupRestore.import.personalDescription' : 'dashboard.backupRestore.import.description')}
            level={2}
            title={t('dashboard.backupRestore.import.heading')}
          />

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileSelect}
          />

          {importArchive.kind === 'ready'
            ? <BackupFileSummary
                accepting={dragOver}
                action={<Button disabled={importing} onClick={handleChangeFile}>
                  {t('dashboard.backupRestore.import.change')}
                </Button>}
                drop={dropHandlers}
                name={t('dashboard.backupRestore.import.fileSelected', {
                  name: importArchive.file.name,
                  size: importArchive.file.size,
                })}
              />
            : <BackupFilePicker
                accepting={dragOver}
                drop={dropHandlers}
                glyph={<ArrowUploadRegular fontSize={28} />}
                onClick={openFilePicker}
                prompt={dragOver
                  ? t('dashboard.backupRestore.import.dropzoneActive')
                  : t('dashboard.backupRestore.import.dropzone')}
              />}

          {legacyImportPayload && <BackupFileStats items={PREVIEW_LABEL_KEYS.map(key => ({
            key,
            label: t(`dashboard.backupRestore.import.previewLabel.${key}`),
            value: formatCount(countRecords(legacyImportPayload.data)[key], locale),
          }))} />}

          {importArchive.kind === 'ready' && importArchive.selection.kind === 'encrypted' && <Field
            hint={t('dashboard.backupRestore.import.passwordHint')}
            label={t('dashboard.backupRestore.import.password')}
          >
            <Input
              autoComplete="current-password"
              disabled={importing}
              maxLength={1024}
              onChange={(_, data) => setRestorePassword(data.value)}
              type="password"
              value={restorePassword}
            />
          </Field>}

          {importArchive.kind === 'ready' && <Field hint={t(personal
            ? 'dashboard.backupRestore.import.replaceHintPersonal'
            : 'dashboard.backupRestore.import.replaceHint')}>
            <Checkbox
              checked={replaceExisting}
              disabled={importing}
              label={t('dashboard.backupRestore.import.replace')}
              onChange={(_, data) => setReplaceExisting(!!data.checked)}
            />
          </Field>}

          {importArchive.kind === 'ready' && replaceExisting && (
            <OutcomeMessageBar intent="warning">
              {t(personal
                ? 'dashboard.backupRestore.import.replaceWarningPersonal'
                : 'dashboard.backupRestore.import.replaceWarning')}
            </OutcomeMessageBar>
          )}

          {importArchive.kind !== 'reading' && importArchive.error && (
            <OutcomeMessageBar
              onDismiss={() => setImportArchive(current => current.kind === 'reading' ? current : { ...current, error: null })}
              title={t('dashboard.backupRestore.import.error')}
            >
              {importArchive.error.message}
            </OutcomeMessageBar>
          )}

          <div className="pt-1">
            <Button
              appearance="primary"
              disabled={importArchive.kind !== 'ready' || (importArchive.selection.kind === 'encrypted' && restorePassword.length === 0)}
              disabledFocusable={importing}
              icon={importing ? <Spinner size="tiny" /> : <ArrowUploadRegular />}
              onClick={handleImportClick}
            >
              {t('dashboard.backupRestore.import.button')}
            </Button>
          </div>
        </Panel>

        {confirmDialog.invocation && <ConfirmDialog
          open={confirmDialog.isOpen}
          actionLabel={t('dashboard.backupRestore.import.button')}
          actionIntent="primary"
          busy={importing}
          key={confirmDialog.invocation.key}
          message={t(personal ? 'dashboard.backupRestore.confirmMessagePersonal' : 'dashboard.backupRestore.confirmMessage')}
          onConfirm={() => {
            confirmDialog.close();
            void doImport();
          }}
          onOpenChange={open => { if (!open) confirmDialog.close(); }}
          title={t('dashboard.backupRestore.confirmTitle')}
        />}
      </>}
    </section>
  );
}
