import { useEffect, useRef } from 'react';
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

const isFailureKind = (candidate: string): candidate is keyof typeof failureKeys =>
  Object.hasOwn(failureKeys, candidate);

export interface DesktopStatusView {
  readonly failureKind: keyof typeof failureKeys;
  readonly failureKey: (typeof failureKeys)[keyof typeof failureKeys];
  readonly state: 'failed' | 'starting';
}

export const parseDesktopStatus = (params: URLSearchParams): DesktopStatusView => {
  const state = params.get('state') === 'failed' ? 'failed' : 'starting';
  const candidate = params.get('kind');
  const failureKind = candidate !== null && isFailureKind(candidate)
    ? candidate
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
  const { i18n, t } = useTranslation();
  const [params] = useSearchParams();
  const status = parseDesktopStatus(params);
  const failed = status.state === 'failed';
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!failed || surface.current === null) return;
    const isPackagedStatus = window.location.protocol === 'tauri:'
      || (window.location.protocol === 'http:' && window.location.host === 'tauri.localhost');
    if (!isPackagedStatus) return;
    const title = surface.current.querySelector('h1')?.textContent?.trim();
    const message = surface.current.querySelector('p')?.textContent?.trim();
    const restart = surface.current.querySelector<HTMLAnchorElement>('a[href="floway-action://restart"]');
    const logs = surface.current.querySelector<HTMLAnchorElement>('a[href="floway-action://open-logs"]');
    const locale = document.documentElement.lang;
    if (title === undefined || message === undefined || restart === null || logs === null) return;
    const report = new URL('floway-action://report-rendered-surface');
    for (const [key, value] of [
      ['failureKind', status.failureKind],
      ['locale', locale],
      ['title', title],
      ['message', message],
      ['restartLabel', restart.textContent?.trim() ?? ''],
      ['restartHref', restart.href],
      ['logsLabel', logs.textContent?.trim() ?? ''],
      ['logsHref', logs.href],
    ] as const) report.searchParams.set(key, value);
    window.location.assign(report);
  }, [failed, i18n.resolvedLanguage, status.failureKind]);

  return (
    <div className="contents" ref={surface}>
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
    </div>
  );
}
