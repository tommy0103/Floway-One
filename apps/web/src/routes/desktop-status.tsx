import { useSearchParams } from 'react-router';

import { FlowayLogo } from '../components/logo';
import { StatusBadge } from '../components/ui/status-badge';
import { fluentComponents } from '../fluent';
import { useTranslation, type TranslationKey } from '../i18n/translation';

const { Button, ProgressBar, Text, Title2 } = fluentComponents;

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
  readonly detail: string | null;
  readonly failureKey: (typeof failureKeys)[keyof typeof failureKeys];
  readonly state: 'failed' | 'starting';
}

export const parseDesktopStatus = (params: URLSearchParams): DesktopStatusView => {
  const state = params.get('state') === 'failed' ? 'failed' : 'starting';
  const kind = params.get('kind');
  return {
    detail: params.get('detail'),
    failureKey: failureKeys[kind as keyof typeof failureKeys] ?? failureKeys.unknown,
    state,
  };
};

export default function DesktopStatus() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const status = parseDesktopStatus(params);
  const failed = status.state === 'failed';

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-fui-bg2 p-6 text-fui-fg1">
      <section
        aria-labelledby="desktop-status-title"
        className="grid w-full max-w-[640px] gap-6 rounded-xl border border-solid border-fui-divider bg-fui-bg1 p-8 shadow-lg max-[680px]:p-6"
      >
        <div className="flex items-center justify-between gap-4">
          <FlowayLogo />
          <StatusBadge tone={failed ? 'danger' : 'accent'}>
            {t(failed ? 'desktop.status.attention' : 'desktop.status.startingBadge')}
          </StatusBadge>
        </div>

        <div className="grid gap-2">
          <Title2 as="h1" id="desktop-status-title">
            {t(failed ? 'desktop.status.failedTitle' : 'desktop.status.startingTitle')}
          </Title2>
          <Text className="max-w-[68ch] text-fui-fg2">
            {t(failed ? status.failureKey : 'desktop.status.startingDescription')}
          </Text>
        </div>

        {failed
          ? <>
              {status.detail && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-fui-bg3 p-3 font-mono text-xs leading-5 text-fui-fg2">{status.detail}</pre>}
              <div className="flex flex-wrap gap-2">
                <Button appearance="primary" as="a" href="floway-action://restart">
                  {t('desktop.status.restart')}
                </Button>
                <Button as="a" href="floway-action://open-logs">
                  {t('desktop.status.openLogs')}
                </Button>
              </div>
            </>
          : <ProgressBar aria-label={t('desktop.status.startingBadge')} thickness="large" />}
      </section>
    </main>
  );
}
