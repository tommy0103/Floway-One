import type { ReactNode } from 'react';

import type { Objective, ObjectiveId } from './objectives';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { FailureLine } from '../overview/panel';
import { CodeBlock } from '../ui/code-block';
import { PANEL_STACK_CLASS } from '../ui/layout';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { RouteLink } from '../ui/route-link';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';

const { Text } = fluentComponents;

// Configuration objectives expose their established management page beside
// the status row; the remaining rows are observations with nothing to open.
const OBJECTIVE_LINKS: Partial<Record<ObjectiveId, {
  to: string;
  labelKey: 'dashboard.quickStart.openUpstreams' | 'dashboard.quickStart.openApiKeys';
}>> = {
  modelService: { to: '/dashboard/providers/upstreams', labelKey: 'dashboard.quickStart.openUpstreams' },
  apiKey: { to: '/dashboard/services/api-keys', labelKey: 'dashboard.quickStart.openApiKeys' },
  agentSetup: { to: '/dashboard/services/api-keys', labelKey: 'dashboard.quickStart.openApiKeys' },
};

// The one thing the owner has to do once the Skill is installed: hand the
// whole setup to their agent. The Skill inspects the current state itself and
// continues wherever the activation actually stands.
export function NextStepPanel({ current, installAction }: {
  current: Objective;
  installAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const clipboard = useCopyToClipboard();
  const copyTag = 'quick-start-prompt';
  const prompt = t('dashboard.quickStart.prompt');

  return <Panel className={`${PANEL_STACK_CLASS} w-full`}>
    <SectionHeader level={2} title={t('dashboard.quickStart.nextStep')} />
    {current.id === 'gateway' && <>
      <Text size={200}>{t('dashboard.quickStart.gatewayDown')}</Text>
      {current.failure !== null && <FailureLine failure={current.failure} />}
    </>}
    {current.id === 'skill' && <>
      {installAction}
      {current.failure !== null && <FailureLine failure={current.failure} />}
    </>}
    {(current.id === 'modelService' || current.id === 'apiKey' || current.id === 'agentSetup') && <>
      {current.failure !== null && <FailureLine failure={current.failure} />}
      <Text size={200} className="text-fui-fg2">{t('dashboard.quickStart.askAgent')}</Text>
      <CodeBlock
        code={prompt}
        copyOutcome={clipboard.outcomeFor(copyTag)}
        language="markdown"
        onCopy={() => clipboard.copy(prompt, copyTag)}
      />
    </>}
    {current.id === 'firstRequest' && <>
      <Text size={200}>{t('dashboard.quickStart.firstRequestGuide')}</Text>
      {current.failure !== null && <FailureLine failure={current.failure} />}
      {current.detail !== null && <OutcomeMessageBar intent="warning">
        {t('dashboard.quickStart.latestRequestFailed', { detail: current.detail })}
      </OutcomeMessageBar>}
    </>}
  </Panel>;
}

// The activation state as the gateway sees it: a row per checkpoint, nothing
// to work through. The page watches and the badges move on their own.
export function StatusPanel({ currentId, objectives }: {
  currentId: ObjectiveId | null;
  objectives: Objective[];
}) {
  const { t } = useTranslation();
  return <Panel className={`${PANEL_STACK_CLASS} w-full`}>
    <SectionHeader level={2} title={t('dashboard.quickStart.statusTitle')} />
    <div className="grid gap-3">
      {objectives.map(objective => {
        const link = OBJECTIVE_LINKS[objective.id];
        return <div className="flex items-center gap-2 min-w-0" key={objective.id}>
          <StatusBadge tone={objective.failure !== null && !objective.complete ? 'danger' : objective.complete ? 'success' : objective.id === currentId ? 'accent' : 'neutral'}>
            {t(objective.failure !== null && !objective.complete
              ? 'dashboard.quickStart.status.unavailable'
              : objective.complete
                ? 'dashboard.quickStart.status.done'
                : objective.id === currentId
                  ? 'dashboard.quickStart.status.current'
                  : 'dashboard.quickStart.status.pending')}
          </StatusBadge>
          <Text size={300} weight={objective.id === currentId ? 'semibold' : 'regular'} className={objective.complete || objective.id === currentId ? '' : 'text-fui-fg2'}>
            {t(`dashboard.quickStart.objectives.${objective.id}.title`)}
          </Text>
          {link && <span className="ml-auto shrink-0">
            <RouteLink to={link.to}>
              <OpenLinkLabel>{t(link.labelKey)}</OpenLinkLabel>
            </RouteLink>
          </span>}
        </div>;
      })}
    </div>
  </Panel>;
}
