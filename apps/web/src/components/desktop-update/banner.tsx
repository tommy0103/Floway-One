import { useDesktopUpdate } from './provider';
import { installableDesktopUpdate, updateBusy } from '../../api/desktop-update';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { ActionRow } from '../ui/action-row';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';

const { Button } = fluentComponents;

export function DesktopUpdateBanner() {
  const update = useDesktopUpdate();
  const { t } = useTranslation();
  const snapshot = update?.snapshot;
  const version = snapshot?.stagedVersion;
  if (!update || !snapshot || !version || version === snapshot.dismissedVersion || !installableDesktopUpdate(snapshot) || updateBusy(snapshot)) return null;
  return <OutcomeMessageBar
    action={<ActionRow>
      <Button appearance="primary" disabled={update.pending} onClick={update.install}>{t('dashboard.settings.desktop.update.install')}</Button>
      <Button disabled={update.pending} onClick={update.viewNotes}>{t('dashboard.settings.desktop.update.viewNotes')}</Button>
      <Button disabled={update.pending} onClick={update.later}>{t('dashboard.settings.desktop.update.later')}</Button>
    </ActionRow>}
    intent="info"
    title={t('dashboard.settings.desktop.update.readyTitle', { version })}
  >{update.error ? t('dashboard.settings.desktop.update.actionFailed') : t('dashboard.settings.desktop.update.readyDescription')}</OutcomeMessageBar>;
}
