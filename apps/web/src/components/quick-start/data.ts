import { api, callApi } from '../../api/client';
import type { AgentSkillStatus, ApiKey, UpstreamRecord } from '../../api/types';
import {
  gather,
  loadHealthRegion,
  loadRecentRequest,
  mergeRegion,
  unwrap,
  type OverviewRecentRequest,
  type OverviewRegion,
} from '../overview/data';

// The observable state Quick Start derives its objectives from. Every region
// fails on its own, so a gateway that cannot list keys still answers its
// health probe, and the page states each outcome where the objective sits.
export interface ActivationSnapshot {
  gatheredAt: number;
  health: OverviewRegion<{ ok: true }>;
  upstreams: OverviewRegion<UpstreamRecord[]>;
  keys: OverviewRegion<ApiKey[]>;
  skill: OverviewRegion<AgentSkillStatus>;
  recentRequest: OverviewRegion<OverviewRecentRequest>;
}

export const loadActivationSnapshot = async (signal?: AbortSignal): Promise<ActivationSnapshot> => {
  const [health, upstreams, keys, skill] = await Promise.all([
    loadHealthRegion(signal),
    gather(async () => unwrap(await callApi(() => api.api.upstreams.$get(undefined, { init: { signal } })))),
    gather(async () => unwrap(await callApi(() => api.api.keys.$get(undefined, { init: { signal } })))),
    gather(async () => unwrap(await callApi(() => api.api['agent-skill'].status.$get({}, { init: { signal } })))),
  ]);

  return {
    gatheredAt: Date.now(),
    health,
    upstreams,
    keys,
    skill,
    recentRequest: await loadRecentRequest(keys, signal),
  };
};

// Same rule as the overview: a background run must not clear a failure the
// operator has not read; a foreground run commits everything.
export const mergeActivationSnapshot = (
  current: ActivationSnapshot,
  next: ActivationSnapshot,
  { background }: { background: boolean },
): ActivationSnapshot => {
  if (!background) return next;
  return {
    gatheredAt: next.gatheredAt,
    health: mergeRegion(current.health, next.health),
    upstreams: mergeRegion(current.upstreams, next.upstreams),
    keys: mergeRegion(current.keys, next.keys),
    skill: mergeRegion(current.skill, next.skill),
    recentRequest: mergeRegion(current.recentRequest, next.recentRequest),
  };
};
