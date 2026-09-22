import { useState } from 'react';
import { redirect } from 'react-router';

import { requireDashboardSession } from './guards';
import { api, callApi } from '../api/client';
import { loadRuntimeInfo } from '../api/runtime-info';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { RouteLink } from '../components/ui/route-link';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Button, Text } = fluentComponents;

export async function clientLoader() {
  requireDashboardSession();
  if ((await loadRuntimeInfo()).profile.mode !== 'personal') throw redirect('/dashboard/services/api-keys');
  return null;
}

export default function DashboardQuickStart() {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ path: string } | { error: string } | null>(null);
  const install = async () => {
    setInstalling(true);
    setResult(null);
    const response = await callApi(() => api.api['agent-skill'].install.$post({ json: {} }));
    setInstalling(false);
    setResult(response.error ? { error: response.error.message } : { path: response.data.path });
  };

  return <section className="dashboard-page max-w-[960px]">
    <DashboardPageHeader description={t('dashboard.pages.quickStart')} title={t('dashboard.nav.quickStart')} />
    <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader level={2} title={t('dashboard.quickStart.installTitle')} />
      <Text size={200}>{t('dashboard.quickStart.installDescription')}</Text>
      <Text size={200} className="text-fui-fg2">{t('dashboard.quickStart.accessDescription')}</Text>
      <div><Button appearance="primary" disabled={installing} onClick={() => void install()}>
        {t(installing ? 'dashboard.quickStart.installing' : 'dashboard.quickStart.install')}
      </Button></div>
      {result && ('error' in result
        ? <OutcomeMessageBar>{result.error}</OutcomeMessageBar>
        : <OutcomeMessageBar intent="success">{t('dashboard.quickStart.installed', { path: result.path })}</OutcomeMessageBar>)}
    </Panel>
    <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader level={2} title={t('dashboard.quickStart.tryTitle')} />
      <Text size={200}>{t('dashboard.quickStart.tryDescription')}</Text>
      <Text size={200}><RouteLink to="/dashboard/providers/upstreams">{t('dashboard.quickStart.openUpstreams')}</RouteLink></Text>
    </Panel>
  </section>;
}
