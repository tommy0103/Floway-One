import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { visitFileTree } from './filesystem-tree.ts';
import { assertSingleMachOArchitecture } from './mach-o.ts';
import { compilePackagedRuntime, probePackagedRuntime } from './packaged-runtime.ts';
import {
  architectureForTargetTriple,
  readPackagedNodeVersion,
  targetTripleForHost,
} from './release-contract.ts';

export interface PrepareDesktopBundleOptions {
  readonly desktopRoot: string;
  readonly generateRuntime: (outputRoot: string) => Promise<void>;
  readonly nodeArchitecture: NodeJS.Architecture;
  readonly nodeExecutable: string;
  readonly nodePlatform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly targetTriple: string;
  readonly executeNode?: boolean;
  readonly validateSidecar?: (path: string, targetTriple: string) => Promise<void>;
}

export interface PreparedDesktopBundle {
  readonly contractPath: string;
  readonly nodeSidecar: string;
  readonly runtimeRoot: string;
}

interface DesktopBundleContract {
  readonly schemaVersion: 1;
  readonly node: {
    readonly architecture: NodeJS.Architecture;
    readonly platform: NodeJS.Platform;
    readonly targetTriple: string;
    readonly version: string;
  };
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
  try {
    await visitFileTree(dependenciesRoot, ({ dirent, path }) => {
      if (dirent.isSymbolicLink()) {
        // Tauri's resource walker treats directory symlinks as directories to
        // skip but does not follow them, so a pnpm isolated layout silently
        // loses every linked dependency. Command shims are removed before this
        // validation because the packaged entry invokes no node_modules bin.
        // https://github.com/tauri-apps/tauri/blob/a5dc562a0088bc447ed9efbef532da3b4be1ac1c/crates/tauri-utils/src/resources.rs#L170-L181
        throw new Error(`Desktop bundle dependency must be physical for Tauri resources: ${path}`);
      }
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Desktop bundle dependency must be physical')) throw cause;
    throw new Error(`Desktop bundle dependencies are unavailable at ${dependenciesRoot}`, { cause });
  }
};

const removePnpmCommandShims = async (runtimeRoot: string): Promise<void> => {
  await visitFileTree(resolve(runtimeRoot, 'apps/platform-node/node_modules'), async ({ dirent, path }) => {
    if (dirent.isDirectory() && dirent.name === '.bin') {
      await rm(path, { force: true, recursive: true });
      return 'skip-directory';
    }
  });
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

const assertBundleContract = async (
  path: string,
  expected: DesktopBundleContract,
): Promise<void> => {
  let actual: unknown;
  try {
    actual = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Desktop bundle contract is unavailable at ${path}`, { cause });
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Desktop bundle contract at ${path} does not match the staged runtime and sidecar`);
  }
};

const publishPreparedInputs = async (stagedRoot: string, finalRoot: string): Promise<void> => {
  const previousRoot = `${finalRoot}.previous`;
  await rm(previousRoot, { force: true, recursive: true });
  let movedPrevious = false;
  try {
    await rename(finalRoot, previousRoot);
    movedPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(stagedRoot, finalRoot);
  } catch (cause) {
    if (movedPrevious) await rename(previousRoot, finalRoot);
    throw new Error('Failed to atomically publish the complete desktop bundle inputs', { cause });
  }
  await rm(previousRoot, { force: true, recursive: true });
};

export const prepareDesktopBundle = async ({
  desktopRoot,
  generateRuntime,
  nodeArchitecture,
  nodeExecutable,
  nodePlatform,
  nodeVersion,
  targetTriple,
  executeNode = true,
  validateSidecar,
}: PrepareDesktopBundleOptions): Promise<PreparedDesktopBundle> => {
  const requiredNodeVersion = await readPackagedNodeVersion(desktopRoot);
  if (nodeVersion !== requiredNodeVersion) {
    throw new Error(`Desktop bundles require Node.js ${requiredNodeVersion}; received ${nodeVersion}`);
  }
  assertCompatibleTarget(targetTriple, nodePlatform, nodeArchitecture);

  const inputsRoot = resolve(desktopRoot, 'src-tauri/bundle-inputs');
  const stagingContainer = resolve(desktopRoot, 'src-tauri/.bundle-staging');
  const stagedInputsRoot = resolve(stagingContainer, 'bundle-inputs');
  const stagedRuntimeRoot = resolve(stagedInputsRoot, 'runtime');
  const stagedBinariesRoot = resolve(stagedInputsRoot, 'binaries');
  const stagedContractPath = resolve(stagedInputsRoot, 'desktop-bundle-contract.json');
  const extension = nodePlatform === 'win32' ? '.exe' : '';
  const sidecarName = `floway-node-${targetTriple}${extension}`;
  const stagedNodeSidecar = resolve(stagedBinariesRoot, sidecarName);
  const contract: DesktopBundleContract = {
    schemaVersion: 1,
    node: {
      architecture: nodeArchitecture,
      platform: nodePlatform,
      targetTriple,
      version: nodeVersion,
    },
  };
  await rm(stagingContainer, { force: true, recursive: true });
  await mkdir(stagedBinariesRoot, { recursive: true });
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
    try {
      await copyFile(nodeExecutable, stagedNodeSidecar);
      if (nodePlatform !== 'win32') await chmod(stagedNodeSidecar, 0o755);
    } catch (cause) {
      throw new Error(`Failed to stage the Node.js sidecar from ${nodeExecutable}`, { cause });
    }
    await writeFile(stagedContractPath, `${JSON.stringify(contract, undefined, 2)}\n`);
    await requireFile(stagedNodeSidecar);
    if (validateSidecar === undefined) {
      if (nodePlatform === 'darwin') {
        await assertSingleMachOArchitecture(stagedNodeSidecar, architectureForTargetTriple(targetTriple));
      }
    } else {
      await validateSidecar(stagedNodeSidecar, targetTriple);
    }
    if (executeNode) await probePackagedRuntime(stagedRuntimeRoot, stagedNodeSidecar);
    await assertBundleContract(stagedContractPath, contract);
    await publishPreparedInputs(stagedInputsRoot, inputsRoot);
  } finally {
    await rm(stagingContainer, { force: true, recursive: true });
  }
  const runtimeRoot = resolve(inputsRoot, 'runtime');
  const nodeSidecar = join(inputsRoot, 'binaries', sidecarName);
  const contractPath = resolve(inputsRoot, 'desktop-bundle-contract.json');
  await assertPackagedRuntime(runtimeRoot);
  await requireFile(nodeSidecar);
  await assertBundleContract(contractPath, contract);
  return { contractPath, nodeSidecar, runtimeRoot };
};
