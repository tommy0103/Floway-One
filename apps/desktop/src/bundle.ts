import { chmod, copyFile, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { compilePackagedRuntime, probePackagedRuntime } from './packaged-runtime.ts';
import { readPackagedNodeVersion, targetTripleForHost } from './release-contract.ts';

export interface PrepareDesktopBundleOptions {
  readonly desktopRoot: string;
  readonly generateRuntime: (outputRoot: string) => Promise<void>;
  readonly nodeArchitecture: NodeJS.Architecture;
  readonly nodeExecutable: string;
  readonly nodePlatform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly targetTriple: string;
}

export interface PreparedDesktopBundle {
  readonly nodeSidecar: string;
  readonly runtimeRoot: string;
}

const requireFile = async (path: string): Promise<void> => {
  try {
    if (!(await stat(path)).isFile()) throw new Error('the path is not a file');
  } catch (cause) {
    throw new Error(`Desktop bundle resource is unavailable at ${path}`, { cause });
  }
};

const requireMigrations = async (runtimeRoot: string): Promise<void> => {
  const migrationsRoot = resolve(
    runtimeRoot,
    'apps/platform-node/node_modules/@floway-dev/gateway/migrations',
  );
  let migrations: string[];
  try {
    migrations = (await readdir(migrationsRoot)).filter(name => name.endsWith('.sql'));
  } catch (cause) {
    throw new Error(`Desktop bundle migrations are unavailable at ${migrationsRoot}`, { cause });
  }
  if (migrations.length === 0) {
    throw new Error(`Desktop bundle migrations are unavailable at ${migrationsRoot}`, {
      cause: new Error('the directory contains no SQL migrations'),
    });
  }
};

const requirePhysicalProductionDependencies = async (runtimeRoot: string): Promise<void> => {
  const dependenciesRoot = resolve(runtimeRoot, 'apps/platform-node/node_modules');
  const pending = [dependenciesRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      throw new Error(`Desktop bundle dependencies are unavailable at ${directory}`, { cause });
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Tauri's resource walker treats directory symlinks as directories to
        // skip but does not follow them, so a pnpm isolated layout silently
        // loses every linked dependency. Command shims are removed before this
        // validation because the packaged entry invokes no node_modules bin.
        // https://github.com/tauri-apps/tauri/blob/a5dc562a0088bc447ed9efbef532da3b4be1ac1c/crates/tauri-utils/src/resources.rs#L170-L181
        throw new Error(`Desktop bundle dependency must be physical for Tauri resources: ${path}`);
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
};

const removePnpmCommandShims = async (runtimeRoot: string): Promise<void> => {
  const pending = [resolve(runtimeRoot, 'apps/platform-node/node_modules')];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name === '.bin') {
        await rm(path, { force: true, recursive: true });
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
};

export const assertPackagedRuntime = async (runtimeRoot: string): Promise<void> => {
  await Promise.all([
    requireFile(resolve(runtimeRoot, 'apps/platform-node/entry.js')),
    requireFile(resolve(runtimeRoot, 'apps/web/dist/client/index.html')),
    requireFile(resolve(runtimeRoot, 'apps/web/dist/client/dashboard-routes.json')),
    requireMigrations(runtimeRoot),
    requirePhysicalProductionDependencies(runtimeRoot),
  ]);
};

const assertCompatibleTarget = (
  targetTriple: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): void => {
  const expected = targetTripleForHost(platform, architecture);
  if (targetTriple !== expected) {
    throw new Error(
      `Desktop Node sidecar target ${targetTriple} is incompatible with the build host ${platform}/${architecture}; expected ${expected}`,
    );
  }
};

export const prepareDesktopBundle = async ({
  desktopRoot,
  generateRuntime,
  nodeArchitecture,
  nodeExecutable,
  nodePlatform,
  nodeVersion,
  targetTriple,
}: PrepareDesktopBundleOptions): Promise<PreparedDesktopBundle> => {
  const requiredNodeVersion = await readPackagedNodeVersion(desktopRoot);
  if (nodeVersion !== requiredNodeVersion) {
    throw new Error(`Desktop bundles require Node.js ${requiredNodeVersion}; received ${nodeVersion}`);
  }
  assertCompatibleTarget(targetTriple, nodePlatform, nodeArchitecture);

  const binariesRoot = resolve(desktopRoot, 'src-tauri/binaries');
  const runtimeRoot = resolve(desktopRoot, 'src-tauri/resources/runtime');
  const stagingContainer = resolve(desktopRoot, 'src-tauri/.bundle-staging');
  const stagedRuntimeRoot = resolve(stagingContainer, 'runtime');
  await Promise.all([
    rm(binariesRoot, { force: true, recursive: true }),
    rm(resolve(desktopRoot, 'src-tauri/resources'), { force: true, recursive: true }),
    rm(stagingContainer, { force: true, recursive: true }),
  ]);
  await Promise.all([
    mkdir(binariesRoot, { recursive: true }),
    mkdir(resolve(runtimeRoot, '..'), { recursive: true }),
    mkdir(stagingContainer, { recursive: true }),
  ]);
  try {
    await generateRuntime(stagedRuntimeRoot);
    // Modern pnpm deploy injects workspace files as hard links. Compile only
    // after copying the complete deployment to a private writable tree, so a
    // package-manifest rewrite can never mutate the source workspace.
    const writableRuntimeRoot = resolve(stagingContainer, 'writable-runtime');
    await cp(stagedRuntimeRoot, writableRuntimeRoot, { recursive: true });
    await rm(stagedRuntimeRoot, { force: true, recursive: true });
    await rename(writableRuntimeRoot, stagedRuntimeRoot);
    await removePnpmCommandShims(stagedRuntimeRoot);
    await compilePackagedRuntime(stagedRuntimeRoot);
    await assertPackagedRuntime(stagedRuntimeRoot);
    await probePackagedRuntime(stagedRuntimeRoot, nodeExecutable);
    await rename(stagedRuntimeRoot, runtimeRoot);
  } finally {
    await rm(stagingContainer, { force: true, recursive: true });
  }
  await assertPackagedRuntime(runtimeRoot);

  const extension = nodePlatform === 'win32' ? '.exe' : '';
  const nodeSidecar = join(binariesRoot, `floway-node-${targetTriple}${extension}`);
  try {
    await copyFile(nodeExecutable, nodeSidecar);
    if (nodePlatform !== 'win32') await chmod(nodeSidecar, 0o755);
  } catch (cause) {
    throw new Error(`Failed to package the Node.js sidecar from ${nodeExecutable}`, { cause });
  }
  await requireFile(nodeSidecar);
  return { nodeSidecar, runtimeRoot };
};
