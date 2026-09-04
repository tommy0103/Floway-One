import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { exchangeDirectoriesAtomically, type AtomicDirectoryExchange } from './atomic-directory.ts';
import { settleWithCleanup } from './failure-chain.ts';
import { visitFileTree } from './filesystem-tree.ts';
import { assertSingleMachOArchitecture, thinMachOToArchitecture, type MachOArchitecture } from './mach-o.ts';
import { compilePackagedRuntime, probePackagedRuntime } from './packaged-runtime.ts';
import {
  architectureForTargetTriple,
  readPackagedNodeVersion,
  targetTripleForHost,
} from './release-contract.ts';

export interface PrepareDesktopBundleOptions {
  readonly canonicalMigrationsRoot: string;
  readonly desktopRoot: string;
  readonly generateRuntime: (outputRoot: string) => Promise<void>;
  readonly nodeArchitecture: NodeJS.Architecture;
  readonly nodeExecutable: string;
  readonly nodePlatform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly targetTriple: string;
  readonly executeNode?: boolean;
  readonly exchangeDirectories?: AtomicDirectoryExchange;
  readonly cleanupStaging?: (path: string) => Promise<void>;
  readonly validateSidecar?: (path: string, targetTriple: string) => Promise<void>;
}

export interface PreparedDesktopBundle {
  readonly contractPath: string;
  readonly nodeSidecar: string;
  readonly runtimeRoot: string;
}

interface DesktopBundleContract {
  readonly schemaVersion: 1;
  readonly dashboard: {
    readonly assets: readonly BundleFileContract[];
  };
  readonly migrations: {
    readonly files: readonly BundleFileContract[];
  };
  readonly node: {
    readonly architecture: NodeJS.Architecture;
    readonly platform: NodeJS.Platform;
    readonly targetTriple: string;
    readonly version: string;
  };
}

interface BundleFileContract {
  readonly path: string;
  readonly sha256: string;
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

const bundleFileContract = async (
  root: string,
  include: (path: string) => boolean = () => true,
): Promise<readonly BundleFileContract[]> => {
  const files: BundleFileContract[] = [];
  await visitFileTree(root, async ({ dirent, path }) => {
    if (!dirent.isFile() || !include(path)) return;
    files.push({
      path: relative(root, path).split(sep).join('/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    });
  });
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
};

const dashboardAssetContract = async (runtimeRoot: string): Promise<readonly BundleFileContract[]> => {
  const dashboardRoot = resolve(runtimeRoot, 'apps/web/dist/client');
  const assets = await bundleFileContract(dashboardRoot);
  if (!assets.some(asset => asset.path === 'index.html')) {
    throw new Error(`Desktop bundle Dashboard manifest has no index.html beneath ${dashboardRoot}`);
  }
  if (!assets.some(asset => asset.path === 'dashboard-routes.json')) {
    throw new Error(`Desktop bundle Dashboard manifest has no dashboard-routes.json beneath ${dashboardRoot}`);
  }
  return assets;
};

const migrationFileContract = async (migrationsRoot: string): Promise<readonly BundleFileContract[]> => {
  const names = (await readdir(migrationsRoot)).filter(name => name.endsWith('.sql')).sort();
  const files = await Promise.all(names.map(async path => ({
    path,
    sha256: createHash('sha256').update(await readFile(resolve(migrationsRoot, path))).digest('hex'),
  })));
  if (files.length === 0) {
    throw new Error(`Desktop bundle migration manifest is empty beneath ${migrationsRoot}`);
  }
  return files;
};

const assertCanonicalMigrations = async (
  deployedRoot: string,
  canonicalFiles: readonly BundleFileContract[],
): Promise<void> => {
  let deployedNames: string[];
  try {
    deployedNames = (await readdir(deployedRoot)).filter(name => name.endsWith('.sql')).sort();
  } catch (cause) {
    throw new Error(`Desktop bundle migrations are unavailable at ${deployedRoot}`, { cause });
  }
  const canonicalNames = canonicalFiles.map(file => file.path);
  if (JSON.stringify(deployedNames) !== JSON.stringify(canonicalNames)) {
    throw new Error(
      `Deployed migration inventory ${JSON.stringify(deployedNames)} differs from canonical source ${JSON.stringify(canonicalNames)}`,
    );
  }
  for (const canonical of canonicalFiles) {
    const deployedPath = resolve(deployedRoot, canonical.path);
    let deployedDigest: string;
    try {
      deployedDigest = createHash('sha256').update(await readFile(deployedPath)).digest('hex');
    } catch (cause) {
      throw new Error(`Deployed migration is unavailable at ${deployedPath}`, { cause });
    }
    if (deployedDigest !== canonical.sha256) {
      throw new Error(`Deployed migration differs from canonical source at ${deployedPath}`);
    }
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

const makeNativeModulesTargetSpecific = async (
  runtimeRoot: string,
  architecture: MachOArchitecture,
): Promise<void> => {
  await visitFileTree(resolve(runtimeRoot, 'apps/platform-node/node_modules'), async ({ dirent, path }) => {
    if (dirent.isFile() && dirent.name.endsWith('.node')) {
      await thinMachOToArchitecture(path, architecture);
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

const publishPreparedInputs = async (
  stagedRoot: string,
  finalRoot: string,
  temporaryRoot: string,
  exchangeDirectories: AtomicDirectoryExchange,
): Promise<void> => {
  try {
    await stat(finalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Failed to inspect the current desktop bundle inputs before publication', { cause: error });
    }
    try {
      await rename(stagedRoot, finalRoot);
    } catch (cause) {
      throw new Error('Failed to atomically publish the initial complete desktop bundle inputs', { cause });
    }
    return;
  }
  try {
    await exchangeDirectories(stagedRoot, finalRoot, temporaryRoot);
  } catch (cause) {
    throw new Error('Failed to atomically publish the complete desktop bundle inputs', { cause });
  }
};

export const prepareDesktopBundle = async ({
  canonicalMigrationsRoot,
  desktopRoot,
  generateRuntime,
  nodeArchitecture,
  nodeExecutable,
  nodePlatform,
  nodeVersion,
  targetTriple,
  executeNode = true,
  exchangeDirectories = exchangeDirectoriesAtomically,
  cleanupStaging = async path => await rm(path, { force: true, recursive: true }),
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
  await rm(stagingContainer, { force: true, recursive: true });
  await mkdir(stagedBinariesRoot, { recursive: true });
  await settleWithCleanup(async () => {
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
    if (nodePlatform === 'darwin') {
      await makeNativeModulesTargetSpecific(stagedRuntimeRoot, architectureForTargetTriple(targetTriple));
    }
    await assertPackagedRuntime(stagedRuntimeRoot);
    const canonicalMigrations = await migrationFileContract(canonicalMigrationsRoot);
    await assertCanonicalMigrations(
      resolve(stagedRuntimeRoot, 'apps/platform-node/node_modules/@floway-dev/gateway/migrations'),
      canonicalMigrations,
    );
    const contract: DesktopBundleContract = {
      schemaVersion: 1,
      dashboard: { assets: await dashboardAssetContract(stagedRuntimeRoot) },
      migrations: { files: canonicalMigrations },
      node: {
        architecture: nodeArchitecture,
        platform: nodePlatform,
        targetTriple,
        version: nodeVersion,
      },
    };
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
    await publishPreparedInputs(stagedInputsRoot, inputsRoot, stagingContainer, exchangeDirectories);
  }, async () => await cleanupStaging(stagingContainer),
  'Desktop bundle assembly failed and staging rollback cleanup also failed');
  const runtimeRoot = resolve(inputsRoot, 'runtime');
  const nodeSidecar = join(inputsRoot, 'binaries', sidecarName);
  const contractPath = resolve(inputsRoot, 'desktop-bundle-contract.json');
  return { contractPath, nodeSidecar, runtimeRoot };
};
