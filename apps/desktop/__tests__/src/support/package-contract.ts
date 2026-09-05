import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { visitFileTree } from '../../../src/filesystem-tree.ts';
import { assertSingleMachOArchitecture } from '../../../src/mach-o.ts';
import {
  architectureForTargetTriple,
  readPackagedNodeVersion,
  type DesktopTargetTriple,
} from '../../../src/release-contract.ts';
import { exactPackageVersion, parseDependencyAssociations } from '../lockfile.ts';

const execFileAsync = promisify(execFile);

interface BundleFileContract {
  readonly path: string;
  readonly sha256: string;
}

interface DesktopBundleContract {
  readonly dashboard: { readonly assets: readonly BundleFileContract[] };
  readonly migrations: { readonly files: readonly BundleFileContract[] };
  readonly node: {
    readonly architecture: unknown;
    readonly platform: unknown;
    readonly targetTriple: unknown;
    readonly version: unknown;
  };
  readonly schemaVersion: unknown;
}

export interface PackagedApplicationVerification {
  readonly appExecutable: string;
  readonly appRoot: string;
  readonly contractPath: string;
  readonly dashboardAssets: readonly BundleFileContract[];
  readonly loadedKeyringNative?: string;
  readonly migrationNames: readonly string[];
  readonly nativeModules: readonly string[];
  readonly nodeExecutable: string;
  readonly platformNodeRoot: string;
  readonly runtimeRoot: string;
}

const validateFileContract = async (
  root: string,
  files: readonly BundleFileContract[],
  label: string,
): Promise<void> => {
  let previous = '';
  for (const file of files) {
    if (file.path <= previous || isAbsolute(file.path) || file.path.split('/').includes('..')) {
      throw new Error(`Packaged ${label} contract has an unsafe, duplicated, or unsorted path: ${file.path}`);
    }
    previous = file.path;
    const path = resolve(root, file.path);
    const owned = relative(root, path);
    if (isAbsolute(owned) || owned.split(sep)[0] === '..') {
      throw new Error(`Packaged ${label} contract resolves outside its production root: ${file.path}`);
    }
    const actualDigest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (actualDigest !== file.sha256.toLowerCase()) {
      throw new Error(`Packaged ${label} contract has a stale digest for ${file.path}`);
    }
  }
};

const exactSqlNames = async (root: string): Promise<string[]> =>
  (await readdir(root)).filter(name => name.endsWith('.sql')).sort();

export const verifyPackagedApplication = async (options: {
  readonly desktopRoot: string;
  readonly launchSupported: boolean;
  readonly profile: 'debug' | 'release';
  readonly repositoryRoot: string;
  readonly targetTriple: DesktopTargetTriple;
}): Promise<PackagedApplicationVerification> => {
  const { desktopRoot, launchSupported, profile, repositoryRoot, targetTriple } = options;
  const appRoot = resolve(desktopRoot, `src-tauri/target/${targetTriple}/${profile}/bundle/macos/Floway.app`);
  const appExecutable = resolve(appRoot, 'Contents/MacOS/floway-one');
  const nodeExecutable = resolve(appRoot, 'Contents/MacOS/floway-node');
  const runtimeRoot = resolve(appRoot, 'Contents/Resources/runtime');
  const contractPath = resolve(appRoot, 'Contents/Resources/desktop-bundle-contract.json');
  const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');
  const dependenciesRoot = resolve(platformNodeRoot, 'node_modules');
  const expectedArchitecture = architectureForTargetTriple(targetTriple);

  await Promise.all([
    access(appExecutable),
    access(nodeExecutable),
    access(contractPath),
    access(resolve(platformNodeRoot, 'entry.js')),
    access(resolve(runtimeRoot, 'apps/web/dist/client/index.html')),
    access(resolve(runtimeRoot, 'apps/web/dist/client/dashboard-routes.json')),
  ]);

  const packagedNodeVersion = await readPackagedNodeVersion(desktopRoot);
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Partial<DesktopBundleContract>;
  if (
    contract.schemaVersion !== 1
    || contract.node?.architecture !== expectedArchitecture
    || contract.node.platform !== 'darwin'
    || contract.node.targetTriple !== targetTriple
    || contract.node.version !== packagedNodeVersion
    || !Array.isArray(contract.dashboard?.assets)
    || contract.dashboard.assets.length === 0
    || contract.dashboard.assets.some(asset => typeof asset.path !== 'string' || !/^[\da-f]{64}$/i.test(String(asset.sha256)))
    || !Array.isArray(contract.migrations?.files)
    || contract.migrations.files.length === 0
    || contract.migrations.files.some(file => typeof file.path !== 'string' || !/^[\da-f]{64}$/i.test(String(file.sha256)))
  ) {
    throw new Error(`Packaged desktop contract does not own ${targetTriple}/Node.js ${packagedNodeVersion}`);
  }
  const dashboardAssets = contract.dashboard.assets;
  const migrations = contract.migrations.files;
  await validateFileContract(resolve(runtimeRoot, 'apps/web/dist/client'), dashboardAssets, 'Dashboard');

  const migrationNames = migrations.map(file => file.path);
  const canonicalMigrationsRoot = resolve(repositoryRoot, 'packages/gateway/migrations');
  const deployedMigrationsRoot = resolve(platformNodeRoot, 'node_modules/@floway-dev/gateway/migrations');
  const [canonicalNames, deployedNames] = await Promise.all([
    exactSqlNames(canonicalMigrationsRoot),
    exactSqlNames(deployedMigrationsRoot),
  ]);
  for (const [label, names] of [['canonical', canonicalNames], ['deployed', deployedNames]] as const) {
    if (JSON.stringify(names) !== JSON.stringify(migrationNames)) {
      throw new Error(`${label} migration inventory ${JSON.stringify(names)} differs from contract ${JSON.stringify(migrationNames)}`);
    }
  }
  await Promise.all([
    validateFileContract(canonicalMigrationsRoot, migrations, 'canonical migration'),
    validateFileContract(deployedMigrationsRoot, migrations, 'deployed migration'),
  ]);

  if (launchSupported) {
    const version = (await execFileAsync(nodeExecutable, ['--version'])).stdout.trim();
    if (version !== `v${packagedNodeVersion}`) {
      throw new Error(`Packaged desktop Node version is ${version}, expected v${packagedNodeVersion}`);
    }
  }

  let loadedKeyringNative: string | undefined;
  if (launchSupported) {
    // https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/doc/api/report.md#L434-L438
    const probe = await execFileAsync(nodeExecutable, [
      '--input-type=module',
      '--eval',
      "const before = new Set(process.report.getReport().sharedObjects); const keyringEntry = import.meta.resolve('@napi-rs/keyring'); const keyring = await import(keyringEntry); if (typeof keyring.Entry !== 'function') throw new Error('Keyring native Entry is unavailable'); const keyringNative = process.report.getReport().sharedObjects.find(path => !before.has(path) && path.endsWith('.node') && path.toLowerCase().includes('keyring')); if (keyringNative === undefined) throw new Error('Keyring import reported no loaded native binding'); await import('@floway-dev/gateway'); await import('./entry.js'); console.log(JSON.stringify({ keyringEntry, keyringNative, marker: 'embedded runtime imports resolved' }));",
    ], { cwd: platformNodeRoot });
    const result = JSON.parse(probe.stdout.trim()) as { keyringEntry?: unknown; keyringNative?: unknown; marker?: unknown };
    if (result.marker !== 'embedded runtime imports resolved' || typeof result.keyringEntry !== 'string' || typeof result.keyringNative !== 'string') {
      throw new Error(`Packaged desktop import probe returned unexpected output: ${JSON.stringify(probe.stdout)}`);
    }
    for (const path of [fileURLToPath(result.keyringEntry), result.keyringNative]) {
      const owned = relative(appRoot, path);
      if (isAbsolute(owned) || owned.split(sep)[0] === '..') {
        throw new Error(`Embedded Node resolved Keyring outside the packaged app: ${path}`);
      }
    }
    loadedKeyringNative = result.keyringNative;
  }

  const nativeModules: string[] = [];
  await visitFileTree(dependenciesRoot, async ({ dirent, path }) => {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Packaged desktop app retained an unresolved dependency symlink: ${path}`);
    }
    if (dirent.isFile() && dirent.name.endsWith('.node')) nativeModules.push(path);
  });
  if (!nativeModules.some(path => path.includes('sharp'))) {
    throw new Error('Packaged desktop app does not contain the target sharp native module');
  }
  if (!nativeModules.some(path => path.includes('keyring'))) {
    throw new Error('Packaged desktop app does not contain the target operating-system Keyring native module');
  }
  if (loadedKeyringNative !== undefined && !nativeModules.includes(loadedKeyringNative)) {
    throw new Error(`Loaded Keyring native binding was not found in the packaged dependency tree: ${loadedKeyringNative}`);
  }
  await Promise.all([
    assertSingleMachOArchitecture(appExecutable, expectedArchitecture),
    assertSingleMachOArchitecture(nodeExecutable, expectedArchitecture),
    ...nativeModules.map(path => assertSingleMachOArchitecture(path, expectedArchitecture)),
  ]);

  const rootAssociations = parseDependencyAssociations(
    await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
    'apps/platform-node',
    'root lockfile',
  );
  const packagedAssociations = parseDependencyAssociations(
    await readFile(resolve(platformNodeRoot, 'pnpm-lock.yaml'), 'utf8'),
    '.',
    'packaged lockfile',
  );
  const platformManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, 'apps/platform-node/package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  for (const [name, specifier] of Object.entries(platformManifest.dependencies ?? {})) {
    if (specifier.startsWith('workspace:')) continue;
    const rootAssociation = rootAssociations.get(name);
    const packagedAssociation = packagedAssociations.get(name);
    if (rootAssociation === undefined || packagedAssociation === undefined) {
      throw new Error(`Lockfile association for packaged dependency ${name} is missing`);
    }
    if (packagedAssociation !== rootAssociation) {
      throw new Error(`Packaged dependency ${name} changed lock association from ${rootAssociation} to ${packagedAssociation}`);
    }
    const manifest = JSON.parse(await readFile(resolve(dependenciesRoot, name, 'package.json'), 'utf8')) as { version?: unknown };
    const expectedVersion = exactPackageVersion(rootAssociation, name);
    if (manifest.version !== expectedVersion) {
      throw new Error(`Packaged desktop dependency ${name} is ${String(manifest.version)}, expected ${expectedVersion}`);
    }
  }

  return {
    appExecutable,
    appRoot,
    contractPath,
    dashboardAssets,
    migrationNames,
    nativeModules,
    nodeExecutable,
    platformNodeRoot,
    runtimeRoot,
    ...(loadedKeyringNative === undefined ? {} : { loadedKeyringNative }),
  };
};
