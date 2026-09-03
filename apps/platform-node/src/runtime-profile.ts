import type { RuntimeProfileMode } from '@floway-dev/platform';

const PROFILE_ARGUMENT = '--profile=';

export const selectNodeRuntimeProfile = (args: readonly string[]): RuntimeProfileMode => {
  if (args.length === 0) return 'server';
  if (args.length !== 1 || !args[0]?.startsWith(PROFILE_ARGUMENT)) {
    throw new Error('Usage: Floway [--profile=server|personal]');
  }
  const profile = args[0].slice(PROFILE_ARGUMENT.length);
  if (profile === 'server' || profile === 'personal') return profile;
  throw new Error(`Unsupported Floway runtime profile: ${profile}`);
};
