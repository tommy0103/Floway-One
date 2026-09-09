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
  readonly logsAvailable: boolean;
  readonly restartEnabled: boolean;
  readonly revision: number;
  readonly state: 'failed' | 'starting';
}

export const parseDesktopStatus = (params: URLSearchParams): DesktopStatusView => {
  return parseDesktopStatusValues(params.get('state'), params.get('kind'));
};

const parseDesktopStatusValues = (
  stateCandidate: unknown,
  kindCandidate: unknown,
  restartEnabledCandidate: unknown = false,
  logsAvailableCandidate: unknown = false,
  revisionCandidate: unknown = 0,
): DesktopStatusView => {
  const state = stateCandidate === 'failed' ? 'failed' : 'starting';
  const candidate = typeof kindCandidate === 'string' ? kindCandidate : null;
  const failureKind = candidate !== null && isFailureKind(candidate)
    ? candidate
    : 'unknown';
  const revision = typeof revisionCandidate === 'number'
    && Number.isSafeInteger(revisionCandidate)
    && revisionCandidate >= 0
    ? revisionCandidate
    : 0;
  return {
    failureKind,
    failureKey: failureKeys[failureKind],
    logsAvailable: state === 'failed' && logsAvailableCandidate === true,
    restartEnabled: state === 'failed' && restartEnabledCandidate === true,
    revision,
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
      unlisten = await listen<{
        readonly kind?: unknown;
        readonly logsAvailable?: unknown;
        readonly restartEnabled?: unknown;
        readonly revision?: unknown;
        readonly state?: unknown;
      }>(
        'floway-desktop-status',
        event => {
          const next = parseDesktopStatusValues(
            event.payload.state,
            event.payload.kind,
            event.payload.restartEnabled,
            event.payload.logsAvailable,
            event.payload.revision,
          );
          setStatus(current => next.revision > current.revision ? next : current);
        },
      );
      const current = await invoke<{
        readonly kind?: unknown;
        readonly logsAvailable?: unknown;
        readonly restartEnabled?: unknown;
        readonly revision?: unknown;
        readonly state?: unknown;
      }>('desktop_runtime_status');
      if (!disposed) {
        const next = parseDesktopStatusValues(
          current.state,
          current.kind,
          current.restartEnabled,
          current.logsAvailable,
          current.revision,
        );
        setStatus(status => next.revision > status.revision ? next : status);
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
    const locale = i18n.resolvedLanguage === 'zh-Hans' ? 'zh-Hans' : 'en';
    void invoke('report_desktop_recovery_surface', {
      surface: {
        actions: [
          ...(status.restartEnabled ? ['restart'] : []),
          ...(status.logsAvailable ? ['open-logs'] : []),
        ],
        failureKind: status.failureKind,
        logsAvailable: status.logsAvailable,
        locale,
        restartEnabled: status.restartEnabled,
        revision: status.revision,
      },
    }).catch(() => {
      console.error('Floway could not report the rendered desktop recovery surface');
    });
  }, [failed, i18n.resolvedLanguage, ipcReady, status.failureKind, status.logsAvailable, status.restartEnabled, status.revision]);

  return (
    <div className="contents" ref={surface}>
      <ErrorShell
        action={failed
          ? <>
              <Button
                appearance="primary"
                as="a"
                disabled={!status.restartEnabled}
                href={status.restartEnabled ? 'floway-action://restart' : undefined}
              >
                {t('desktop.status.restart')}
              </Button>
              {status.logsAvailable
                ? <Button as="a" href="floway-action://open-logs">
                    {t('desktop.status.openLogs')}
                  </Button>
                : null}
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
              <span data-desktop-diagnostics={status.logsAvailable ? 'logs' : 'standard-error'}>
                {t(status.logsAvailable ? 'desktop.status.detailsInLogs' : 'desktop.status.detailsInStandardError')}
              </span>
            </>
          : t('desktop.status.startingDescription')}
        title={t(failed ? 'desktop.status.failedTitle' : 'desktop.status.startingTitle')}
      >
        {!failed && <ProgressBar aria-label={t('desktop.status.startingBadge')} className="w-full" thickness="large" />}
      </ErrorShell>
    </div>
  );
}
