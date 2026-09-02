export const pnpmCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
