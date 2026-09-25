import type { ActivationSnapshot } from './data';
import type { OverviewRegionFailure } from '../overview/data';
import { errorLabel, requestSeverity } from '../requests/format';

export type ObjectiveId = 'gateway' | 'skill' | 'modelService' | 'apiKey' | 'agentSetup' | 'firstRequest';

// One activation objective derived from observable state. `failure` is the
// region load failure the objective surfaces instead of completing; `detail`
// is raw diagnostic from the observed state (for example the latest request's
// own error), shown beside it.
export interface Objective {
  id: ObjectiveId;
  complete: boolean;
  failure: OverviewRegionFailure | null;
  detail: string | null;
}

export const deriveObjectives = (snapshot: ActivationSnapshot): Objective[] => {
  const recent = snapshot.recentRequest;
  const latestRecord = recent.value?.kind === 'record' ? recent.value.record : null;
  const latestSucceeded = latestRecord !== null && requestSeverity(latestRecord.status, latestRecord.error) === 'success';
  // Without a captured record the outcome of a request is not observable; a
  // used key is the remaining evidence that a client reached the gateway.
  const anyKeyUsed = snapshot.keys.value?.some(key => key.last_used_at !== null) ?? false;

  return [
    { id: 'gateway', complete: snapshot.health.value !== null, failure: snapshot.health.failure, detail: null },
    { id: 'skill', complete: snapshot.skill.value?.installed === true, failure: snapshot.skill.failure, detail: null },
    {
      id: 'modelService',
      complete: snapshot.upstreams.value?.some(upstream => upstream.enabled && (upstream.modelsCache.modelCount ?? 0) > 0) ?? false,
      failure: snapshot.upstreams.failure,
      detail: null,
    },
    { id: 'apiKey', complete: (snapshot.keys.value?.length ?? 0) > 0, failure: snapshot.keys.failure, detail: null },
    {
      id: 'agentSetup',
      complete: snapshot.skill.value?.clients.some(client => client.configured) ?? false,
      failure: snapshot.skill.failure,
      detail: null,
    },
    {
      id: 'firstRequest',
      complete: latestSucceeded || (latestRecord === null && anyKeyUsed),
      failure: recent.failure,
      detail: latestRecord !== null && !latestSucceeded
        ? errorLabel(latestRecord.error, latestRecord.status) ?? (latestRecord.status === null ? null : `HTTP ${latestRecord.status}`)
        : null,
    },
  ];
};

// The first incomplete objective is the one the page acts on; null when
// activation has completed.
export const currentObjective = (objectives: Objective[]): Objective | null =>
  objectives.find(objective => !objective.complete) ?? null;
