import type { PersonalDashboardBootstrapConfiguration } from '@floway-dev/gateway';

export const PERSONAL_DASHBOARD_BOOTSTRAP_ENV = 'FLOWAY_BOOTSTRAP_TOKEN';
export const PERSONAL_DASHBOARD_BOOTSTRAP_TTL_MS = 5 * 60 * 1000;

export const takePersonalDashboardBootstrapToken = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const token = env[PERSONAL_DASHBOARD_BOOTSTRAP_ENV];
  delete env[PERSONAL_DASHBOARD_BOOTSTRAP_ENV];
  return token;
};

export interface PreparedPersonalDashboardBootstrap {
  activate(now?: number): PersonalDashboardBootstrapConfiguration;
}

export const preparePersonalDashboardBootstrap = (options: {
  readonly origin: string;
  readonly production: boolean;
  readonly token: string | undefined;
}): PreparedPersonalDashboardBootstrap => {
  const { origin, production, token } = options;
  if (token === undefined || token === '') {
    if (production) {
      throw new Error(`Personal production startup requires ${PERSONAL_DASHBOARD_BOOTSTRAP_ENV}`);
    }
    return { activate: () => ({ origin, credential: null }) };
  }
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`${PERSONAL_DASHBOARD_BOOTSTRAP_ENV} must be 64 lowercase hexadecimal characters`);
  }
  return {
    activate: (now = Date.now()) => ({
      origin,
      credential: {
        token,
        expiresAt: now + PERSONAL_DASHBOARD_BOOTSTRAP_TTL_MS,
      },
    }),
  };
};
