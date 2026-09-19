import type { ReactNode } from 'react';

import type { OverviewRegion, OverviewRegionFailure } from './data';
import { useTranslation } from '../../i18n/translation';
import { PANEL_STACK_CLASS, STATUS_HEADER_CLASS } from '../ui/layout';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { RouteLink } from '../ui/route-link';
import { SectionHeader } from '../ui/section-header';

// One region of the overview: its heading and optional status badge, its
// failure when the reading failed, and its way into the detailed surface that
// owns the data. Every summary panel takes this shape so a new region cannot
// invent its own failure or empty handling.
export function OverviewPanel<T>({ badge, children, openLabel, openTo, region, title }: {
  badge?: ReactNode;
  children: (value: T) => ReactNode;
  openLabel: string;
  openTo: string;
  region: OverviewRegion<T>;
  title: string;
}) {
  return <Panel className={`${PANEL_STACK_CLASS} w-full`}>
    <div className={STATUS_HEADER_CLASS}>
      <SectionHeader level={2} title={title} />
      {badge}
    </div>
    {region.failure !== null
      ? <FailureLine failure={region.failure} />
      : region.value !== null && children(region.value)}
    <div>
      <RouteLink to={openTo}>
        <OpenLinkLabel>{openLabel}</OpenLinkLabel>
      </RouteLink>
    </div>
  </Panel>;
}

// The region's own words when the gateway gave it any; the shared unavailable
// line when the answer was outside the contract.
export function FailureLine({ failure }: { failure: OverviewRegionFailure }) {
  const { t } = useTranslation();
  return <OutcomeMessageBar>{failure.message ?? t('dashboard.pages.unavailable')}</OutcomeMessageBar>;
}
