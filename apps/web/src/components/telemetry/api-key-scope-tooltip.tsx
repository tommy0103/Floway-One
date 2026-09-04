import { InfoRegular } from '@fluentui/react-icons';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { CONTROL_ROW_CLASS } from '../ui/layout';

const { Button, Tooltip } = fluentComponents;

export function ApiKeyScopeTooltip({ personalProfile }: { personalProfile: boolean }) {
  const { t } = useTranslation();
  const scope = personalProfile ? 'personal' : 'server';
  return <Tooltip content={t(`dashboard.telemetry.apiKeyScope.${scope}.info`)} relationship="description">
    <Button
      appearance="subtle"
      aria-label={t(`dashboard.telemetry.apiKeyScope.${scope}.label`)}
      className={CONTROL_ROW_CLASS}
      icon={<InfoRegular />}
    />
  </Tooltip>;
}
