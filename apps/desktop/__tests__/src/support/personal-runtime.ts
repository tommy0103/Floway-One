import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import type { InstalledAppVerificationContext } from './installed-app.ts';
import {
  appEnvironmentWithoutPortOverride,
  assertLoopbackPortReleased,
  captureApp,
  PERSONAL_DASHBOARD_PORT,
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
import { createNodeStoredSecretCodec } from './src/stored-secrets.js';

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
    await writeFile(context.entry, personalEntrySource(
      verificationRoot,
      credentialIdentity,
    ));
    const { child, output } = captureApp(context.executable, appEnvironmentWithoutPortOverride());
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
    const assetPath = /(?:href|src)="(\/assets\/[^"]+)"/.exec(document)?.[1];
    if (assetPath === undefined) throw new Error('Installed Dashboard document names no asset');
    const assetResponse = await fetch(`${origin}${assetPath}`);
    if (!assetResponse.ok) throw new Error(`Installed Dashboard asset returned ${assetResponse.status}`);
    await assertDashboardBootstrapAndControlPlane(origin, resolve(verificationRoot, 'floway.db'));
    forcePersonalFailure(forcedFailure, 'dashboard');

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

export const assertUnexpectedSidecarExitClosesShell = async (
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
    await writeFile(context.entry, personalEntrySource(
      verificationRoot,
      credentialIdentity,
      `setTimeout(() => { throw new Error(${JSON.stringify(parentFailure)}, { cause: new Error(${JSON.stringify(originalCause)}) }); }, 1_500);`,
    ));
    const { child, output } = captureApp(context.executable, appEnvironmentWithoutPortOverride());
    cleanup.defer('unexpected-exit application process group', async () => await terminateProcessGroup(child));
    const sidecarPid = await waitForDirectChild(child);
    await waitForHealthyRuntime(child, output, origin);
    await waitForChildExit(child, 10_000);
    if (child.exitCode !== 1) {
      throw new Error(`Floway shell did not fail after its personal runtime exited: ${child.exitCode ?? child.signalCode}\n${output()}`);
    }
    const captured = output();
    for (const fragment of [parentFailure, originalCause, 'Floway packaged runtime exited unexpectedly']) {
      if (!captured.includes(fragment)) throw new Error(`Floway shell omitted ${JSON.stringify(fragment)}\n${captured}`);
    }
    await waitForProcessStopped(sidecarPid);
    await assertLoopbackPortReleased(port);
  });
};
