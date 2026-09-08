import { useSearchParams } from 'react-router';

import { FlowayLogo } from '../components/logo';
import { ErrorShell } from '../components/ui/error-shell';
import { StatusBadge } from '../components/ui/status-badge';
import { fluentComponents } from '../fluent';
import { useTranslation, type TranslationKey } from '../i18n/translation';

const { Button, ProgressBar } = fluentComponents;

const failureKeys = {
  asset: 'desktop.status.failures.asset',
  compatibility: 'desktop.status.failures.compatibility',
  migration: 'desktop.status.failures.migration',
  'native-dependency': 'desktop.status.failures.nativeDependency',
  port: 'desktop.status.failures.port',
  storage: 'desktop.status.failures.storage',
  timeout: 'desktop.status.failures.timeout',
  'unexpected-exit': 'desktop.status.failures.unexpectedExit',
  unknown: 'desktop.status.failures.unknown',
} as const satisfies Record<string, TranslationKey>;

export interface DesktopStatusView {
  readonly failureKind: keyof typeof failureKeys;
  readonly failureKey: (typeof failureKeys)[keyof typeof failureKeys];
  readonly state: 'failed' | 'starting';
}

export const parseDesktopStatus = (params: URLSearchParams): DesktopStatusView => {
  const state = params.get('state') === 'failed' ? 'failed' : 'starting';
  const candidate = params.get('kind');
  const failureKind = candidate !== null && candidate in failureKeys
    ? candidate as keyof typeof failureKeys
    : 'unknown';
  return {
    failureKind,
    failureKey: failureKeys[failureKind],
    state,
  };
};

export function clientLoader() {
  return null;
}

export default function DesktopStatus() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const status = parseDesktopStatus(params);
  const failed = status.state === 'failed';

  return (
    <ErrorShell
      action={failed
        ? <>
            <Button appearance="primary" as="a" href="floway-action://restart">
              {t('desktop.status.restart')}
            </Button>
            <Button as="a" href="floway-action://open-logs">
              {t('desktop.status.openLogs')}
            </Button>
          </>
        : undefined}
      header={
        <div className="flex w-full items-center justify-between">
          <FlowayLogo />
          <StatusBadge tone={failed ? 'danger' : 'accent'}>
            {t(failed ? 'desktop.status.attention' : 'desktop.status.startingBadge')}
          </StatusBadge>
        </div>
      }
      message={failed
        ? <>
            <span data-desktop-failure-kind={status.failureKind}>{t(status.failureKey)}</span>{' '}
            <span data-desktop-diagnostics="logs-only">{t('desktop.status.detailsInLogs')}</span>
          </>
        : t('desktop.status.startingDescription')}
      title={t(failed ? 'desktop.status.failedTitle' : 'desktop.status.startingTitle')}
    >
      {!failed && <ProgressBar aria-label={t('desktop.status.startingBadge')} className="w-full" thickness="large" />}
    </ErrorShell>
  );
}
