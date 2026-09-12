import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { type InstalledAppVerificationContext, writeContractedEntry } from './installed-app.ts';
import { assertNativeFailureSurface } from './native-surface.ts';
import {
  appEnvironmentWithoutPortOverride,
  assertBoundedSidecarLogs,
  assertNoDirectChildren,
  assertLoopbackPortReleased,
  captureApp,
  PERSONAL_DASHBOARD_PORT,
  processIsRunning,
  requestNormalApplicationExit,
  terminateProcessGroup,
  type CapturedChild,
  waitForChildExit,
  waitForDirectChild,
  waitForOutput,
  waitForProcessStopped,
} from './process-lifecycle.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

const execFileAsync = promisify(execFile);
const DASHBOARD_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DASHBOARD_BOOTSTRAP_POLL_INTERVAL_MS = 50;
const DASHBOARD_PAGE_LOAD_EVENT_PREFIX = 'FLOWAY_DESKTOP_PAGE_LOAD ';
const DASHBOARD_BOOTSTRAP_COMPLETED = 'FLOWAY_DASHBOARD_BOOTSTRAP {"phase":"completed"}';
const DASHBOARD_BOOTSTRAP_FAILED = 'FLOWAY_DASHBOARD_BOOTSTRAP {"phase":"failed"}';
const DASHBOARD_BOOTSTRAP_REJECTED = 'FLOWAY_DASHBOARD_BOOTSTRAP {"phase":"rejected"}';

export type PersonalFailurePhase = 'app' | 'sidecar' | 'listener' | 'dashboard' | 'migration' | 'credential';

export interface CredentialIdentity {
  readonly account: string;
  readonly service: string;
}

export const PERSONAL_FAILURE_PHASES: readonly PersonalFailurePhase[] = [
  'app',
  'sidecar',
  'listener',
  'dashboard',
  'migration',
  'credential',
];

export const errorChainIncludes = (error: unknown, fragment: string): boolean => {
  if (!(error instanceof Error)) return String(error).includes(fragment);
  if (error.message.includes(fragment)) return true;
  if (error instanceof AggregateError && error.errors.some(item => errorChainIncludes(item, fragment))) return true;
  return error.cause === undefined ? false : errorChainIncludes(error.cause, fragment);
};

const credentialScript = (identity: CredentialIdentity, action: 'delete' | 'require'): string => `
const { Entry } = await import('@napi-rs/keyring');
const entry = new Entry(${JSON.stringify(identity.service)}, ${JSON.stringify(identity.account)});
${action === 'delete' ? 'entry.deleteCredential();' : ''}
const secret = entry.getSecret();
if (${action === 'delete' ? 'secret !== null' : 'secret === null'}) {
  throw new Error(${JSON.stringify(action === 'delete'
    ? 'isolated verification credential remains'
    : 'isolated verification credential was not created')});
}
`;

export const runCredentialScript = async (
  context: InstalledAppVerificationContext,
  identity: CredentialIdentity,
  action: 'delete' | 'require',
): Promise<void> => {
  await execFileAsync(context.node, ['--input-type=module', '--eval', credentialScript(identity, action)], {
    cwd: context.platformNode,
    timeout: 10_000,
  });
};

export const personalEntrySource = (
  dataRoot: string,
  credentialIdentity: CredentialIdentity,
  afterStartup = '',
): string => `
import { createOperatingSystemCredential } from './src/device-master-key.js';
import { resolvePersonalRuntimePaths } from './src/personal-runtime.js';
import { runNodeEntry } from './src/run-node-entry.js';
import { reportDesktopStartupFailure } from './src/startup-failure.js';
import { createNodeStoredSecretCodec } from './src/stored-secrets.js';

try {
  await runNodeEntry({
    resolvePersonalRuntimePaths: () => resolvePersonalRuntimePaths({
      dataDir: ${JSON.stringify(dataRoot)},
      stableUserHome: ${JSON.stringify(dataRoot)},
    }),
    createNodeStoredSecretCodec: async (profile, db, creationLock, _credential, options) => {
      const credential = await createOperatingSystemCredential(
        ${JSON.stringify(credentialIdentity)},
      );
      return await createNodeStoredSecretCodec(profile, db, creationLock, credential, options);
    },
  });
} catch (failure) {
  reportDesktopStartupFailure(failure, 'native-dependency');
  throw failure;
}
${afterStartup}
`;

const forcePersonalFailure = (expected: PersonalFailurePhase | undefined, actual: PersonalFailurePhase): void => {
  if (expected === actual) throw new Error(`forced personal runtime ${actual} phase failure`);
};

export const waitForDashboardBootstrapSession = async (
  readOutput: () => string,
  readSessionToken: () => string | undefined,
  options: {
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly timeoutMs?: number;
  } = {},
): Promise<string> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
  });
  const timeoutMs = options.timeoutMs ?? DASHBOARD_BOOTSTRAP_TIMEOUT_MS;
  let deadline = now() + timeoutMs;
  let documentLoaded = false;
  while (now() < deadline) {
    const captured = readOutput();
    if (captured.includes(DASHBOARD_BOOTSTRAP_FAILED) || captured.includes(DASHBOARD_BOOTSTRAP_REJECTED)) {
      throw new Error(`Installed Dashboard bootstrap request failed\n${captured}`);
    }
    if (!documentLoaded) {
      documentLoaded = captured.split('\n').some(line => {
        if (!line.startsWith(DASHBOARD_PAGE_LOAD_EVENT_PREFIX)) return false;
        try {
          const event = JSON.parse(line.slice(DASHBOARD_PAGE_LOAD_EVENT_PREFIX.length)) as {
            bootstrapAuthority?: unknown;
            event?: unknown;
            surface?: unknown;
          };
          return event.bootstrapAuthority === true
            && event.event === 'finished'
            && event.surface === 'dashboard';
        } catch {
          return false;
        }
      });
      if (documentLoaded) deadline = now() + timeoutMs;
    }
    if (documentLoaded && captured.includes(DASHBOARD_BOOTSTRAP_COMPLETED)) {
      const token = readSessionToken();
      if (token !== undefined) return token;
      throw new Error(`Installed Dashboard reported bootstrap completion without a durable owner session\n${captured}`);
    }
    await sleep(Math.min(DASHBOARD_BOOTSTRAP_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
  const stage = documentLoaded
    ? 'did not complete its one-time bootstrap exchange after the document loaded'
    : 'did not finish loading its bootstrap document';
  throw new Error(`Installed Dashboard ${stage}\n${readOutput()}`);
};

const assertDashboardBootstrapAndControlPlane = async (
  output: () => string,
  origin: string,
  databasePath: string,
): Promise<void> => {
  const sessionToken = await waitForDashboardBootstrapSession(output, () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      const session = database.prepare('SELECT id FROM sessions WHERE user_id = 1 ORDER BY created_at DESC LIMIT 1')
        .get() as { id?: unknown } | undefined;
      return typeof session?.id === 'string' ? session.id : undefined;
    } finally {
      database.close();
    }
  });

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

export const assertPersonalRuntime = async (
  context: InstalledAppVerificationContext,
  verificationRoot: string,
  options: {
    readonly forcedFailure?: PersonalFailurePhase;
    readonly port?: number;
    readonly requestApplicationExit?: boolean;
    readonly seedPersistedPort?: boolean;
  } = {},
): Promise<void> => {
  const {
    forcedFailure,
    port = PERSONAL_DASHBOARD_PORT,
    requestApplicationExit = false,
    seedPersistedPort = false,
  } = options;
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
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
      await runCredentialScript(context, credentialIdentity, 'delete');
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
    await writeContractedEntry(context, personalEntrySource(
      verificationRoot,
      credentialIdentity,
    ));
    const { child, output } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', verificationRoot],
    );
    cleanup.defer('application and sidecar process group', async () => await terminateProcessGroup(child));
    forcePersonalFailure(forcedFailure, 'app');

    const sidecarPid = await waitForDirectChild(child, output);
    forcePersonalFailure(forcedFailure, 'sidecar');
    await waitForHealthyRuntime(child, output, origin);
    if (!output().includes(`Floway listening on ${origin}`)) {
      throw new Error(`Floway shell did not observe the effective personal endpoint ${origin}\n${output()}`);
    }
    forcePersonalFailure(forcedFailure, 'listener');

    const documentResponse = await fetch(origin);
    if (!documentResponse.ok) throw new Error(`Installed Dashboard document returned ${documentResponse.status}`);
    const document = await documentResponse.text();
    const assetPath = /(?:href|src)="(\/assets\/[^"]+)"/.exec(document)?.[1];
    if (assetPath === undefined) throw new Error('Installed Dashboard document names no asset');
    const assetResponse = await fetch(`${origin}${assetPath}`);
    if (!assetResponse.ok) throw new Error(`Installed Dashboard asset returned ${assetResponse.status}`);
    forcePersonalFailure(forcedFailure, 'dashboard');
    await assertDashboardBootstrapAndControlPlane(output, origin, resolve(verificationRoot, 'floway.db'));

    const database = new DatabaseSync(resolve(verificationRoot, 'floway.db'), { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      const applied = (database.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name?: unknown }>)
        .map(row => String(row.name));
      if (JSON.stringify(applied) !== JSON.stringify(context.migrationNames)) {
        throw new Error(`Installed personal runtime applied ${JSON.stringify(applied)} instead of the complete migration contract ${JSON.stringify(context.migrationNames)}`);
      }
    } finally {
      database.close();
    }
    forcePersonalFailure(forcedFailure, 'migration');

    await runCredentialScript(context, credentialIdentity, 'require');
    if (seedPersistedPort) {
      if (await readFile(runtimeStatePath, 'utf8') !== seededRuntimeState) {
        throw new Error(`Floway shell rewrote the persisted personal endpoint at ${runtimeStatePath}`);
      }
      if ((await stat(runtimeStatePath)).mtimeMs !== seededRuntimeStateMtime) {
        throw new Error(`Floway shell rewrote unchanged persisted runtime state at ${runtimeStatePath}`);
      }
    }
    forcePersonalFailure(forcedFailure, 'credential');
    if (requestApplicationExit) {
      await requestNormalApplicationExit(context.appRoot);
      await waitForOutput(child, output, ['Floway desktop stopped and waited for its packaged runtime']);
      await waitForChildExit(child, 10_000);
      if (child.exitCode !== 0) {
        throw new Error(`Floway normal application exit returned ${child.exitCode ?? child.signalCode}\n${output()}`);
      }
      await waitForProcessStopped(sidecarPid);
      await assertLoopbackPortReleased(port);
    }
  });
};

export const assertUnexpectedSidecarExitSurfacesFailure = async (
  nativeWindowProbe: string,
  context: InstalledAppVerificationContext,
  verificationRoot: string,
): Promise<void> => {
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const port = PERSONAL_DASHBOARD_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const parentFailure = 'forced packaged personal runtime failure';
  const originalCause = 'forced packaged personal runtime cause';

  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(verificationRoot, { recursive: true });
    cleanup.defer('unexpected-exit application data', async () => await rm(verificationRoot, { force: true, recursive: true }));
    cleanup.defer('unexpected-exit credential', async () => await runCredentialScript(context, credentialIdentity, 'delete'));
    cleanup.defer('unexpected-exit listener', async () => await assertLoopbackPortReleased(port));
    await writeContractedEntry(context, personalEntrySource(
      verificationRoot,
      credentialIdentity,
      `setTimeout(() => { throw new Error(${JSON.stringify(parentFailure)}, { cause: new Error(${JSON.stringify(originalCause)}) }); }, 1_500);`,
    ));
    const { child, output } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', verificationRoot],
    );
    cleanup.defer('unexpected-exit application process group', async () => await terminateProcessGroup(child));
    const sidecarPid = await waitForDirectChild(child, output);
    await waitForHealthyRuntime(child, output, origin);
    const expected = [
      parentFailure,
      originalCause,
      'Floway packaged runtime exited unexpectedly',
      'Floway desktop runtime state: failed kind=unexpected-exit',
      'FLOWAY_DESKTOP_SURFACE ',
      'FLOWAY_DESKTOP_RECOVERY_SURFACE ',
      '"restartEnabled":true',
    ];
    const captured = await waitForOutput(child, output, expected);
    if (child.pid === undefined || !processIsRunning(child.pid)) {
      throw new Error(`Floway shell did not remain available after its runtime exited\n${captured}`);
    }
    for (const fragment of expected) {
      if (!captured.includes(fragment)) throw new Error(`Floway shell omitted ${JSON.stringify(fragment)}\n${captured}`);
    }
    await waitForProcessStopped(sidecarPid);
    if (child.pid === undefined) throw new Error('Floway production app process has no PID');
    await assertNativeFailureSurface(nativeWindowProbe, child.pid, captured, {
      dataRoot: verificationRoot,
      failureKind: 'unexpected-exit',
      forbiddenSnapshotText: [parentFailure, originalCause],
    });
    await assertBoundedSidecarLogs(verificationRoot, [
      parentFailure,
      originalCause,
      'FLOWAY_DESKTOP_RECOVERY_SURFACE ',
    ]);
    await assertNoDirectChildren(child.pid);
    await assertLoopbackPortReleased(port);
    await terminateProcessGroup(child);
  });
};
