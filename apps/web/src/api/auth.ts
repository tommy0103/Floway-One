import type { InferResponseType } from 'hono/client';

import { api, callApi, type ApiResult } from './client';

type MeResponse = InferResponseType<typeof api.auth.me.$get, 200>;
export type LoginResponse = InferResponseType<typeof api.auth.login.$post, 200>;
export type BootstrapResponse = LoginResponse;
type ChangeOwnPasswordResponse = InferResponseType<typeof api.api.users.me.password.$patch, 200>;
export type AuthUser = MeResponse['user'];

export const getCurrentSession = (): Promise<ApiResult<MeResponse>> =>
  callApi(() => api.auth.me.$get());

export const login = (body: { username: string; password: string }): Promise<ApiResult<LoginResponse>> =>
  callApi(() => api.auth.login.$post({ json: body }));

export const exchangePersonalDashboardBootstrap = (body: { token: string }): Promise<ApiResult<BootstrapResponse>> =>
  callApi(() => fetch('/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as Promise<ApiResult<BootstrapResponse>>;

export const changeOwnPassword = (body: { currentPassword: string; newPassword: string }): Promise<ApiResult<ChangeOwnPasswordResponse>> =>
  callApi(() => api.api.users.me.password.$patch({ json: body }));
