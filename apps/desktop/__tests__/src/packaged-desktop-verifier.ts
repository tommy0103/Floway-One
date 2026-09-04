import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
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
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { withFailureSafeCleanup } from '../../src/failure-chain.ts';
import { visitFileTree } from '../../src/filesystem-tree.ts';
import { exactPackageVersion, parseDependencyAssociations } from '../../src/lockfile.ts';
import {
  assertSingleMachOArchitecture,
  machOCpuTypeForArchitecture,
  type MachOArchitecture,
} from '../../src/mach-o.ts';
import {
  architectureForTargetTriple,
  MACOS_TARGET_TRIPLES,
  readPackagedNodeVersion,
  type DesktopTargetTriple,
} from '../../src/release-contract.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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

// XNU owns the POSIX signal identities used by Node's typed signal boundary.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/signal.h#L101-L104
const TERMINATION_SIGNAL: NodeJS.Signals = 'SIGTERM';
const FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';

type PersonalFailurePhase = 'app' | 'sidecar' | 'listener' | 'dashboard' | 'migration' | 'credential';
type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;
const PERSONAL_FAILURE_PHASES: readonly PersonalFailurePhase[] = [
  'app',
  'sidecar',
  'listener',
  'dashboard',
  'migration',
  'credential',
];

const errorChainIncludes = (error: unknown, fragment: string): boolean => {
  if (!(error instanceof Error)) return String(error).includes(fragment);
  if (error.message.includes(fragment)) return true;
  if (error instanceof AggregateError && error.errors.some(item => errorChainIncludes(item, fragment))) return true;
  return error.cause === undefined ? false : errorChainIncludes(error.cause, fragment);
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const waitForProcessStopped = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Packaged verification left process ${pid} running`);
};

const waitForProcessGroupStopped = async (groupId: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Packaged verification left process group ${groupId} running`);
};

const directChildPids = async (parentPid: number): Promise<number[]> => {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)]);
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return [];
    throw error;
  }
};

const waitForDirectChild = async (parent: CapturedChild): Promise<number> => {
  if (parent.pid === undefined) throw new Error('Floway production app process has no PID');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && parent.exitCode === null && parent.signalCode === null) {
    const [pid] = await directChildPids(parent.pid);
    if (pid !== undefined) return pid;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Floway production app did not start its packaged sidecar (pid ${parent.pid ?? 'unknown'})`);
};

const waitForChildExit = async (child: CapturedChild, timeoutMs: number): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Process ${child.pid ?? 'unknown'} did not exit`)), timeoutMs);
      timeout.unref();
    }),
  ]);
};

const terminateProcessGroup = async (child: CapturedChild): Promise<void> => {
  if (child.pid === undefined) return;
  const observedPids = [child.pid, ...await directChildPids(child.pid)];
  try {
    process.kill(-child.pid, TERMINATION_SIGNAL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  try {
    await waitForChildExit(child, 3_000);
  } catch {
    try {
      process.kill(-child.pid, FORCE_KILL_SIGNAL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await waitForChildExit(child, 3_000);
  }
  await Promise.all(observedPids.map(waitForProcessStopped));
  await waitForProcessGroupStopped(child.pid);
};

const captureApp = (executable: string, environment: NodeJS.ProcessEnv): {
  readonly child: CapturedChild;
  readonly output: () => string;
} => {
  const child = spawn(executable, [], {
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let captured = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { captured += chunk; });
  child.stderr.on('data', chunk => { captured += chunk; });
  child.once('error', error => { captured += `${error.stack ?? error.message}\n`; });
  return { child, output: () => captured };
};

// The personal runtime owns this stable port, and the desktop Dashboard origin
// must use the same authority for bootstrap and control-plane CORS.
// https://github.com/tommy0103/Floway-One/blob/dae7ba3773b50648b8a7ed75c5565b24f988919e/apps/platform-node/src/personal-runtime.ts#L18-L20
const PERSONAL_DASHBOARD_PORT = 8788;

const reserveNonDefaultLoopbackPort = async (): Promise<number> => await withFailureSafeCleanup(async cleanup => {
  const server = createServer();
  cleanup.defer('custom-port reservation', async () => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  if (port === PERSONAL_DASHBOARD_PORT) throw new Error('Operating system reserved the default port for the custom-port probe');
  return port;
});

const appEnvironmentWithoutPortOverride = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.PORT;
  return environment;
};

const assertLoopbackPortReleased = async (port: number): Promise<void> => {
  await withFailureSafeCleanup(async cleanup => {
    const server = createServer();
    cleanup.defer('listener-release probe', async () => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose();
        else rejectClose(error);
      }));
    });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', resolveListen);
      });
    } catch (cause) {
      throw new Error(`Floway verification listener still owns 127.0.0.1:${port}`, { cause });
    }
  });
};

const credentialScript = (service: string, account: string, action: 'delete' | 'require'): string => `
const { Entry } = await import('@napi-rs/keyring');
const entry = new Entry(${JSON.stringify(service)}, ${JSON.stringify(account)});
${action === 'delete' ? 'entry.deleteCredential();' : ''}
const secret = entry.getSecret();
if (${action === 'delete' ? 'secret !== null' : 'secret === null'}) {
  throw new Error(${JSON.stringify(action === 'delete'
    ? 'isolated verification credential remains'
    : 'isolated verification credential was not created')});
}
`;

const runCredentialScript = async (
  embeddedNode: string,
  platformNode: string,
  service: string,
  account: string,
  action: 'delete' | 'require',
): Promise<void> => {
  await execFileAsync(embeddedNode, ['--input-type=module', '--eval', credentialScript(service, account, action)], {
    cwd: platformNode,
    timeout: 10_000,
  });
};

const personalEntrySource = (
  dataRoot: string,
  credentialService: string,
  credentialAccount: string,
  afterStartup = '',
): string => `
import { createOperatingSystemCredential } from './src/device-master-key.js';
import { resolvePersonalRuntimePaths } from './src/personal-runtime.js';
import { runNodeEntry } from './src/run-node-entry.js';
import { createNodeStoredSecretCodec } from './src/stored-secrets.js';

await runNodeEntry({
  resolvePersonalRuntimePaths: () => resolvePersonalRuntimePaths({
    dataDir: ${JSON.stringify(dataRoot)},
    stableUserHome: ${JSON.stringify(dataRoot)},
  }),
  createNodeStoredSecretCodec: async (profile, db, creationLock, _credential, options) => {
    const credential = await createOperatingSystemCredential(
      ${JSON.stringify(credentialService)},
      ${JSON.stringify(credentialAccount)},
    );
    return await createNodeStoredSecretCodec(profile, db, creationLock, credential, options);
  },
});
${afterStartup}
`;

const forcePersonalFailure = (expected: PersonalFailurePhase | undefined, actual: PersonalFailurePhase): void => {
  if (expected === actual) throw new Error(`forced personal runtime ${actual} phase failure`);
};

const assertDashboardBootstrapAndControlPlane = async (
  origin: string,
  databasePath: string,
): Promise<void> => {
  const deadline = Date.now() + 10_000;
  let sessionToken: string | undefined;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      const session = database.prepare('SELECT id FROM sessions WHERE user_id = 1 ORDER BY created_at DESC LIMIT 1')
        .get() as { id?: unknown } | undefined;
      if (typeof session?.id === 'string') {
        sessionToken = session.id;
        break;
      }
    } finally {
      database.close();
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (sessionToken === undefined) {
    throw new Error('Installed Dashboard did not exchange its one-time bootstrap authority for an owner session');
  }

  const sessionResponse = await fetch(`${origin}/auth/me`, {
    headers: { origin, 'x-floway-session': sessionToken },
  });
  if (!sessionResponse.ok) {
    throw new Error(`Installed Dashboard owner session could not reach the personal control plane: ${sessionResponse.status}`);
  }
  if (sessionResponse.headers.get('access-control-allow-origin') !== origin) {
    throw new Error('Installed personal control plane did not bind CORS to the active Dashboard origin');
  }
  const session = await sessionResponse.json() as { user?: { id?: unknown }; viaApiKey?: unknown };
  if (session.user?.id !== 1 || session.viaApiKey !== false) {
    throw new Error(`Installed Dashboard bootstrap returned an unexpected owner session: ${JSON.stringify(session)}`);
  }

  const reusableLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: '', password: '' }),
  });
  if (reusableLogin.status !== 401) {
    throw new Error(`Installed personal runtime accepted reusable owner login with status ${reusableLogin.status}`);
  }
};

const waitForHealthyRuntime = async (
  child: CapturedChild,
  output: () => string,
  origin: string,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const health = await fetch(`${origin}/api/health`);
      if (health.ok) return;
    } catch { /* listener is still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Installed personal runtime did not become healthy\n${output()}`);
};

const assertPersonalRuntime = async (
  executable: string,
  embeddedNode: string,
  platformNode: string,
  entryPath: string,
  verificationRoot: string,
  options: {
    readonly forcedFailure?: PersonalFailurePhase;
    readonly port?: number;
    readonly seedPersistedPort?: boolean;
  } = {},
): Promise<void> => {
  const { forcedFailure, port = PERSONAL_DASHBOARD_PORT, seedPersistedPort = false } = options;
  const credentialService = `Floway desktop package verification ${randomUUID()}`;
  const credentialAccount = `device-master-key-${randomUUID()}`;
  const origin = `http://127.0.0.1:${port}`;

  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(verificationRoot, { recursive: true });
    cleanup.defer('isolated application data', async () => {
      await rm(verificationRoot, { force: true, recursive: true });
      await access(verificationRoot).then(
        () => { throw new Error(`Floway verification data remains at ${verificationRoot}`); },
        error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        },
      );
    });
    cleanup.defer('isolated operating-system credential', async () => {
      await runCredentialScript(embeddedNode, platformNode, credentialService, credentialAccount, 'delete');
    });
    cleanup.defer('loopback listener', async () => await assertLoopbackPortReleased(port));

    const runtimeStatePath = resolve(verificationRoot, 'runtime.json');
    const seededRuntimeState = `${JSON.stringify({ version: 1, port })}\n`;
    let seededRuntimeStateMtime: number | undefined;
    if (seedPersistedPort) {
      await writeFile(runtimeStatePath, seededRuntimeState);
      await utimes(runtimeStatePath, 1, 1);
      seededRuntimeStateMtime = (await stat(runtimeStatePath)).mtimeMs;
    }
    await writeFile(entryPath, personalEntrySource(verificationRoot, credentialService, credentialAccount));
    const { child, output } = captureApp(executable, appEnvironmentWithoutPortOverride());
    cleanup.defer('application and sidecar process group', async () => await terminateProcessGroup(child));
    forcePersonalFailure(forcedFailure, 'app');

    const sidecarPid = await waitForDirectChild(child);
    forcePersonalFailure(forcedFailure, 'sidecar');

    await waitForHealthyRuntime(child, output, origin);
    if (!output().includes(`Floway listening on ${origin}`)) {
      throw new Error(`Floway shell did not observe the effective personal endpoint ${origin}\n${output()}`);
    }
    forcePersonalFailure(forcedFailure, 'listener');

    const documentResponse = await fetch(origin);
    if (!documentResponse.ok) throw new Error(`Installed Dashboard document returned ${documentResponse.status}`);
    const document = await documentResponse.text();
    const assetPath = /(?:href|src)="(\/assets\/[^\"]+)"/.exec(document)?.[1];
    if (assetPath === undefined) throw new Error('Installed Dashboard document names no asset');
    const assetResponse = await fetch(`${origin}${assetPath}`);
    if (!assetResponse.ok) throw new Error(`Installed Dashboard asset returned ${assetResponse.status}`);
    await assertDashboardBootstrapAndControlPlane(origin, resolve(verificationRoot, 'floway.db'));
    forcePersonalFailure(forcedFailure, 'dashboard');

    const database = new DatabaseSync(resolve(verificationRoot, 'floway.db'), { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      const migration = database.prepare("SELECT name FROM _migrations WHERE name = '0084_protected_search_secret_columns.sql'").get();
      if (migration === undefined) throw new Error('Installed personal runtime did not apply the complete migration set');
    } finally {
      database.close();
    }
    forcePersonalFailure(forcedFailure, 'migration');

    await runCredentialScript(embeddedNode, platformNode, credentialService, credentialAccount, 'require');
    if (seedPersistedPort) {
      if (await readFile(runtimeStatePath, 'utf8') !== seededRuntimeState) {
        throw new Error(`Floway shell rewrote the persisted personal endpoint at ${runtimeStatePath}`);
      }
      if ((await stat(runtimeStatePath)).mtimeMs !== seededRuntimeStateMtime) {
        throw new Error(`Floway shell rewrote unchanged persisted runtime state at ${runtimeStatePath}`);
      }
    }
    forcePersonalFailure(forcedFailure, 'credential');
    if (child.pid === undefined) throw new Error('Floway production app process has no PID');
    process.kill(child.pid, TERMINATION_SIGNAL);
    await waitForOutput(child, output, ['Floway desktop terminated and waited for its personal runtime']);
    await waitForChildExit(child, 5_000);
    if (child.exitCode !== 0) {
      throw new Error(`Floway shell teardown exited with ${child.exitCode ?? child.signalCode}\n${output()}`);
    }
    await waitForProcessStopped(sidecarPid);
    await assertLoopbackPortReleased(port);
  });
};

const assertUnexpectedSidecarExitClosesShell = async (
  executable: string,
  embeddedNode: string,
  platformNode: string,
  entryPath: string,
  verificationRoot: string,
): Promise<void> => {
  const credentialService = `Floway desktop package verification ${randomUUID()}`;
  const credentialAccount = `device-master-key-${randomUUID()}`;
  const port = PERSONAL_DASHBOARD_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const parentFailure = 'forced packaged personal runtime failure';
  const originalCause = 'forced packaged personal runtime cause';

  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(verificationRoot, { recursive: true });
    cleanup.defer('unexpected-exit application data', async () => await rm(verificationRoot, { force: true, recursive: true }));
    cleanup.defer('unexpected-exit credential', async () => {
      await runCredentialScript(embeddedNode, platformNode, credentialService, credentialAccount, 'delete');
    });
    cleanup.defer('unexpected-exit listener', async () => await assertLoopbackPortReleased(port));
    await writeFile(entryPath, personalEntrySource(
      verificationRoot,
      credentialService,
      credentialAccount,
      `setTimeout(() => { throw new Error(${JSON.stringify(parentFailure)}, { cause: new Error(${JSON.stringify(originalCause)}) }); }, 1_500);`,
    ));
    const { child, output } = captureApp(executable, appEnvironmentWithoutPortOverride());
    cleanup.defer('unexpected-exit application process group', async () => await terminateProcessGroup(child));
    const sidecarPid = await waitForDirectChild(child);
    await waitForHealthyRuntime(child, output, origin);
    await waitForChildExit(child, 10_000);
    if (child.exitCode !== 1) {
      throw new Error(`Floway shell did not fail after its personal runtime exited: ${child.exitCode ?? child.signalCode}\n${output()}`);
    }
    const captured = output();
    for (const fragment of [
      parentFailure,
      originalCause,
      'Floway personal runtime exited unexpectedly',
    ]) {
      if (!captured.includes(fragment)) throw new Error(`Floway shell omitted ${JSON.stringify(fragment)}\n${captured}`);
    }
    await waitForProcessStopped(sidecarPid);
    await assertLoopbackPortReleased(port);
  });
};

const waitForOutput = async (
  child: CapturedChild,
  output: () => string,
  expectedFragments: readonly string[],
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = output();
    if (expectedFragments.every(fragment => captured.includes(fragment))) return captured;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Floway production app omitted ${JSON.stringify(expectedFragments)}\n${output()}`);
};

const observeProductionApp = async (
  executable: string,
  expectedFragments: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> => await withFailureSafeCleanup(async cleanup => {
  const { child, output } = captureApp(executable, environment);
  cleanup.defer('fault-probe application process group', async () => await terminateProcessGroup(child));
  await waitForOutput(child, output, expectedFragments);
  await waitForChildExit(child, 5_000);
  if (child.exitCode === 0) {
    throw new Error(`Floway production app unexpectedly succeeded after fault injection\n${output()}`);
  }
  return output();
});

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
  // Node's diagnostic report owns the loaded shared-library inventory used to
  // identify the binding selected by @napi-rs/keyring.
  // https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/doc/api/report.md#L434-L438
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
  ...nativeModules.map(path => assertSingleMachOArchitecture(path, expectedArchitecture)),
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
  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer('isolated installed application root', async () => await rm(isolatedRoot, { force: true, recursive: true }));
    const installedApp = resolve(isolatedRoot, 'Applications/Floway One.app');
    await mkdir(dirname(installedApp), { recursive: true });
    await rename(appRoot, installedApp);
    const installedExecutable = resolve(installedApp, 'Contents/MacOS/floway-one');
    const installedNode = resolve(installedApp, 'Contents/MacOS/floway-node');
    const installedPlatformNode = resolve(installedApp, 'Contents/Resources/runtime/apps/platform-node');
    const installedEntry = resolve(installedPlatformNode, 'entry.js');
    const installedKeyringNative = resolve(installedApp, relative(appRoot, loadedKeyringNative!));
    const productionEntry = await readFile(installedEntry, 'utf8');
    cleanup.defer('production runtime entry restoration', async () => await writeFile(installedEntry, productionEntry));

    const customPort = await reserveNonDefaultLoopbackPort();
    await assertPersonalRuntime(
      installedExecutable,
      installedNode,
      installedPlatformNode,
      installedEntry,
      resolve(isolatedRoot, 'PersonalData-persisted-port'),
      { port: customPort, seedPersistedPort: true },
    );
    console.log(`Floway production app preserved and loaded persisted personal endpoint http://127.0.0.1:${customPort}`);

    await assertPersonalRuntime(
      installedExecutable,
      installedNode,
      installedPlatformNode,
      installedEntry,
      resolve(isolatedRoot, 'PersonalData-success'),
    );
    console.log('Floway production app completed personal migrations, Dashboard bootstrap exchange, authenticated control plane, health, assets, credential, and failure-safe cleanup');

    await assertUnexpectedSidecarExitClosesShell(
      installedExecutable,
      installedNode,
      installedPlatformNode,
      installedEntry,
      resolve(isolatedRoot, 'PersonalData-unexpected-sidecar-exit'),
    );
    console.log('Floway production shell surfaced the original sidecar failure, exited non-zero, and left no listener or process');

    for (const phase of PERSONAL_FAILURE_PHASES) {
      const verificationRoot = resolve(isolatedRoot, `PersonalData-fault-${phase}`);
      try {
        await assertPersonalRuntime(
          installedExecutable,
          installedNode,
          installedPlatformNode,
          installedEntry,
          verificationRoot,
          { forcedFailure: phase },
        );
        throw new Error(`Expected forced personal runtime ${phase} phase failure`);
      } catch (error) {
        if (!errorChainIncludes(error, `forced personal runtime ${phase} phase failure`)) throw error;
      }
      console.log(`Floway personal ${phase} fault left no app, sidecar, listener, credential, or data root`);
    }

    await writeFile(installedEntry, productionEntry);
    const missingEntry = `${installedEntry}.missing`;
    await withFailureSafeCleanup(async faultCleanup => {
      await rename(installedEntry, missingEntry);
      faultCleanup.defer('missing-entry fault restoration', async () => await rename(missingEntry, installedEntry));
      await observeProductionApp(installedExecutable, ['Floway desktop runtime resource is unavailable', 'entry.js']);
    });

    await writeFile(installedEntry, 'setInterval(() => {}, 60_000);\n');
    const blockingFailure = new Error('forced verifier failure with live packaged sidecar');
    try {
      await withFailureSafeCleanup(async blockingCleanup => {
        const { child } = captureApp(installedExecutable, process.env);
        blockingCleanup.defer('blocking application process group', async () => await terminateProcessGroup(child));
        const sidecarPid = await waitForDirectChild(child);
        if (!processIsRunning(sidecarPid)) throw new Error('Packaged blocking sidecar did not reach a live state');
        throw blockingFailure;
      });
    } catch (error) {
      if (!errorChainIncludes(error, blockingFailure.message)) throw error;
    }
    console.log('Floway forced parent failure terminated its live packaged sidecar and process group');

    await withFailureSafeCleanup(async faultCleanup => {
      const verificationRoot = resolve(isolatedRoot, 'PersonalData-keyring-fault');
      const credentialService = `Floway desktop package verification ${randomUUID()}`;
      const credentialAccount = `device-master-key-${randomUUID()}`;
      const port = PERSONAL_DASHBOARD_PORT;
      await assertLoopbackPortReleased(port);
      await mkdir(verificationRoot, { recursive: true });
      faultCleanup.defer('Keyring-fault application data', async () => await rm(verificationRoot, { force: true, recursive: true }));
      faultCleanup.defer('Keyring-fault listener', async () => await assertLoopbackPortReleased(port));
      await writeFile(installedEntry, personalEntrySource(verificationRoot, credentialService, credentialAccount));
      const keyringFile = await open(installedKeyringNative, 'r+');
      faultCleanup.defer('exact loaded Keyring binding file handle', async () => await keyringFile.close());
      const originalKeyringHeader = Buffer.alloc(8);
      await keyringFile.read(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
      faultCleanup.defer('exact loaded Keyring binding restoration', async () => {
        await keyringFile.write(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
        await keyringFile.sync();
      });
      await keyringFile.write(Buffer.alloc(originalKeyringHeader.byteLength), 0, originalKeyringHeader.byteLength, 0);
      await keyringFile.sync();
      const { child, output } = captureApp(installedExecutable, appEnvironmentWithoutPortOverride());
      faultCleanup.defer('Keyring-fault application process group', async () => await terminateProcessGroup(child));
      await waitForOutput(child, output, ['Floway runtime exit']);
    });
    console.log(`Floway corrupted the exact loaded Keyring binding and observed packaged sidecar failure: ${installedKeyringNative}`);

    await writeFile(installedEntry, productionEntry);
    await withFailureSafeCleanup(async faultCleanup => {
      const nodeFile = await open(installedNode, 'r+');
      faultCleanup.defer('wrong-architecture sidecar file handle', async () => await nodeFile.close());
      const originalCpuType = Buffer.alloc(4);
      await nodeFile.read(originalCpuType, 0, 4, 4);
      faultCleanup.defer('wrong-architecture sidecar restoration', async () => {
        await nodeFile.write(originalCpuType, 0, 4, 4);
        await nodeFile.sync();
      });
      const wrongArchitecture: MachOArchitecture = expectedArchitecture === 'arm64' ? 'x64' : 'arm64';
      const replacement = Buffer.alloc(4);
      replacement.writeUInt32LE(machOCpuTypeForArchitecture(wrongArchitecture));
      await nodeFile.write(replacement, 0, 4, 4);
      await nodeFile.sync();
      // XNU owns EBADARCH's stable status, and Libc owns its exact wording as
      // emitted by the failed sidecar spawn.
      // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/errno.h#L226-L230
      // https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/errlst.c#L165-L168
      await observeProductionApp(installedExecutable, ['Bad CPU type in executable (os error 86)']);
    });
  });
}

console.log(
  launchSupported
    ? `Packaged Floway desktop app ${targetTriple} verified thin architecture, embedded Node/Keyring/gateway, locked dependencies, production app launch/fault chains, failure-safe cleanup, migrations, secure Dashboard bootstrap/control-plane, native sharp, and assets`
    : `Packaged Floway desktop app ${targetTriple} passed static thin architecture, locked-dependency, migration, native-module, and Dashboard verification; this host cannot execute that target`,
);
