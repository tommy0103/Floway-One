import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useState } from 'react';
import { redirect } from 'react-router';

import packageManifest from '../../package.json' with { type: 'json' };
import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-overview';
import { requireDashboardSession } from './guards';
import { loadRuntimeInfo } from '../api/runtime-info';
import {
  loadOverviewSnapshot,
  mergeOverviewSnapshot,
  type OverviewSnapshot,
} from '../components/overview/data';
import { FailureLine, OverviewPanel } from '../components/overview/panel';
import { errorLabel, requestSeverity } from '../components/requests/format';
import { RequestSeverityIcon } from '../components/requests/severity-icon';
import { ActionRow } from '../components/ui/action-row';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { HttpStatusBadge } from '../components/ui/http-badge';
import {
  PANEL_STACK_CLASS,
  STATUS_DETAILS_CLASS,
  STATUS_HEADER_CLASS,
} from '../components/ui/layout';
import { OpenLogsButton } from '../components/ui/open-logs-button';
import { Panel } from '../components/ui/panel';
import { useRouteAddress } from '../components/ui/route-link';
import { SectionHeader } from '../components/ui/section-header';
import { StatusBadge } from '../components/ui/status-badge';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../components/ui/use-copy-to-clipboard';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { dateTime, relativeTime, shortDate } from '../lib/format-time';
import { useLocale } from '../lib/use-locale';
import { useNow } from '../lib/use-now';

const { Button, Text, Tooltip } = fluentComponents;

interface LoaderData {
  endpoint: string;
  version: string;
  snapshot: OverviewSnapshot;
}

export async function clientLoader(): Promise<LoaderData> {
  requireDashboardSession();
  const runtime = await loadRuntimeInfo();
  // The overview is the personal profile's landing page. Server mode keeps its
  // established landing instead of gaining a second one.
  if (runtime.profile.mode !== 'personal') throw redirect('/dashboard/playground');
  return {
    // The Dashboard and the gateway share one origin, so the address this page
    // was served from is the endpoint -- and it carries no credential.
    endpoint: window.location.origin,
    version: packageManifest.version,
    snapshot: await loadOverviewSnapshot(),
  };
}

// The relative readings count down on the wall clock at the request list's tick.
const NOW_TICK_MS = 30_000;

export default function DashboardOverview({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(NOW_TICK_MS);
  const copyLabel = useCopyLabel();
  const { copy, outcomeFor } = useCopyToClipboard();
  // Tied to the navigation it came from: a fresh loader commits its own
  // snapshot instead of holding the last page's readings under a new URL.
  const [replacement, setReplacement] = useState<{ source: LoaderData; snapshot: OverviewSnapshot } | null>(null);
  const snapshot = replacement?.source === loaderData ? replacement.snapshot : loaderData.snapshot;

  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }) => {
    const next = await loadOverviewSnapshot(signal);
    if (signal.aborted) return;
    setReplacement(current => ({
      source: loaderData,
      snapshot: mergeOverviewSnapshot(
        current?.source === loaderData ? current.snapshot : loaderData.snapshot,
        next,
        { background },
      ),
    }));
  }, [loaderData]);
  const { poll } = useRefresh(reload);
  usePollWhileVisible(poll);

  const endpointOutcome = outcomeFor('endpoint');
  const healthy = snapshot.health.value !== null;

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.overview')} title={t('dashboard.nav.overview')} />

      {/* The gateway panel cannot take the shared OverviewPanel shape: the
          endpoint and the version are page facts that must stay on screen even
          when the health reading has failed. */}
      <Panel className={`${PANEL_STACK_CLASS} w-full`}>
        <div className={STATUS_HEADER_CLASS}>
          <SectionHeader level={2} title={t('dashboard.overview.gateway.title')} />
          <StatusBadge tone={healthy ? 'success' : 'danger'}>
            {t(healthy ? 'dashboard.overview.gateway.healthy' : 'dashboard.overview.gateway.unavailable')}
          </StatusBadge>
        </div>
        {snapshot.health.failure !== null && <FailureLine failure={snapshot.health.failure} />}
        <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
          <dt className="text-fui-fg2">{t('dashboard.overview.gateway.endpoint')}</dt>
          <dd className="m-0 font-mono flex items-center gap-1 min-w-0">
            <span className="truncate min-w-0">{loaderData.endpoint}</span>
            <TooltipIconButton
              icon={copyOutcomeIcon(endpointOutcome)}
              label={copyLabel(endpointOutcome, t('dashboard.overview.gateway.copyEndpoint'))}
              onClick={() => copy(loaderData.endpoint, 'endpoint')}
            />
          </dd>
          <dt className="text-fui-fg2">{t('dashboard.overview.gateway.version')}</dt>
          <dd className="m-0 font-mono">{loaderData.version}</dd>
        </dl>
      </Panel>

      <div className="dashboard-page-columns">
        <OverviewPanel
          badge={snapshot.upstreams.value !== null && snapshot.upstreams.value.failing > 0
            ? <StatusBadge tone="danger">{t('dashboard.overview.upstreams.failing', { count: snapshot.upstreams.value.failing })}</StatusBadge>
            : undefined}
          openLabel={t('dashboard.overview.upstreams.open')}
          openTo="/dashboard/providers/upstreams"
          region={snapshot.upstreams}
          title={t('dashboard.overview.upstreams.title')}
        >
          {upstreams => upstreams.total === 0
            ? <Text size={200} className="text-fui-fg2">{t('dashboard.overview.upstreams.empty')}</Text>
            : <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
                <dt className="text-fui-fg2">{t('dashboard.overview.upstreams.totalLabel')}</dt>
                <dd className="m-0">{t('dashboard.overview.upstreams.total', { count: upstreams.total })}</dd>
                <dt className="text-fui-fg2">{t('dashboard.overview.upstreams.failingLabel')}</dt>
                <dd className="m-0">{upstreams.failing === 0
                  ? t('dashboard.overview.upstreams.noneFailing')
                  : t('dashboard.overview.upstreams.failing', { count: upstreams.failing })}</dd>
              </dl>}
        </OverviewPanel>

        <OverviewPanel
          openLabel={t('dashboard.overview.keys.open')}
          openTo="/dashboard/services/api-keys"
          region={snapshot.keys}
          title={t('dashboard.overview.keys.title')}
        >
          {keys => keys.total === 0
            ? <Text size={200} className="text-fui-fg2">{t('dashboard.overview.keys.empty')}</Text>
            : <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
                <dt className="text-fui-fg2">{t('dashboard.overview.keys.totalLabel')}</dt>
                <dd className="m-0">{t('dashboard.overview.keys.total', { count: keys.total })}</dd>
                <dt className="text-fui-fg2">{t('dashboard.overview.keys.lastUsedLabel')}</dt>
                <dd className="m-0">{keys.lastUsedAt === null
                  ? t('dashboard.overview.keys.neverUsed')
                  : relativeTime(keys.lastUsedAt, locale, { now }) ?? t('dashboard.overview.keys.lastUsedOn', { date: shortDate(keys.lastUsedAt, locale) })}</dd>
              </dl>}
        </OverviewPanel>
      </div>

      <OverviewPanel
        openLabel={t('dashboard.overview.recentRequest.open')}
        openTo="/dashboard/monitor/requests"
        region={snapshot.recentRequest}
        title={t('dashboard.overview.recentRequest.title')}
      >
        {reading => <RecentRequestReading locale={locale} now={now} reading={reading} />}
      </OverviewPanel>

      <Panel className={`${PANEL_STACK_CLASS} w-full`}>
        <SectionHeader level={2} title={t('dashboard.overview.diagnostics.title')} />
        <ActionRow>
          <DiagnosticsButton to="/dashboard/monitor/requests">{t('dashboard.nav.requests')}</DiagnosticsButton>
          <DiagnosticsButton to="/dashboard/monitor/usage">{t('dashboard.nav.usage')}</DiagnosticsButton>
          <DiagnosticsButton to="/dashboard/monitor/performance">{t('dashboard.nav.performance')}</DiagnosticsButton>
          {isTauri() && <OpenLogsButton />}
        </ActionRow>
      </Panel>
    </section>
  );
}

function DiagnosticsButton({ children, to }: { children: string; to: string }) {
  const address = useRouteAddress(to);
  return <Button {...address} as="a">{children}</Button>;
}

function RecentRequestReading({ locale, now, reading }: {
  locale: string;
  now: number;
  reading: Exclude<OverviewSnapshot['recentRequest']['value'], null>;
}) {
  const { t } = useTranslation();
  if (reading.kind === 'capture-off') {
    return <Text size={200} className="text-fui-fg2">{t('dashboard.overview.recentRequest.captureOff')}</Text>;
  }
  if (reading.kind === 'no-records') {
    return <Text size={200} className="text-fui-fg2">{t('dashboard.overview.recentRequest.empty')}</Text>;
  }
  const { record } = reading;
  const severity = requestSeverity(record.status, record.error);
  const failure = errorLabel(record.error, record.status);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <RequestSeverityIcon severity={severity} />
      <span className="sr-only">{t(`dashboard.requests.status.${severity}`)}</span>
      <Text size={300} className="min-w-0 font-mono" truncate wrap={false}>
        {record.model ?? t('dashboard.requests.unknownModel')}
      </Text>
      <HttpStatusBadge severity={severity}>
        {record.status ?? t('dashboard.requests.noStatus')}
      </HttpStatusBadge>
      {failure !== null && <Text size={200} className="min-w-0 text-fui-fg2" truncate wrap={false}>{failure}</Text>}
      <Tooltip content={dateTime(record.startedAt, locale)} relationship="description">
        <Text size={200} className="ml-auto shrink-0 text-fui-fg3" wrap={false}>
          {relativeTime(record.startedAt, locale, { now }) ?? shortDate(record.startedAt, locale)}
        </Text>
      </Tooltip>
    </div>
  );
}
