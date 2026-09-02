export type RuntimeProfileMode = 'personal' | 'server';

export interface RuntimeCapabilities {
  readonly userManagement: boolean;
  readonly remoteAccess: boolean;
  readonly desktopIntegration: boolean;
}

export interface RuntimeProfile {
  readonly mode: RuntimeProfileMode;
  readonly capabilities: RuntimeCapabilities;
}

const PERSONAL_PROFILE: RuntimeProfile = Object.freeze({
  mode: 'personal',
  capabilities: Object.freeze({
    userManagement: false,
    remoteAccess: false,
    desktopIntegration: true,
  }),
});

const SERVER_PROFILE: RuntimeProfile = Object.freeze({
  mode: 'server',
  capabilities: Object.freeze({
    userManagement: true,
    remoteAccess: true,
    desktopIntegration: false,
  }),
});

let _profile: RuntimeProfile | null = null;

export const initRuntimeProfile = (mode: RuntimeProfileMode): void => {
  if (mode === 'personal') {
    _profile = PERSONAL_PROFILE;
    return;
  }
  if (mode === 'server') {
    _profile = SERVER_PROFILE;
    return;
  }
  throw new Error(`Unsupported runtime profile: ${String(mode)}`);
};

export const getRuntimeProfile = (): RuntimeProfile => {
  if (!_profile) throw new Error('Runtime profile not initialized — call initRuntimeProfile() first');
  return _profile;
};
