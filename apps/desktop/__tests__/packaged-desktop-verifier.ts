import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { visitFileTree } from '../src/filesystem-tree.ts';
import { exactPackageVersion, parseDependencyAssociations } from '../src/lockfile.ts';
import {
  assertMachOArchitecture,
  assertSingleMachOArchitecture,
  machOCpuTypeForArchitecture,
  type MachOArchitecture,
} from '../src/mach-o.ts';
import {
  architectureForTargetTriple,
  MACOS_TARGET_TRIPLES,
  readPackagedNodeVersion,
  type DesktopTargetTriple,
} from '../src/release-contract.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');
const arguments_ = process.argv.slice(2).filter(argument => argument !== '--');
const profile = /^--profile=(debug|release)$/.exec(
  arguments_.find(argument => argument.startsWith('--profile=')) ?? '--profile=release',
)?.[1];
const targetArgument = arguments_.find(argument => argument.startsWith('--target='))?.slice('--target='.length);
const launchArgument = arguments_.find(argument => argument.startsWith('--launch='))?.slice('--launch='.length) ?? 'yes';
const knownArguments = arguments_.filter(argument =>
  argument.startsWith('--profile=') || argument.startsWith('--target=') || argument.startsWith('--launch='));
if (
  profile === undefined
  || knownArguments.length !== arguments_.length
  || targetArgument === undefined
  || !MACOS_TARGET_TRIPLES.some(target => target === targetArgument)
  || (launchArgument !== 'yes' && launchArgument !== 'no')
) {
  throw new Error(
    'Usage: packaged-desktop-verifier.ts --target=aarch64-apple-darwin|x86_64-apple-darwin [--profile=debug|--profile=release] [--launch=yes|no]',
  );
}
const targetTriple = targetArgument as DesktopTargetTriple;
const launchSupported = launchArgument === 'yes';
if (process.platform !== 'darwin') {
  throw new Error('The exploded packaged-desktop verifier requires a native macOS .app bundle');
}

const appRoot = resolve(desktopRoot, `src-tauri/target/${targetTriple}/${profile}/bundle/macos/Floway One.app`);
const appExecutable = resolve(appRoot, 'Contents/MacOS/floway-one');
const nodeExecutable = resolve(appRoot, 'Contents/MacOS/floway-node');
const runtimeRoot = resolve(appRoot, 'Contents/Resources/runtime');
const contractPath = resolve(appRoot, 'Contents/Resources/desktop-bundle-contract.json');
const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');
const dependenciesRoot = resolve(platformNodeRoot, 'node_modules');
const expectedArchitecture = architectureForTargetTriple(targetTriple);

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
    const unexpectedSuccess = await execFileAsync(executable, ['--verify-package'], { timeout: 30_000 });
    throw new Error(
      `Expected packaged application verification to fail\nstdout:\n${unexpectedSuccess.stdout}\nstderr:\n${unexpectedSuccess.stderr}`,
    );
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

const waitForProcessStopped = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Packaged verification left sidecar process ${pid} running`);
};

const reserveLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
    if (error === undefined) resolveClose();
    else rejectClose(error);
  }));
  return port;
};

const assertPersonalRuntime = async (
  executable: string,
  embeddedNode: string,
  platformNode: string,
  verificationRoot: string,
): Promise<void> => {
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const credentialService = `Floway desktop package verification ${randomUUID()}`;
  const credentialAccount = `device-master-key-${randomUUID()}`;
  const child = spawn(executable, ['--verify-personal-runtime'], {
    env: {
      ...process.env,
      FLOWAY_PERSONAL_VERIFICATION_CREDENTIAL_ACCOUNT: credentialAccount,
      FLOWAY_PERSONAL_VERIFICATION_CREDENTIAL_SERVICE: credentialService,
      FLOWAY_PERSONAL_VERIFICATION_PORT: String(port),
      FLOWAY_PERSONAL_VERIFICATION_ROOT: verificationRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const deadline = Date.now() + 30_000;
  let health: Response | undefined;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      health = await fetch(`${origin}/api/health`);
      if (health.ok) break;
    } catch { /* listener is still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (health?.ok !== true) {
    child.kill('SIGTERM');
    throw new Error(`Installed personal runtime did not become healthy\n${output}`);
  }
  const explicitPid = /Floway personal verification sidecar pid (\d+)/.exec(output)?.[1];
  if (explicitPid === undefined) throw new Error(`Installed personal runtime did not report its sidecar PID\n${output}`);
  const runtimePid = Number(explicitPid);

  const documentResponse = await fetch(origin);
  if (!documentResponse.ok) throw new Error(`Installed Dashboard document returned ${documentResponse.status}`);
  const document = await documentResponse.text();
  const assetPath = /(?:href|src)="(\/assets\/[^"]+)"/.exec(document)?.[1];
  if (assetPath === undefined) throw new Error('Installed Dashboard document names no asset');
  const assetResponse = await fetch(`${origin}${assetPath}`);
  if (!assetResponse.ok) throw new Error(`Installed Dashboard asset returned ${assetResponse.status}`);

  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  process.kill(runtimePid, 'SIGTERM');
  const [code, signal] = await exited;
  if (code !== 0) throw new Error(`Installed personal runtime app exited with ${code ?? signal}\n${output}`);
  if (!output.includes('Floway personal verification shut down cleanly')) {
    throw new Error(`Installed personal runtime omitted clean shutdown evidence\n${output}`);
  }
  await waitForProcessStopped(runtimePid);
  try {
    await fetch(`${origin}/api/health`);
    throw new Error('Installed personal runtime listener remained reachable after shutdown');
  } catch (error) {
    if (error instanceof Error && error.message.includes('remained reachable')) throw error;
  }

  const database = new DatabaseSync(resolve(verificationRoot, 'floway.db'), { readOnly: true });
  try {
    const migration = database.prepare("SELECT name FROM _migrations WHERE name = '0084_protected_search_secret_columns.sql'").get();
    if (migration === undefined) throw new Error('Installed personal runtime did not apply the complete migration set');
  } finally {
    database.close();
  }

  await execFileAsync(embeddedNode, [
    '--input-type=module',
    '--eval',
    `const { Entry } = await import('@napi-rs/keyring'); const entry = new Entry(${JSON.stringify(credentialService)}, ${JSON.stringify(credentialAccount)}); entry.deleteCredential(); if (entry.getSecret() !== null) throw new Error('isolated verification credential remains');`,
  ], { cwd: platformNode });
};

await Promise.all([
  access(appExecutable),
  access(nodeExecutable),
  access(contractPath),
  access(resolve(platformNodeRoot, 'entry.js')),
  access(resolve(platformNodeRoot, 'node_modules/@floway-dev/gateway/migrations/0084_protected_search_secret_columns.sql')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/index.html')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/dashboard-routes.json')),
]);

const packagedNodeVersion = await readPackagedNodeVersion(desktopRoot);
const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
  node?: { architecture?: unknown; platform?: unknown; targetTriple?: unknown; version?: unknown };
  schemaVersion?: unknown;
};
if (
  contract.schemaVersion !== 1
  || contract.node?.architecture !== expectedArchitecture
  || contract.node.platform !== 'darwin'
  || contract.node.targetTriple !== targetTriple
  || contract.node.version !== packagedNodeVersion
) {
  throw new Error(`Packaged desktop contract does not own ${targetTriple}/Node.js ${packagedNodeVersion}`);
}
if (launchSupported) {
  const version = (await execFileAsync(nodeExecutable, ['--version'])).stdout.trim();
  if (version !== `v${packagedNodeVersion}`) {
    throw new Error(`Packaged desktop Node version is ${version}, expected v${packagedNodeVersion}`);
  }
}

let loadedKeyringNative: string | undefined;
if (launchSupported) {
  const probe = await execFileAsync(nodeExecutable, [
    '--input-type=module',
    '--eval',
    "const before = new Set(process.report.getReport().sharedObjects); const keyringEntry = import.meta.resolve('@napi-rs/keyring'); const keyring = await import(keyringEntry); if (typeof keyring.Entry !== 'function') throw new Error('Keyring native Entry is unavailable'); const keyringNative = process.report.getReport().sharedObjects.find(path => !before.has(path) && path.endsWith('.node') && path.toLowerCase().includes('keyring')); if (keyringNative === undefined) throw new Error('Keyring import reported no loaded native binding'); await import('@floway-dev/gateway'); await import('./entry.js'); console.log(JSON.stringify({ keyringEntry, keyringNative, marker: 'embedded runtime imports resolved' }));",
  ], { cwd: platformNodeRoot });
  const probeResult = JSON.parse(probe.stdout.trim()) as {
    keyringEntry?: unknown;
    keyringNative?: unknown;
    marker?: unknown;
  };
  if (
    probeResult.marker !== 'embedded runtime imports resolved'
    || typeof probeResult.keyringEntry !== 'string'
    || typeof probeResult.keyringNative !== 'string'
  ) {
    throw new Error(`Packaged desktop import probe returned unexpected output: ${JSON.stringify(probe.stdout)}`);
  }
  for (const path of [fileURLToPath(probeResult.keyringEntry), probeResult.keyringNative]) {
    const relativePath = relative(appRoot, path);
    if (isAbsolute(relativePath) || relativePath.split(sep)[0] === '..') {
      throw new Error(`Embedded Node resolved Keyring outside the packaged app: ${path}`);
    }
  }
  loadedKeyringNative = probeResult.keyringNative;
}

const nativeModules: string[] = [];
await visitFileTree(dependenciesRoot, async ({ dirent: entry, path }) => {
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error(`Packaged desktop app retained an unresolved dependency symlink: ${path}`);
  }
  if (entry.isFile() && entry.name.endsWith('.node')) nativeModules.push(path);
});
const sharpNative = nativeModules.find(path => path.includes('sharp'));
if (sharpNative === undefined) throw new Error('Packaged desktop app does not contain the target sharp native module');
const keyringNatives = nativeModules.filter(path => path.includes('keyring'));
if (keyringNatives.length === 0) {
  throw new Error('Packaged desktop app does not contain the target operating-system Keyring native module');
}
if (loadedKeyringNative !== undefined && !nativeModules.includes(loadedKeyringNative)) {
  throw new Error(`Loaded Keyring native binding was not found in the packaged dependency tree: ${loadedKeyringNative}`);
}

await Promise.all([
  assertSingleMachOArchitecture(appExecutable, expectedArchitecture),
  assertSingleMachOArchitecture(nodeExecutable, expectedArchitecture),
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
if (launchSupported) {
  const isolatedRoot = await mkdtemp(join(await realpath(tmpdir()), 'floway-desktop-installed-'));
  const installedApp = resolve(isolatedRoot, 'Applications/Floway One.app');
  try {
    await mkdir(dirname(installedApp), { recursive: true });
    await rename(appRoot, installedApp);
    const installedExecutable = resolve(installedApp, 'Contents/MacOS/floway-one');
    const installedNode = resolve(installedApp, 'Contents/MacOS/floway-node');
    const installedPlatformNode = resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node');
    const installedEntry = resolve(installedPlatformNode, 'entry.js');
    const installedKeyringNative = resolve(
      installedApp,
      relative(appRoot, loadedKeyringNative!),
    );

    await assertPersonalRuntime(
      installedExecutable,
      installedNode,
      installedPlatformNode,
      resolve(isolatedRoot, 'PersonalData'),
    );

    const launched = await execFileAsync(installedExecutable, ['--verify-package'], { timeout: 30_000 });
    if (!launched.stdout.includes('Floway package verification succeeded')) {
      throw new Error(`Installed application verification omitted success\n${launched.stdout}\n${launched.stderr}`);
    }
    const successfulPid = readSidecarPid(launched.stdout);
    if (successfulPid === null) throw new Error('Installed application did not report its verification sidecar PID');
    await waitForProcessStopped(successfulPid);

    const missingEntry = `${installedEntry}.missing`;
    await rename(installedEntry, missingEntry);
    try {
      await runExpectedFailure(installedExecutable, ['Floway desktop runtime resource is unavailable', 'entry.js']);
    } finally {
      await rename(missingEntry, installedEntry);
    }

    const blockingMarker = resolve(installedPlatformNode, '.verify-blocking-sidecar');
    await writeFile(blockingMarker, 'keep the verification child alive until the parent timeout');
    try {
      const output = await runExpectedFailure(installedExecutable, [
        'blocking until parent timeout',
        'timed out and terminated its live sidecar',
      ]);
      const blockingPid = readSidecarPid(output);
      if (blockingPid === null) throw new Error('Blocking sidecar launch did not report its PID');
      await waitForProcessStopped(blockingPid);
    } finally {
      await rm(blockingMarker, { force: true });
    }

    const keyringFile = await open(installedKeyringNative, 'r+');
    const originalKeyringHeader = Buffer.alloc(8);
    try {
      await keyringFile.read(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
      await keyringFile.write(Buffer.alloc(originalKeyringHeader.byteLength), 0, originalKeyringHeader.byteLength, 0);
      await keyringFile.sync();
      const output = await runExpectedFailure(installedExecutable, ['keyring', 'verification sidecar exited']);
      const failedPid = readSidecarPid(output);
      if (failedPid === null) throw new Error('Broken Keyring launch did not report its sidecar PID');
      await waitForProcessStopped(failedPid);
    } finally {
      await keyringFile.write(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
      await keyringFile.sync();
      await keyringFile.close();
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
      await runExpectedFailure(installedExecutable, ['Failed to setup app', 'Bad CPU type in executable']);
    } finally {
      await nodeFile.write(originalCpuType, 0, 4, 4);
      await nodeFile.close();
    }
  } finally {
    await rm(isolatedRoot, { force: true, recursive: true });
  }
}

console.log(
  launchSupported
    ? `Packaged Floway desktop app ${targetTriple} verified architecture, embedded Node/Keyring/gateway, locked dependencies, isolated launch/fault chains, child cleanup, migrations, native sharp, and Dashboard assets`
    : `Packaged Floway desktop app ${targetTriple} passed static architecture, locked-dependency, migration, native-module, and Dashboard verification; this host cannot execute that target`,
);
