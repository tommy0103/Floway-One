import { api, callApi } from './client';
import { LocalizedError } from '../i18n/localized-error';

export const loadRuntimeInfo = async (signal?: AbortSignal) => {
  const result = await callApi(() => api.api['runtime-info'].$get(
    {},
    { init: { signal } },
  ));
  if (result.error) {
    throw new LocalizedError('common.errors.runtimeCapabilitiesUnavailable', {
      cause: result.error,
    });
  }
  return result.data;
};

export type DashboardRuntimeCapabilities = Awaited<ReturnType<typeof loadRuntimeInfo>>['profile']['capabilities'];
