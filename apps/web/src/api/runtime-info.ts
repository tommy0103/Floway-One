import { api, callApi } from './client';

export const loadRuntimeInfo = async (signal?: AbortSignal) => {
  const result = await callApi(() => api.api['runtime-info'].$get(
    {},
    { init: { signal } },
  ));
  if (result.error) {
    throw new Error(`Runtime capabilities could not be loaded: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
};

export type DashboardRuntimeCapabilities = Awaited<ReturnType<typeof loadRuntimeInfo>>['profile']['capabilities'];
