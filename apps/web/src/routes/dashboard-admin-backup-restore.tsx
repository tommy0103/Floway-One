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

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

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
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => () => readerRef.current?.abort(), []);

  const handleFile = useCallback(
    (file: File) => {
      setImportError(null);
      readerRef.current?.abort();

      const reader = new FileReader();
      readerRef.current = reader;
      reader.onload = () => {
        readerRef.current = null;
        const raw = reader.result as string;
        if (personal) {
          const result = parseEncryptedBackupFile(raw);
          if (!result.ok) {
            setImportError(t('dashboard.backupRestore.import.errorInvalidFile', { message: result.message }));
            setImportFile(null);
            setImportSelection(null);
            return;
          }
          setImportFile(file);
          setImportSelection({ kind: 'encrypted', archive: result.archive });
          return;
        }
        const result = parseBackupFile(raw);
        if (!result.ok) {
          setImportError(t('dashboard.backupRestore.import.errorInvalidFile', { message: result.message }));
          setImportFile(null);
          setImportSelection(null);
          return;
        }
        setImportFile(file);
        setImportSelection({ kind: 'legacy', payload: result.payload });
      };
      reader.onerror = () => {
        readerRef.current = null;
        setImportError(t('dashboard.backupRestore.import.errorReadFile'));
      };
      reader.readAsText(file);
    },
    [personal, t],
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
    setImportFile(null);
    setImportSelection(null);
    setImportError(null);
    fileInputRef.current?.click();
  }, []);

  const doImport = useCallback(async () => {
    if (!importSelection) return;
    setImporting(true);
    setImportError(null);

    const handle = toasts.start(t('dashboard.backupRestore.import.pending'));
    const mode = replaceExisting ? 'replace' as const : 'merge' as const;
    const result = importSelection.kind === 'encrypted'
      ? await callApi(() => api.api.import.$post({
          json: { mode, archive: importSelection.archive, password: restorePassword },
        }))
      : await callApi(() => api.api.import.$post({
          json: legacyImportRequest(importSelection.payload, mode),
        }));

    if (result.error) {
      handle.settle();
      setImportError(result.error.message);
      setImporting(false);
      return;
    }

    setImportFile(null);
    setImportSelection(null);
    setRestorePassword('');
    setImporting(false);
    const summary = recordSummary(result.data.imported, t, locale);
    handle.succeed(summary
      ? t('dashboard.backupRestore.import.success', { summary })
      : t('dashboard.backupRestore.import.successEmpty'));
  }, [importSelection, locale, replaceExisting, restorePassword, t, toasts]);

  const handleImportClick = useCallback(() => {
    if (!importSelection) return;
    if (replaceExisting) {
      confirmDialog.open();
      return;
    }
    void doImport();
  }, [confirmDialog, doImport, importSelection, replaceExisting]);

  if (runtime.error) {
    return <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.backupRestore')} title={t('dashboard.nav.backupRestore')} />
      <Panel>
        <OutcomeMessageBar intent="error" title={t('dashboard.backupRestore.runtimeError.title')}>
          {t('dashboard.backupRestore.runtimeError.message', { message: runtime.error.message })}
        </OutcomeMessageBar>
      </Panel>
    </section>;
  }

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.backupRestore')} title={t('dashboard.nav.backupRestore')} />

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

        {importSelection && importFile
          ? <BackupFileSummary
              accepting={dragOver}
              action={<Button disabled={importing} onClick={handleChangeFile}>
                {t('dashboard.backupRestore.import.change')}
              </Button>}
              drop={dropHandlers}
              name={t('dashboard.backupRestore.import.fileSelected', {
                name: importFile.name,
                size: importFile.size,
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

        {importSelection?.kind === 'legacy' && <BackupFileStats items={PREVIEW_LABEL_KEYS.map(key => ({
          key,
          label: t(`dashboard.backupRestore.import.previewLabel.${key}`),
          value: formatCount(countRecords(importSelection.payload.data)[key], locale),
        }))} />}

        {importSelection?.kind === 'encrypted' && <Field
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

        {importSelection && <Field hint={t(personal
          ? 'dashboard.backupRestore.import.replaceHintPersonal'
          : 'dashboard.backupRestore.import.replaceHint')}>
          <Checkbox
            checked={replaceExisting}
            disabled={importing}
            label={t('dashboard.backupRestore.import.replace')}
            onChange={(_, data) => setReplaceExisting(!!data.checked)}
          />
        </Field>}

        {importSelection && replaceExisting && (
          <OutcomeMessageBar intent="warning">
            {t(personal
              ? 'dashboard.backupRestore.import.replaceWarningPersonal'
              : 'dashboard.backupRestore.import.replaceWarning')}
          </OutcomeMessageBar>
        )}

        {importError && (
          <OutcomeMessageBar
            onDismiss={() => setImportError(null)}
            title={t('dashboard.backupRestore.import.error')}
          >
            {importError}
          </OutcomeMessageBar>
        )}

        <div className="pt-1">
          <Button
            appearance="primary"
            disabled={!importSelection || (importSelection.kind === 'encrypted' && restorePassword.length === 0)}
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
    </section>
  );
}
