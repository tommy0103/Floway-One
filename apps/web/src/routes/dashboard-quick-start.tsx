import { useCallback, useState } from 'react';
import { redirect, useNavigate } from 'react-router';

import type { Route } from './+types/dashboard-quick-start';
import { requireDashboardSession } from './guards';
import { api, callApi } from '../api/client';
import { loadRuntimeInfo } from '../api/runtime-info';
import {
  loadActivationSnapshot,
  mergeActivationSnapshot,
  type ActivationSnapshot,
} from '../components/quick-start/data';
import { currentObjective, deriveObjectives } from '../components/quick-start/objectives';
import { NextStepPanel, StatusPanel } from '../components/quick-start/panel';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyState } from '../components/ui/empty-state';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Button, Text } = fluentComponents;

interface LoaderData {
  snapshot: ActivationSnapshot;
}

export async function clientLoader(): Promise<LoaderData> {
  requireDashboardSession();
  if ((await loadRuntimeInfo()).profile.mode !== 'personal') throw redirect('/dashboard/services/api-keys');
  return { snapshot: await loadActivationSnapshot() };
}

export default function DashboardQuickStart({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Tied to the navigation it came from, the same contract the overview gives
  // its snapshot: a fresh loader commits its own readings under a new URL.
  const [replacement, setReplacement] = useState<{ source: LoaderData; snapshot: ActivationSnapshot } | null>(null);
  const snapshot = replacement?.source === loaderData ? replacement.snapshot : loaderData.snapshot;

  const reload = useCallback(async (signal: AbortSignal, { background }: { background: boolean }) => {
    const next = await loadActivationSnapshot(signal);
    if (signal.aborted) return;
    setReplacement(current => ({
      source: loaderData,
      snapshot: mergeActivationSnapshot(
        current?.source === loaderData ? current.snapshot : loaderData.snapshot,
        next,
        { background },
      ),
    }));
  }, [loaderData]);
  const { poll } = useRefresh(reload);
  usePollWhileVisible(poll);

  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ path: string } | { error: string } | null>(null);
  const install = async () => {
    setInstalling(true);
    setInstallResult(null);
    const response = await callApi(() => api.api['agent-skill'].install.$post({ json: {} }));
    setInstalling(false);
    setInstallResult(response.error ? { error: response.error.message } : { path: response.data.path });
    // The install changes the state the skill objective is derived from, so
    // the page re-reads it instead of trusting the click.
    await poll({ background: false });
  };

  const objectives = deriveObjectives(snapshot);
  const current = currentObjective(objectives);
  const clients = snapshot.skill.value?.clients ?? [];
  const noClient = snapshot.skill.value !== null && !clients.some(client => client.installed);

  return <section className="dashboard-page max-w-[960px]">
    <DashboardPageHeader description={t('dashboard.pages.quickStart')} title={t('dashboard.nav.quickStart')} />

    {noClient && <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader level={2} title={t('dashboard.quickStart.prerequisite.title')} />
      <Text size={200}>{t('dashboard.quickStart.prerequisite.description')}</Text>
    </Panel>}

    {current !== null && <NextStepPanel
      current={current}
      installAction={<div className="grid gap-2 justify-items-start">
        <div>
          <Button appearance="primary" disabled={installing} onClick={() => void install()}>
            {t(installing ? 'dashboard.quickStart.installing' : snapshot.skill.value?.installed ? 'dashboard.quickStart.reinstall' : 'dashboard.quickStart.install')}
          </Button>
        </div>
        <Text size={200} className="text-fui-fg2">{t('dashboard.quickStart.installAccess')}</Text>
      </div>}
    />}

    {/* The install outcome outlives the objective it completed: the page
        advances past the install step, while this bar stays readable. */}
    {installResult && ('error' in installResult
      ? <OutcomeMessageBar onDismiss={() => setInstallResult(null)}>{installResult.error}</OutcomeMessageBar>
      : <OutcomeMessageBar intent="success" onDismiss={() => setInstallResult(null)}>{t('dashboard.quickStart.installed', { path: installResult.path })}</OutcomeMessageBar>)}

    {current === null && <Panel>
      <EmptyState
        action={<Button appearance="primary" onClick={() => void navigate('/dashboard')}>{t('dashboard.quickStart.openOverview')}</Button>}
        description={t('dashboard.quickStart.completed.description')}
        title={t('dashboard.quickStart.completed.title')}
      />
    </Panel>}

    <StatusPanel currentId={current?.id ?? null} objectives={objectives} />

    {current !== null && <div>
      <Button appearance="subtle" onClick={() => void navigate('/dashboard')}>{t('dashboard.quickStart.skip')}</Button>
    </div>}
  </section>;
}
