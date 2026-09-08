import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  return parseDesktopStatusValues(params.get('state'), params.get('kind'));
};

const parseDesktopStatusValues = (stateCandidate: unknown, kindCandidate: unknown): DesktopStatusView => {
  const state = stateCandidate === 'failed' ? 'failed' : 'starting';
  const candidate = typeof kindCandidate === 'string' ? kindCandidate : null;
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
  const [status, setStatus] = useState(() => parseDesktopStatus(params));
  const [ipcReady, setIpcReady] = useState(false);
  const failed = status.state === 'failed';
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<{ readonly kind?: unknown; readonly state?: unknown }>(
        'floway-desktop-status',
        event => setStatus(parseDesktopStatusValues(event.payload.state, event.payload.kind)),
      );
      const current = await invoke<{ readonly kind?: unknown; readonly state?: unknown }>('desktop_runtime_status');
      if (!disposed) {
        setStatus(parseDesktopStatusValues(current.state, current.kind));
        setIpcReady(true);
      } else unlisten();
    })().catch(() => {
      console.error('Floway could not synchronize the desktop runtime status');
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (!ipcReady || !failed || surface.current === null) return;
    if (!isTauri()) return;
    const title = surface.current.querySelector('h1')?.textContent?.trim();
    const message = surface.current.querySelector('p')?.textContent?.trim();
    const restart = surface.current.querySelector<HTMLAnchorElement>('a[href="floway-action://restart"]');
    const logs = surface.current.querySelector<HTMLAnchorElement>('a[href="floway-action://open-logs"]');
    const locale = document.documentElement.lang;
    if (title === undefined || message === undefined || restart === null || logs === null) return;
    void invoke('report_desktop_rendered_surface', {
      surface: {
        failureKind: status.failureKind,
        locale,
        logsHref: logs.href,
        logsLabel: logs.textContent?.trim() ?? '',
        message,
        restartHref: restart.href,
        restartLabel: restart.textContent?.trim() ?? '',
        title,
      },
    }).catch(() => {
      console.error('Floway could not report the rendered desktop recovery surface');
    });
  }, [failed, i18n.resolvedLanguage, ipcReady, status.failureKind]);

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
