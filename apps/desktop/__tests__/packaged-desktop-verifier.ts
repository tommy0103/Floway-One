import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { exactPackageVersion, parseDependencyAssociations } from '../src/lockfile.ts';
import {
  assertMachOArchitecture,
  machOCpuTypeForArchitecture,
  type MachOArchitecture,
} from '../src/mach-o.ts';
import {
  architectureForTargetTriple,
  readPackagedNodeVersion,
  targetTripleForHost,
} from '../src/release-contract.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');
const profileArguments = process.argv.slice(2).filter(argument => argument !== '--');
if (profileArguments.length > 1) {
  throw new Error('Usage: packaged-desktop-verifier.ts [--profile=debug|--profile=release]');
}
const profileArgument = profileArguments[0];
const profile = profileArgument === undefined
  ? 'release'
  : /^--profile=(debug|release)$/.exec(profileArgument)?.[1];
if (profile === undefined) throw new Error('Usage: packaged-desktop-verifier.ts [--profile=debug|--profile=release]');
if (process.platform !== 'darwin') {
  throw new Error('The exploded packaged-desktop verifier requires a native macOS .app bundle');
}

const appRoot = resolve(desktopRoot, `src-tauri/target/${profile}/bundle/macos/Floway One.app`);
const appExecutable = resolve(appRoot, 'Contents/MacOS/floway-one');
const nodeExecutable = resolve(appRoot, 'Contents/MacOS/floway-node');
const runtimeRoot = resolve(appRoot, 'Contents/Resources/runtime');
const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');
const dependenciesRoot = resolve(platformNodeRoot, 'node_modules');
const expectedArchitecture = architectureForTargetTriple(targetTripleForHost(process.platform, process.arch));

const errorOutput = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const processError = error as Error & { stderr?: unknown; stdout?: unknown };
  return [processError.stdout, processError.stderr, error.message]
    .filter(value => typeof value === 'string')
    .join('\n');
};

const runExpectedFailure = async (executable: string, expectedFragments: readonly string[]): Promise<string> => {
  let output: string;
  try {
    await execFileAsync(executable, ['--verify-package'], { timeout: 30_000 });
    throw new Error('Expected packaged application verification to fail');
  } catch (error) {
    output = errorOutput(error);
    if (output.includes('Expected packaged application verification to fail')) throw error;
  }
  for (const fragment of expectedFragments) {
    if (!output.includes(fragment)) {
      throw new Error(`Packaged application failure omitted ${JSON.stringify(fragment)}\n${output}`);
    }
  }
  return output;
};

const readSidecarPid = (output: string): number | null => {
  const encoded = /Floway package verification sidecar pid (\d+)/.exec(output)?.[1];
  return encoded === undefined ? null : Number(encoded);
};

const assertProcessStopped = (pid: number): void => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  throw new Error(`Packaged verification left sidecar process ${pid} running`);
};

await Promise.all([
  access(appExecutable),
  access(nodeExecutable),
  access(resolve(platformNodeRoot, 'entry.js')),
  access(resolve(platformNodeRoot, 'node_modules/@floway-dev/gateway/migrations/0084_protected_search_secret_columns.sql')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/index.html')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/dashboard-routes.json')),
]);

const packagedNodeVersion = await readPackagedNodeVersion(desktopRoot);
const version = (await execFileAsync(nodeExecutable, ['--version'])).stdout.trim();
if (version !== `v${packagedNodeVersion}`) {
  throw new Error(`Packaged desktop Node version is ${version}, expected v${packagedNodeVersion}`);
}

const probe = await execFileAsync(nodeExecutable, [
  '--input-type=module',
  '--eval',
  "const keyring = await import('@napi-rs/keyring'); if (typeof keyring.Entry !== 'function') throw new Error('Keyring native Entry is unavailable'); await import('@floway-dev/gateway'); await import('./entry.js'); console.log('embedded runtime imports resolved');",
], { cwd: platformNodeRoot });
if (probe.stdout.trim() !== 'embedded runtime imports resolved') {
  throw new Error(`Packaged desktop import probe returned unexpected output: ${JSON.stringify(probe.stdout)}`);
}

const pending = [dependenciesRoot];
const nativeModules: string[] = [];
while (pending.length > 0) {
  const directory = pending.pop()!;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Packaged desktop app retained an unresolved dependency symlink: ${path}`);
    }
    if (entry.isDirectory()) pending.push(path);
    else if (entry.isFile() && entry.name.endsWith('.node')) nativeModules.push(path);
  }
}
const sharpNative = nativeModules.find(path => path.includes('sharp'));
if (sharpNative === undefined) throw new Error('Packaged desktop app does not contain the target sharp native module');
const keyringNatives = nativeModules.filter(path => path.includes('keyring'));
if (keyringNatives.length === 0) {
  throw new Error('Packaged desktop app does not contain the target operating-system Keyring native module');
}

await Promise.all([
  assertMachOArchitecture(appExecutable, expectedArchitecture),
  assertMachOArchitecture(nodeExecutable, expectedArchitecture),
  ...nativeModules.map(path => assertMachOArchitecture(path, expectedArchitecture)),
]);

const rootLockSource = await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
const packagedLockSource = await readFile(resolve(platformNodeRoot, 'pnpm-lock.yaml'), 'utf8');
const rootAssociations = parseDependencyAssociations(rootLockSource, 'apps/platform-node', 'root lockfile');
const packagedAssociations = parseDependencyAssociations(packagedLockSource, '.', 'packaged lockfile');
const platformManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, 'apps/platform-node/package.json'), 'utf8'),
) as { dependencies?: Record<string, string> };
const externalDependencies = Object.entries(platformManifest.dependencies ?? {})
  .filter(([, specifier]) => !specifier.startsWith('workspace:'))
  .map(([name]) => name);
for (const name of externalDependencies) {
  const rootAssociation = rootAssociations.get(name);
  const packagedAssociation = packagedAssociations.get(name);
  if (rootAssociation === undefined || packagedAssociation === undefined) {
    throw new Error(`Lockfile association for packaged dependency ${name} is missing`);
  }
  if (packagedAssociation !== rootAssociation) {
    throw new Error(`Packaged dependency ${name} changed lock association from ${rootAssociation} to ${packagedAssociation}`);
  }
  const manifest = JSON.parse(
    await readFile(resolve(dependenciesRoot, name, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  const expectedVersion = exactPackageVersion(rootAssociation, name);
  if (manifest.version !== expectedVersion) {
    throw new Error(`Packaged desktop dependency ${name} is ${String(manifest.version)}, expected ${expectedVersion}`);
  }
}

// Tauri rejects a starting executable with a symlink in any macOS path ancestor;
// canonicalize the system temp root before the direct executable launch.
// https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/crates/tauri-utils/src/platform/starting_binary.rs#L61-L75
const isolatedRoot = await mkdtemp(join(await realpath(tmpdir()), 'floway-desktop-installed-'));
const installedApp = resolve(isolatedRoot, 'Applications/Floway One.app');
try {
  await mkdir(dirname(installedApp), { recursive: true });
  // Node's FICLONE mode requests a copy-on-write app copy and falls back to a
  // physical copy when the filesystem cannot clone, preserving install semantics.
  // https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/doc/api/fs.md#L1075-L1125
  // https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/doc/api/fs.md#L1033-L1046
  await cp(appRoot, installedApp, { mode: fsConstants.COPYFILE_FICLONE, recursive: true });
  const installedExecutable = resolve(installedApp, 'Contents/MacOS/floway-one');
  const installedNode = resolve(installedApp, 'Contents/MacOS/floway-node');
  const installedPlatformNode = resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node');
  const installedEntry = resolve(installedPlatformNode, 'entry.js');
  const installedKeyringRoot = resolve(installedPlatformNode, 'node_modules/@napi-rs/keyring');
  const installedKeyringManifest = JSON.parse(
    await readFile(resolve(installedKeyringRoot, 'package.json'), 'utf8'),
  ) as { main?: unknown };
  if (typeof installedKeyringManifest.main !== 'string') {
    throw new Error('Installed Keyring package does not declare its runtime entry');
  }
  const installedKeyringEntry = resolve(installedKeyringRoot, installedKeyringManifest.main);

  const launched = await execFileAsync(installedExecutable, ['--verify-package'], { timeout: 30_000 });
  if (!launched.stdout.includes('Floway package verification succeeded')) {
    throw new Error(`Installed application verification omitted success\n${launched.stdout}\n${launched.stderr}`);
  }
  const successfulPid = readSidecarPid(launched.stdout);
  if (successfulPid === null) throw new Error('Installed application did not report its verification sidecar PID');
  assertProcessStopped(successfulPid);

  const missingEntry = `${installedEntry}.missing`;
  await rename(installedEntry, missingEntry);
  try {
    await runExpectedFailure(installedExecutable, ['Floway desktop runtime resource is unavailable', 'entry.js']);
  } finally {
    await rename(missingEntry, installedEntry);
  }

  const brokenKeyringEntry = `${installedKeyringEntry}.broken`;
  await rename(installedKeyringEntry, brokenKeyringEntry);
  try {
    const output = await runExpectedFailure(installedExecutable, ['keyring', 'verification sidecar exited']);
    const failedPid = readSidecarPid(output);
    if (failedPid === null) throw new Error('Broken Keyring launch did not report its sidecar PID');
    assertProcessStopped(failedPid);
  } finally {
    await rename(brokenKeyringEntry, installedKeyringEntry);
  }

  const nodeFile = await open(installedNode, 'r+');
  const originalCpuType = Buffer.alloc(4);
  try {
    await nodeFile.read(originalCpuType, 0, 4, 4);
    const wrongArchitecture: MachOArchitecture = expectedArchitecture === 'arm64' ? 'x64' : 'arm64';
    const replacement = Buffer.alloc(4);
    replacement.writeUInt32LE(machOCpuTypeForArchitecture(wrongArchitecture));
    await nodeFile.write(replacement, 0, 4, 4);
    await nodeFile.sync();
    await runExpectedFailure(installedExecutable, ['Floway desktop application failed', 'sidecar']);
  } finally {
    await nodeFile.write(originalCpuType, 0, 4, 4);
    await nodeFile.close();
  }
} finally {
  await rm(isolatedRoot, { force: true, recursive: true });
}

console.log('Packaged Floway desktop app verified architecture, embedded Node/Keyring/gateway, locked dependencies, isolated launch/fault chains, child cleanup, migrations, native sharp, and Dashboard assets');
