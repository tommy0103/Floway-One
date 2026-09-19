import {
  CheckmarkCircleRegular,
  DismissCircleRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { isTauri } from '@tauri-apps/api/core';
import { useCallback, useState } from 'react';
import { redirect } from 'react-router';

import packageManifest from '../../package.json' with { type: 'json' };
import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-overview';
import { requireDashboardSession } from './guards';
import { loadRuntimeInfo } from '../api/runtime-info';
import { loadOverviewSnapshot, type OverviewSnapshot } from '../components/overview/data';
import { errorLabel, requestSeverity } from '../components/requests/format';
import { ActionRow } from '../components/ui/action-row';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { HttpStatusBadge } from '../components/ui/http-badge';
import {
  PANEL_STACK_CLASS,
  STATUS_DETAILS_CLASS,
  STATUS_HEADER_CLASS,
  TWO_COLUMN_FORM_CLASS,
} from '../components/ui/layout';
import { OpenLinkLabel } from '../components/ui/open-link-label';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { RouteLink, useRouteAddress } from '../components/ui/route-link';
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

  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await loadOverviewSnapshot(signal);
    if (signal.aborted) return;
    setReplacement({ source: loaderData, snapshot: next });
  }, [loaderData]);
  const { poll } = useRefresh(reload);
  usePollWhileVisible(poll);

  const endpointOutcome = outcomeFor('endpoint');

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.overview')} title={t('dashboard.nav.overview')} />

      <Panel className={`${PANEL_STACK_CLASS} w-full`}>
        <div className={STATUS_HEADER_CLASS}>
          <SectionHeader level={2} title={t('dashboard.overview.gateway.title')} />
          <StatusBadge tone={snapshot.health.ok ? 'success' : 'danger'}>
            {t(snapshot.health.ok ? 'dashboard.overview.gateway.healthy' : 'dashboard.overview.gateway.unavailable')}
          </StatusBadge>
        </div>
        {snapshot.health.error !== null && <OutcomeMessageBar>{snapshot.health.error}</OutcomeMessageBar>}
        <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
          <dt className="text-fui-fg2">{t('dashboard.overview.gateway.endpoint')}</dt>
          <dd className="m-0 font-mono flex items-center gap-1 min-w-0">
            <span className="truncate">{loaderData.endpoint}</span>
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

      <div className={`${TWO_COLUMN_FORM_CLASS} gap-[18px]`}>
        <Panel className={`${PANEL_STACK_CLASS} w-full`}>
          <div className={STATUS_HEADER_CLASS}>
            <SectionHeader level={2} title={t('dashboard.overview.upstreams.title')} />
            {snapshot.upstreams !== null && snapshot.upstreams.failing > 0 && (
              <StatusBadge tone="danger">{t('dashboard.overview.upstreams.failing', { count: snapshot.upstreams.failing })}</StatusBadge>
            )}
          </div>
          {snapshot.upstreamsError !== null
            ? <OutcomeMessageBar>{snapshot.upstreamsError}</OutcomeMessageBar>
            : snapshot.upstreams !== null && <>
              <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
                <dt className="text-fui-fg2">{t('dashboard.overview.upstreams.totalLabel')}</dt>
                <dd className="m-0">{t('dashboard.overview.upstreams.total', { count: snapshot.upstreams.total })}</dd>
                <dt className="text-fui-fg2">{t('dashboard.overview.upstreams.failingLabel')}</dt>
                <dd className="m-0">{snapshot.upstreams.failing === 0
                  ? t('dashboard.overview.upstreams.noneFailing')
                  : t('dashboard.overview.upstreams.failing', { count: snapshot.upstreams.failing })}</dd>
              </dl>
              {snapshot.upstreams.total === 0 && (
                <Text size={200} className="text-fui-fg2">{t('dashboard.overview.upstreams.empty')}</Text>
              )}
            </>}
          <div>
            <RouteLink to="/dashboard/providers/upstreams">
              <OpenLinkLabel>{t('dashboard.overview.upstreams.open')}</OpenLinkLabel>
            </RouteLink>
          </div>
        </Panel>

        <Panel className={`${PANEL_STACK_CLASS} w-full`}>
          <SectionHeader level={2} title={t('dashboard.overview.keys.title')} />
          {snapshot.keysError !== null
            ? <OutcomeMessageBar>{snapshot.keysError}</OutcomeMessageBar>
            : snapshot.keys !== null && <>
              <dl className={`${STATUS_DETAILS_CLASS} text-sm`}>
                <dt className="text-fui-fg2">{t('dashboard.overview.keys.totalLabel')}</dt>
                <dd className="m-0">{t('dashboard.overview.keys.total', { count: snapshot.keys.total })}</dd>
                <dt className="text-fui-fg2">{t('dashboard.overview.keys.lastUsedLabel')}</dt>
                <dd className="m-0">{snapshot.keys.lastUsedAt === null
                  ? t('dashboard.overview.keys.neverUsed')
                  : relativeTime(snapshot.keys.lastUsedAt, locale, { now }) ?? t('dashboard.overview.keys.lastUsedOn', { date: shortDate(snapshot.keys.lastUsedAt, locale) })}</dd>
              </dl>
              {snapshot.keys.total === 0 && (
                <Text size={200} className="text-fui-fg2">{t('dashboard.overview.keys.empty')}</Text>
              )}
            </>}
          <div>
            <RouteLink to="/dashboard/services/api-keys">
              <OpenLinkLabel>{t('dashboard.overview.keys.open')}</OpenLinkLabel>
            </RouteLink>
          </div>
        </Panel>
      </div>

      <Panel className={`${PANEL_STACK_CLASS} w-full`}>
        <SectionHeader level={2} title={t('dashboard.overview.recentRequest.title')} />
        {snapshot.recentRequestError !== null
          ? <OutcomeMessageBar>{snapshot.recentRequestError}</OutcomeMessageBar>
          : snapshot.recentRequest !== null && <RecentRequestReading locale={locale} now={now} reading={snapshot.recentRequest} />}
        <div>
          <RouteLink to="/dashboard/monitor/requests">
            <OpenLinkLabel>{t('dashboard.overview.recentRequest.open')}</OpenLinkLabel>
          </RouteLink>
        </div>
      </Panel>

      <Panel className={`${PANEL_STACK_CLASS} w-full`}>
        <SectionHeader level={2} title={t('dashboard.overview.diagnostics.title')} />
        <ActionRow>
          <DiagnosticsButton to="/dashboard/monitor/requests">{t('dashboard.nav.requests')}</DiagnosticsButton>
          <DiagnosticsButton to="/dashboard/monitor/usage">{t('dashboard.nav.usage')}</DiagnosticsButton>
          <DiagnosticsButton to="/dashboard/monitor/performance">{t('dashboard.nav.performance')}</DiagnosticsButton>
          {isTauri() && <Button as="a" href="floway-action://open-logs">{t('dashboard.settings.desktop.openLogs')}</Button>}
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
  reading: Exclude<OverviewSnapshot['recentRequest'], null>;
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
  const StatusIcon = severity === 'success' ? CheckmarkCircleRegular : severity === 'warning' ? WarningRegular : DismissCircleRegular;
  const severityClass = severity === 'success'
    ? 'text-[var(--winui-system-fill-success)]'
    : severity === 'warning' ? 'text-[var(--winui-system-fill-caution)]' : 'text-[var(--winui-system-fill-critical)]';
  const failure = errorLabel(record.error, record.status);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <StatusIcon aria-label={t(`dashboard.requests.status.${severity}`)} className={`block flex-none ${severityClass}`} fontSize={20} />
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
