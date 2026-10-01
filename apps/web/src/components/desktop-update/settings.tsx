import { useDesktopUpdate } from './provider';
import { installableDesktopUpdate, updateBusy } from '../../api/desktop-update';
import { fluentComponents } from '../../fluent';
import { useTranslation, type TranslationKeyWithoutValues } from '../../i18n/translation';
import { formatBytes } from '../../lib/format-number';
import { dateTime } from '../../lib/format-time';
import { ActionRow } from '../ui/action-row';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';

const { Button, ProgressBar, Spinner, Text } = fluentComponents;
const phaseKeys = {
  idle: 'dashboard.settings.desktop.update.idle',
  disabled: 'dashboard.settings.desktop.update.disabled',
  checking: 'dashboard.settings.desktop.update.checking',
  upToDate: 'dashboard.settings.desktop.update.upToDate',
  downloading: 'dashboard.settings.desktop.update.downloading',
  verifying: 'dashboard.settings.desktop.update.verifying',
  ready: 'dashboard.settings.desktop.update.ready',
  installing: 'dashboard.settings.desktop.update.installing',
  error: 'dashboard.settings.desktop.update.failed',
} as const satisfies Record<string, TranslationKeyWithoutValues>;
const failureKeys = {
  check: 'dashboard.settings.desktop.update.checkFailed',
  download: 'dashboard.settings.desktop.update.downloadFailed',
  signature: 'dashboard.settings.desktop.update.signatureFailed',
  install: 'dashboard.settings.desktop.update.installFailed',
  'recovery-point': 'dashboard.settings.desktop.update.recoveryFailed',
  health: 'dashboard.settings.desktop.update.healthFailed',
} as const satisfies Record<string, TranslationKeyWithoutValues>;

export function DesktopUpdateSettings() {
  const update = useDesktopUpdate();
  const { t, i18n } = useTranslation();
  if (!update) return null;
  const { snapshot, pending } = update;
  const busy = pending || !snapshot || updateBusy(snapshot);
  const ready = !!snapshot && installableDesktopUpdate(snapshot);
  const downloading = snapshot?.phase === 'downloading';
  const progress = snapshot?.totalBytes ? Math.min(1, snapshot.receivedBytes / snapshot.totalBytes) : undefined;
  const phase = snapshot && ready && !updateBusy(snapshot) ? 'ready' : snapshot?.phase;

  return <div className={SECTION_STACK_CLASS}>
    <Text weight="semibold">{t('dashboard.settings.desktop.update.title')}</Text>
    <div aria-live="polite" role="status">
      {((!snapshot && !update.error) || snapshot?.phase === 'checking') && <Spinner label={t('dashboard.settings.desktop.update.checking')} size="tiny" />}
      {phase && phase !== 'checking' && <Text>{t(phaseKeys[phase])}</Text>}
    </div>
    {snapshot?.version && <Text>{t('dashboard.settings.desktop.update.targetVersion', { version: ready && !updateBusy(snapshot) ? snapshot.stagedVersion! : snapshot.version })}</Text>}
    {(downloading || snapshot?.phase === 'verifying') && <>
      <ProgressBar aria-label={t(downloading ? 'dashboard.settings.desktop.update.downloading' : 'dashboard.settings.desktop.update.verifying')} value={downloading ? progress : undefined} />
      {downloading && <Text size={200} className="text-fui-fg2">
        {snapshot.totalBytes
          ? t('dashboard.settings.desktop.update.progress', { received: formatBytes(snapshot.receivedBytes, i18n.language), total: formatBytes(snapshot.totalBytes, i18n.language) })
          : t('dashboard.settings.desktop.update.received', { received: formatBytes(snapshot.receivedBytes, i18n.language) })}
      </Text>}
    </>}
    {snapshot?.checkedAt != null && <Text className="text-fui-fg2" size={200}>
      {t('dashboard.settings.desktop.update.lastCheck', { time: dateTime(snapshot.checkedAt * 1000, i18n.language) })}
    </Text>}
    {snapshot?.failure && <OutcomeMessageBar>{t(failureKeys[snapshot.failure.phase])}</OutcomeMessageBar>}
    {update.error && <OutcomeMessageBar>{t('dashboard.settings.desktop.update.actionFailed')}</OutcomeMessageBar>}
    <ActionRow>
      {ready && <Button appearance="primary" disabled={busy} onClick={update.install}>{t('dashboard.settings.desktop.update.install')}</Button>}
      <Button disabled={pending || (snapshot ? updateBusy(snapshot) || snapshot.phase === 'disabled' : !update.error)} onClick={update.check}>
        {t('dashboard.settings.desktop.update.check')}
      </Button>
      {(!!snapshot?.version || ready) && <Button disabled={pending} onClick={update.viewNotes}>{t('dashboard.settings.desktop.update.viewNotes')}</Button>}
    </ActionRow>
  </div>;
}
