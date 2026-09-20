import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button } = fluentComponents;

// The desktop shell owns the floway-action scheme: the navigation guard turns
// it into opening the log directory on the host. Render only where isTauri()
// has already established the shell is there to answer.
//
// desktop-status stays on its own anchor instead: that surface is the recovery
// page the shell paints when the runtime may never come up, and it must not
// pick up behaviour from a control the running dashboard can change.
export function OpenLogsButton() {
  const { t } = useTranslation();
  return <Button as="a" href="floway-action://open-logs">{t('dashboard.settings.desktop.openLogs')}</Button>;
}
