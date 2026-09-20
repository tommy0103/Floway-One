import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type InstalledAppVerificationContext, writeContractedEntry } from './installed-app.ts';
import { assertTraySnapshot, labels, type TraySnapshot } from './native-surface.ts';
import {
  type CredentialIdentity,
  personalEntrySource,
  runCredentialScript,
  SLOW_VERIFY_RESPONSE,
  SLOW_VERIFY_ROUTE,
  waitForDashboardBootstrapSession,
  waitForHealthyRuntime,
} from './personal-runtime.ts';
import {
  appEnvironmentWithoutPortOverride,
  assertBoundedSidecarLogs,
  assertLoopbackPortReleased,
  captureApp,
  directChildPids,
  forceKillProcess,
  PERSONAL_DASHBOARD_PORT,
  processIsRunning,
  sendDesktopControl,
  terminateProcessGroup,
  type CapturedChild,
  waitForChildExit,
  waitForDirectChild,
  waitForProcessStopped,
  waitForWindowVisibility,
} from './process-lifecycle.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// launchctl ships at /bin/launchctl on macOS; /usr/bin/launchctl does not exist.
// https://keith.github.io/xcode-man-pages/launchctl.1.html
const LAUNCHCTL = '/bin/launchctl';
// https://keith.github.io/xcode-man-pages/pgrep.1.html
const PGREP = '/usr/bin/pgrep';
// https://keith.github.io/xcode-man-pages/pbpaste.1.html
const PBPASTE = '/usr/bin/pbpaste';

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
};

const currentUid = (): number => {
  if (process.getuid === undefined) {
    throw new Error('Floway login item verification requires a POSIX user id');
  }
  return process.getuid();
};

interface ShellStatusSnapshot {
  readonly autostartEnabled: boolean;
  readonly gatewayOrigin: string | null;
  readonly phase: string;
  readonly tray: TraySnapshot;
  readonly window: {
    readonly title: string;
    readonly visible: boolean;
  };
}

const reportShellStatus = async (
  context: InstalledAppVerificationContext,
  applicationHome: string,
): Promise<ShellStatusSnapshot> => {
  const reply = await sendDesktopControl(context.executable, applicationHome, 'report-status');
  const status = reply.status as Partial<ShellStatusSnapshot> | undefined;
  if (
    status === undefined
    || typeof status.phase !== 'string'
    || typeof status.tray !== 'object'
    || status.tray === null
    || typeof status.window !== 'object'
    || status.window === null
  ) {
    throw new Error(`Floway shell status reply is malformed: ${JSON.stringify(reply)}`);
  }
  return status as ShellStatusSnapshot;
};

const assertReadyShellStatus = (
  status: ShellStatusSnapshot,
  origin: string,
  expected: { readonly autostartEnabled: boolean; readonly windowVisible: boolean },
): void => {
  if (status.phase !== 'ready' || status.gatewayOrigin !== origin) {
    throw new Error(`Floway shell status is not ready at ${origin}: ${JSON.stringify(status)}`);
  }
  if (status.window.title !== 'Floway' || status.window.visible !== expected.windowVisible) {
    throw new Error(`Floway shell window state diverged: ${JSON.stringify(status.window)}`);
  }
  if (status.autostartEnabled !== expected.autostartEnabled) {
    throw new Error(`Floway shell autostart state diverged: ${JSON.stringify(status)}`);
  }
  assertTraySnapshot(status.tray, {
    autostartChecked: expected.autostartEnabled,
    copyAddressEnabled: true,
    locale: 'en',
    logsEnabled: true,
    restartEnabled: true,
    statusText: `${labels.en.statusReady} — ${origin}`,
  });
};

export const readLoginItemLabel = async (): Promise<string> => {
  const configuration = JSON.parse(
    await readFile(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
  ) as { identifier?: unknown };
  if (typeof configuration.identifier !== 'string' || configuration.identifier.length === 0) {
    throw new Error('Floway desktop bundle identifier is unavailable for login item verification');
  }
  return configuration.identifier;
};

const loginItemPlistPath = (label: string): string =>
  resolve(homedir(), `Library/LaunchAgents/${label}.plist`);

interface LoginItemCapture {
  readonly plist: string | null;
  readonly plistPath: string;
}

// The login item is per-app global state, so the verifier parks any
// pre-existing operator registration for the duration of the run and restores
// it exactly on every exit path.
export const captureLoginItem = async (label: string): Promise<LoginItemCapture> => {
  const plistPath = loginItemPlistPath(label);
  let plist: string | null = null;
  try {
    plist = await readFile(plistPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (plist !== null) {
    await execFileAsync(LAUNCHCTL, [
      'bootout',
      `gui/${currentUid()}/${label}`,
    ]).catch(() => {});
    await rm(plistPath);
  }
  return { plist, plistPath };
};

export const restoreLoginItem = async (capture: LoginItemCapture, label: string): Promise<void> => {
  // Unload whatever the run left behind before restoring the captured state,
  // so a mid-scenario registration can never linger or mix with the restored
  // one.
  await execFileAsync(LAUNCHCTL, [
    'bootout',
    `gui/${currentUid()}/${label}`,
  ]).catch(() => {});
  if (capture.plist === null) {
    await rm(capture.plistPath, { force: true });
    return;
  }
  await writeFile(capture.plistPath, capture.plist);
  await execFileAsync(LAUNCHCTL, [
    'bootstrap',
    `gui/${currentUid()}`,
    capture.plistPath,
  ]);
};

const waitForReplacementSidecar = async (
  parent: CapturedChild,
  previousPid: number,
  output: () => string,
): Promise<number> => {
  if (parent.pid === undefined) throw new Error('Floway production app process has no PID');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && parent.exitCode === null && parent.signalCode === null) {
    const replacement = (await directChildPids(parent.pid)).find(pid => pid !== previousPid);
    if (replacement !== undefined) return replacement;
    await sleep(25);
  }
  throw new Error(`Floway production app did not start a replacement sidecar\n${output()}`);
};

const shellProcessPids = async (executable: string): Promise<number[]> => {
  const { stdout } = await execFileAsync(PGREP, ['-x', basename(executable)])
    .catch(() => ({ stdout: '', stderr: '' }));
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
};

interface LoginItemJobState {
  readonly lastExitCode: string | null;
  readonly runs: number;
  readonly state: string;
}

const readLoginItemJobState = async (label: string): Promise<LoginItemJobState> => {
  const { stdout } = await execFileAsync(LAUNCHCTL, ['print', `gui/${currentUid()}/${label}`], { timeout: 10_000 });
  const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim();
  const runs = /^\s*runs = (\d+)$/m.exec(stdout)?.[1];
  const lastExitCode = /^\s*last exit code = (.+)$/m.exec(stdout)?.[1]?.trim();
  if (state === undefined || runs === undefined) {
    throw new Error(`Floway login item launchd state is unreadable: ${stdout}`);
  }
  return { lastExitCode: lastExitCode ?? null, runs: Number(runs), state };
};

const waitForLoginItemDelegateRun = async (label: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let observed = 'the job was never loaded';
  while (Date.now() < deadline) {
    const job = await readLoginItemJobState(label).catch(() => null);
    if (job !== null) {
      observed = `state=${job.state} runs=${job.runs} lastExitCode=${job.lastExitCode ?? 'none'}`;
      if (job.runs >= 1 && job.state === 'not running' && job.lastExitCode === '0') return;
    }
    await sleep(100);
  }
  throw new Error(`Floway login item delegate did not complete its launchd run: ${observed}`);
};

const readOwnerSessionToken = (databasePath: string) => (): string | undefined => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const session = database.prepare('SELECT id FROM sessions WHERE user_id = 1 ORDER BY created_at DESC LIMIT 1')
      .get() as { id?: unknown } | undefined;
    return typeof session?.id === 'string' ? session.id : undefined;
  } finally {
    database.close();
  }
};

export const assertDesktopShellLifecycle = async (
  nativeWindowProbe: string,
  context: InstalledAppVerificationContext,
  isolatedRoot: string,
): Promise<void> => {
  const applicationHome = resolve(isolatedRoot, 'PersonalData-shell-lifecycle');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const port = PERSONAL_DASHBOARD_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const label = await readLoginItemLabel();

  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(applicationHome, { recursive: true });
    cleanup.defer('shell lifecycle application data', async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer('shell lifecycle credential', async () => await runCredentialScript(context, credentialIdentity, 'delete'));
    cleanup.defer('shell lifecycle listener', async () => await assertLoopbackPortReleased(port));
    await writeContractedEntry(context, personalEntrySource(
      applicationHome,
      credentialIdentity,
      '',
      { slowVerifyRoute: true },
    ));
    const { child, output } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', applicationHome],
    );
    cleanup.defer('shell lifecycle application process group', async () => await terminateProcessGroup(child));
    const sidecarPid = await waitForDirectChild(child, output);
    await waitForHealthyRuntime(child, output, origin);
    const sessionToken = await waitForDashboardBootstrapSession(
      output,
      readOwnerSessionToken(resolve(applicationHome, 'floway.db')),
    );
    if (child.pid === undefined) throw new Error('Floway production app process has no PID');
    const shellPid = child.pid;

    const baseline = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(baseline, origin, { autostartEnabled: false, windowVisible: true });
    await waitForWindowVisibility(nativeWindowProbe, shellPid, true);
    console.log('Floway shell status exposed the full tray contract with a visible window and the running Gateway address');

    // Closing the window hides it while an in-flight Gateway request and the
    // authenticated control plane continue uninterrupted.
    const slowResponsePromise = fetch(`${origin}${SLOW_VERIFY_ROUTE}`).then(async response => {
      if (!response.ok) throw new Error(`Floway slow verifier route returned ${response.status}`);
      return await response.text();
    });
    await sleep(250);
    await sendDesktopControl(context.executable, applicationHome, 'close-window');
    await waitForWindowVisibility(nativeWindowProbe, shellPid, false);
    if (await slowResponsePromise !== SLOW_VERIFY_RESPONSE) {
      throw new Error('Floway slow verifier response changed across the window hide');
    }
    const hiddenHealth = await fetch(`${origin}/api/health`);
    if (!hiddenHealth.ok) throw new Error(`Floway health returned ${hiddenHealth.status} while hidden`);
    const hiddenSession = await fetch(`${origin}/auth/me`, {
      headers: { origin, 'x-floway-session': sessionToken },
    });
    if (!hiddenSession.ok) {
      throw new Error(`Floway owner session returned ${hiddenSession.status} while hidden`);
    }
    if (!processIsRunning(sidecarPid)) {
      throw new Error('Floway sidecar died while its window was hidden');
    }
    const hidden = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(hidden, origin, { autostartEnabled: false, windowVisible: false });
    console.log('Floway window hide kept the in-flight request, health, and owner session live with the sidecar unchanged');

    // A repeated application launch activates the existing instance and must
    // not start another gateway.
    const delegation = await execFileAsync(
      context.executable,
      ['--data-dir', applicationHome],
      { env: appEnvironmentWithoutPortOverride(), timeout: 30_000 },
    );
    if (!delegation.stderr.includes('Floway desktop is already running; activated the existing instance')) {
      throw new Error(`Floway repeated launch did not delegate to its owner\n${delegation.stdout}\n${delegation.stderr}`);
    }
    await waitForWindowVisibility(nativeWindowProbe, shellPid, true);
    const ownedChildren = await directChildPids(shellPid);
    if (ownedChildren.length !== 1 || ownedChildren[0] !== sidecarPid || !processIsRunning(sidecarPid)) {
      throw new Error(`Floway repeated launch changed its gateway ownership: ${ownedChildren.join(', ')}`);
    }
    const restored = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(restored, origin, { autostartEnabled: false, windowVisible: true });
    console.log('Floway repeated launch delegated activation to the running instance and started no second gateway');

    await sendDesktopControl(context.executable, applicationHome, 'copy-gateway-address');
    const { stdout: pasted } = await execFileAsync(PBPASTE, [], { timeout: 10_000 });
    if (pasted !== origin) {
      throw new Error(`Floway clipboard held ${JSON.stringify(pasted)} instead of ${origin}`);
    }
    console.log('Floway tray copied the Gateway address to the system pasteboard');

    await sendDesktopControl(context.executable, applicationHome, 'restart-gateway');
    await waitForProcessStopped(sidecarPid);
    const restartedSidecarPid = await waitForReplacementSidecar(child, sidecarPid, output);
    await waitForHealthyRuntime(child, output, origin);
    const restarted = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(restarted, origin, { autostartEnabled: false, windowVisible: true });
    const slowAfterRestart = await fetch(`${origin}${SLOW_VERIFY_ROUTE}`);
    if (!slowAfterRestart.ok || await slowAfterRestart.text() !== SLOW_VERIFY_RESPONSE) {
      throw new Error('Floway slow verifier route did not survive the Gateway restart');
    }
    console.log('Floway tray restart gracefully replaced the sidecar and restored the ready Gateway');

    await sendDesktopControl(context.executable, applicationHome, 'autostart-on');
    const plist = await readFile(loginItemPlistPath(label), 'utf8');
    for (const fragment of [label, context.executable, '--data-dir', applicationHome, '<key>RunAtLoad</key>', '<true/>']) {
      if (!plist.includes(fragment)) {
        throw new Error(`Floway login item plist omitted ${JSON.stringify(fragment)}`);
      }
    }
    await execFileAsync(LAUNCHCTL, ['print', `gui/${currentUid()}/${label}`], { timeout: 10_000 });
    const autostartEnabled = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(autostartEnabled, origin, { autostartEnabled: true, windowVisible: true });
    // The registration carries RunAtLoad, so launchd spawns the login item
    // delegate the moment the job loads. The delegate finds the live owner,
    // activates it, and exits — a path that returns before any window exists
    // and therefore completes well inside any process-sampling interval, so
    // observe launchd's own job accounting instead of racing pgrep. A
    // completed run with exit code 0 is only reachable through a successful
    // delegation: an owning launch never exits and every failure path exits 1.
    await waitForLoginItemDelegateRun(label, 30_000);
    const shellPidsAfterAutostart = await shellProcessPids(context.executable);
    if (shellPidsAfterAutostart.length !== 1 || shellPidsAfterAutostart[0] !== shellPid) {
      throw new Error(`Floway login item delegate left extra shell processes: ${shellPidsAfterAutostart.join(', ')}`);
    }
    const childrenAfterAutostart = await directChildPids(shellPid);
    if (childrenAfterAutostart.length !== 1 || childrenAfterAutostart[0] !== restartedSidecarPid) {
      throw new Error(`Floway login item delegate changed gateway ownership: ${childrenAfterAutostart.join(', ')}`);
    }
    console.log('Floway launch-at-login registered with launchd and its delegate exited without a second gateway');

    await sendDesktopControl(context.executable, applicationHome, 'autostart-off');
    await access(loginItemPlistPath(label)).then(
      () => { throw new Error('Floway login item plist remains after autostart-off'); },
      error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      },
    );
    let printRejected = false;
    try {
      await execFileAsync(LAUNCHCTL, ['print', `gui/${currentUid()}/${label}`], { timeout: 10_000 });
    } catch {
      printRejected = true;
    }
    if (!printRejected) throw new Error('Floway login item remains loaded in launchd after autostart-off');
    const autostartDisabled = await reportShellStatus(context, applicationHome);
    assertReadyShellStatus(autostartDisabled, origin, { autostartEnabled: false, windowVisible: true });
    console.log('Floway launch-at-login unloaded from launchd and removed its registration');

    await sendDesktopControl(context.executable, applicationHome, 'quit');
    await waitForChildExit(child, 20_000);
    if (child.exitCode !== 0) {
      throw new Error(`Floway explicit quit exited with ${child.exitCode ?? child.signalCode}\n${output()}`);
    }
    await waitForProcessStopped(restartedSidecarPid);
    const captured = output();
    for (const fragment of [
      "Floway desktop sidecar is stopping on its owner's request",
      'Floway desktop stopped and waited for its packaged runtime',
    ]) {
      if (!captured.includes(fragment)) {
        throw new Error(`Floway explicit quit omitted ${JSON.stringify(fragment)}\n${captured}`);
      }
    }
    await assertBoundedSidecarLogs(applicationHome, [
      'Floway desktop operator quit; stopping its runtime',
    ]);
    await assertLoopbackPortReleased(port);
    console.log('Floway explicit quit gracefully stopped and waited for its sidecar before the shell exited');
  });
};

export const assertForcedTerminationReapsSidecar = async (
  context: InstalledAppVerificationContext,
  isolatedRoot: string,
): Promise<void> => {
  const applicationHome = resolve(isolatedRoot, 'PersonalData-forced-termination');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const port = PERSONAL_DASHBOARD_PORT;
  const origin = `http://127.0.0.1:${port}`;

  await withFailureSafeCleanup(async cleanup => {
    await assertLoopbackPortReleased(port);
    await mkdir(applicationHome, { recursive: true });
    cleanup.defer('forced-termination application data', async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer('forced-termination credential', async () => await runCredentialScript(context, credentialIdentity, 'delete'));
    cleanup.defer('forced-termination listener', async () => await assertLoopbackPortReleased(port));
    await writeContractedEntry(context, personalEntrySource(applicationHome, credentialIdentity));
    const { child, output } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', applicationHome],
    );
    cleanup.defer('forced-termination application process group', async () => await terminateProcessGroup(child));
    const sidecarPid = await waitForDirectChild(child, output);
    await waitForHealthyRuntime(child, output, origin);
    if (child.pid === undefined) throw new Error('Floway production app process has no PID');

    forceKillProcess(child.pid);
    await waitForChildExit(child, 10_000);
    if (child.signalCode !== 'SIGKILL') {
      throw new Error(`Floway shell observed ${child.exitCode ?? child.signalCode} instead of the forced SIGKILL`);
    }
    await waitForProcessStopped(sidecarPid);
    // The sidecar's own durable stderr log is written synchronously through
    // the personal logging tee, so its owner-lifetime line landed before the
    // process exited even though the shell was already dead.
    const sidecarStderrLog = await readFile(
      resolve(applicationHome, 'logs', 'floway.stderr.log'),
      'utf8',
    );
    if (!sidecarStderrLog.includes('Floway desktop sidecar is exiting because its owner shell is gone')) {
      throw new Error('Floway sidecar exited after the forced shell kill without its owner-lifetime line');
    }
    await assertLoopbackPortReleased(port);
    console.log('Floway forced shell termination reaped its sidecar through the owner-lifetime channel');

    const { child: relaunched, output: relaunchedOutput } = captureApp(
      context.executable,
      appEnvironmentWithoutPortOverride(),
      ['--data-dir', applicationHome],
    );
    cleanup.defer('forced-termination relaunch process group', async () => await terminateProcessGroup(relaunched));
    const relaunchedSidecarPid = await waitForDirectChild(relaunched, relaunchedOutput);
    if (relaunchedSidecarPid === sidecarPid) {
      throw new Error('Floway relaunch reattached to the killed sidecar');
    }
    await waitForHealthyRuntime(relaunched, relaunchedOutput, origin);
    const relaunchedStatus = await reportShellStatus(context, applicationHome);
    if (relaunchedStatus.phase !== 'ready' || relaunchedStatus.gatewayOrigin !== origin) {
      throw new Error(`Floway relaunch after forced termination did not become ready: ${JSON.stringify(relaunchedStatus)}`);
    }
    await sendDesktopControl(context.executable, applicationHome, 'quit');
    await waitForChildExit(relaunched, 20_000);
    if (relaunched.exitCode !== 0) {
      throw new Error(`Floway relaunched shell exited with ${relaunched.exitCode ?? relaunched.signalCode}\n${relaunchedOutput()}`);
    }
    await waitForProcessStopped(relaunchedSidecarPid);
    console.log('Floway relaunch after forced termination reclaimed its control channel and the endpoint without a port conflict');
  });
};
