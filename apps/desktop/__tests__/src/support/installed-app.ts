import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface InstalledAppVerificationContext {
  readonly appRoot: string;
  readonly contract: string;
  readonly entry: string;
  readonly executable: string;
  readonly keyringNative: string;
  readonly migrationNames: readonly string[];
  readonly migrations: string;
  readonly node: string;
  readonly platformNode: string;
}

export const createInstalledAppVerificationContext = async (
  installedApp: string,
  keyringRelativePath: string,
  migrationNames: readonly string[],
): Promise<InstalledAppVerificationContext> => {
  const context: InstalledAppVerificationContext = {
    appRoot: installedApp,
    executable: resolve(installedApp, 'Contents/MacOS/floway-one'),
    node: resolve(installedApp, 'Contents/MacOS/floway-node'),
    contract: resolve(installedApp, 'Contents/Resources/desktop-bundle-contract.json'),
    platformNode: resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node'),
    entry: resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node/entry.js'),
    keyringNative: resolve(installedApp, keyringRelativePath),
    migrationNames,
    migrations: resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations'),
  };
  const ownedPaths = {
    contract: context.contract,
    entry: context.entry,
    executable: context.executable,
    keyringNative: context.keyringNative,
    migrations: context.migrations,
    node: context.node,
    platformNode: context.platformNode,
  };
  for (const [label, path] of Object.entries(ownedPaths)) {
    const owned = relative(installedApp, path);
    if (isAbsolute(owned) || owned.split(sep)[0] === '..') {
      throw new Error(`Installed app verification ${label} escapes its owning application: ${path}`);
    }
  }
  await Promise.all([
    access(context.executable),
    access(context.node),
    access(context.contract),
    access(context.entry),
    access(context.keyringNative),
    access(context.migrations),
  ]);
  return context;
};
