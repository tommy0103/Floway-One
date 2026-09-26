import { CheckmarkCircle20Color, Circle20Regular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import type { Objective, ObjectiveId } from './objectives';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { FailureLine } from '../overview/panel';
import { CodeBlock } from '../ui/code-block';
import { PANEL_STACK_CLASS, STATUS_HEADER_CLASS } from '../ui/layout';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { RouteLink } from '../ui/route-link';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { useCopyToClipboard } from '../ui/use-copy-to-clipboard';

const { Tab, TabList, Text } = fluentComponents;

// Configuration stages keep their established management page one click away.
const OBJECTIVE_LINKS: Partial<Record<ObjectiveId, {
  to: string;
  labelKey: 'dashboard.quickStart.openUpstreams' | 'dashboard.quickStart.openApiKeys';
}>> = {
  modelService: { to: '/dashboard/providers/upstreams', labelKey: 'dashboard.quickStart.openUpstreams' },
  apiKey: { to: '/dashboard/services/api-keys', labelKey: 'dashboard.quickStart.openApiKeys' },
  agentSetup: { to: '/dashboard/services/api-keys', labelKey: 'dashboard.quickStart.openApiKeys' },
};

// The stage rail is the page's frame: completed stages stay reviewable, the
// current stage is where the state puts the owner, and anything past it is
// locked because a state-driven page has nothing to show or do there yet.
export function StageNavigator({ currentId, installAction, objectives, onSelect, selectedId }: {
  currentId: ObjectiveId | null;
  installAction: ReactNode;
  objectives: Objective[];
  onSelect: (id: ObjectiveId) => void;
  selectedId: ObjectiveId;
}) {
  const { t } = useTranslation();
  const selected = objectives.find(objective => objective.id === selectedId) ?? objectives[0];

  return <div className="grid grid-cols-[190px_minmax(0,1fr)] max-[680px]:grid-cols-1 gap-[var(--floway-page-inset)] min-w-0">
    <nav aria-label={t('dashboard.quickStart.stages')} className="grid content-start">
      <TabList onTabSelect={(_, data) => onSelect(data.value as ObjectiveId)} selectedValue={selected.id} vertical>
        {objectives.map(objective => {
          const locked = !objective.complete && objective.id !== currentId;
          // Stepper idiom: a checked disc for done, an open circle otherwise;
          // the current stage reads from the selection itself, not an icon.
          const icon = objective.complete ? <CheckmarkCircle20Color /> : <Circle20Regular />;
          return <Tab disabled={locked} icon={icon} key={objective.id} value={objective.id}>
            {t(`dashboard.quickStart.objectives.${objective.id}.title`)}
          </Tab>;
        })}
      </TabList>
    </nav>

    <Panel className={`${PANEL_STACK_CLASS} w-full content-start`}>
      <div className={STATUS_HEADER_CLASS}>
        <SectionHeader level={2} title={t(`dashboard.quickStart.objectives.${selected.id}.title`)} />
        <StatusBadge tone={selected.complete ? 'success' : selected.failure !== null ? 'danger' : 'accent'}>
          {t(selected.complete
            ? 'dashboard.quickStart.status.done'
            : selected.failure !== null
              ? 'dashboard.quickStart.status.unavailable'
              : 'dashboard.quickStart.status.current')}
        </StatusBadge>
      </div>
      <StageBody installAction={installAction} objective={selected} />
    </Panel>
  </div>;
}

function StageBody({ installAction, objective }: {
  installAction: ReactNode;
  objective: Objective;
}) {
  const { t } = useTranslation();
  const clipboard = useCopyToClipboard();
  const copyTag = 'quick-start-prompt';
  const prompt = t('dashboard.quickStart.prompt');
  const link = OBJECTIVE_LINKS[objective.id];
  const done = t(`dashboard.quickStart.objectives.${objective.id}.done`);

  if (objective.complete) {
    return <>
      <Text size={200}>{done}</Text>
      {objective.id === 'skill' && installAction}
      {link && <div>
        <RouteLink to={link.to}>
          <OpenLinkLabel>{t(link.labelKey)}</OpenLinkLabel>
        </RouteLink>
      </div>}
    </>;
  }

  switch (objective.id) {
  case 'gateway':
    return <>
      <Text size={200}>{t('dashboard.quickStart.gatewayDown')}</Text>
      {objective.failure !== null && <FailureLine failure={objective.failure} />}
    </>;
  case 'skill':
    return <>
      {installAction}
      {objective.failure !== null && <FailureLine failure={objective.failure} />}
    </>;
  case 'firstRequest':
    return <>
      <Text size={200}>{t('dashboard.quickStart.firstRequestGuide')}</Text>
      {objective.failure !== null && <FailureLine failure={objective.failure} />}
      {objective.detail !== null && <OutcomeMessageBar intent="warning">
        {t('dashboard.quickStart.latestRequestFailed', { detail: objective.detail })}
      </OutcomeMessageBar>}
    </>;
  default:
    // The one remaining thing to do at a configuration stage is always the
    // same: hand the setup to the owner's agent through the Skill.
    return <>
      {objective.failure !== null && <FailureLine failure={objective.failure} />}
      <Text size={200} className="text-fui-fg2">{t('dashboard.quickStart.askAgent')}</Text>
      <CodeBlock
        code={prompt}
        copyOutcome={clipboard.outcomeFor(copyTag)}
        language="markdown"
        onCopy={() => clipboard.copy(prompt, copyTag)}
      />
      {link && <div>
        <RouteLink to={link.to}>
          <OpenLinkLabel>{t(link.labelKey)}</OpenLinkLabel>
        </RouteLink>
      </div>}
    </>;
  }
}
