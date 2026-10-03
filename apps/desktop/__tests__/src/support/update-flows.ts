import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  createInstalledAppVerificationContext,
  type InstalledAppVerificationContext,
  writeContractedEntry,
} from './installed-app.ts';
import { assertUpdateRecoverySurface } from './native-surface.ts';
import { type CredentialIdentity, personalUpdateEntrySource, runCredentialScript } from './personal-runtime.ts';
import {
  appEnvironmentWithoutPortOverride,
  assertLoopbackPortReleased,
  captureApp,
  desktopAppArguments,
  PERSONAL_DASHBOARD_PORT,
  sendDesktopControl,
  TERMINATION_SIGNAL,
  terminateProcessGroup,
  type CapturedChild,
  waitForProcessStopped,
} from './process-lifecycle.ts';
import {
  BASE_VERIFICATION_VERSION,
  generateUpdateSigningKey,
  packageApplicationArchive,
  readUpdateState,
  runPnpm,
  sha256File,
  signUpdateArtifact,
  UPDATE_VERIFICATION_VERSION,
  updateManifest,
  UpdateFixtureServer,
  type UpdateSigningKey,
  writeUpdateChannelFile,
} from './update-fixtures.ts';
import { withFailureSafeCleanup } from '../../../src/failure-chain.ts';
import type { DesktopTargetTriple } from '../../../src/release-contract.ts';

const execFileAsync = promisify(execFile);

export interface UpdateScenarioContext {
  readonly context: InstalledAppVerificationContext;
  readonly verifyUpdateUi: boolean;
  readonly desktopRoot: string;
  readonly installedApp: string;
  readonly isolatedRoot: string;
  readonly keyringRelativePath: string;
  readonly migrationNames: readonly string[];
  readonly nodeExecutable: string;
  readonly pristineApp: string;
  readonly repositoryRoot: string;
  readonly server: UpdateFixtureServer;
  readonly signingKey: UpdateSigningKey;
  readonly targetTriple: DesktopTargetTriple;
  readonly updatedApp: string;
  readonly updateTarget: string;
}

// The updated-application build bumps every release-version authority to the
// verification version, rebuilds the application bundle, and restores the
// authorities byte-for-byte so the working tree never keeps a version bump.
export const buildUpdatedApplication = async (options: {
  readonly desktopRoot: string;
  readonly nodeExecutable: string;
  readonly repositoryRoot: string;
  readonly targetTriple: DesktopTargetTriple;
  readonly profile: 'debug' | 'release';
}): Promise<string> => {
  const { desktopRoot, nodeExecutable, repositoryRoot, targetTriple, profile } = options;
  const jsonAuthorities = [
    'apps/desktop/package.json',
    'apps/platform-node/package.json',
    'apps/web/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
  ].map(relative => resolve(repositoryRoot, relative));
  const cargoManifest = resolve(repositoryRoot, 'apps/desktop/src-tauri/Cargo.toml');
  // The bumped build rewrites Cargo.lock too; save and restore it with the
  // other authorities so the working tree never keeps a version bump.
  const cargoLock = resolve(repositoryRoot, 'apps/desktop/src-tauri/Cargo.lock');
  const originals = new Map<string, string>();
  for (const path of [...jsonAuthorities, cargoManifest, cargoLock]) {
    originals.set(path, await readFile(path, 'utf8'));
  }
  const updatedApp = resolve(desktopRoot, 'src-tauri/target', targetTriple, profile, 'bundle/macos/Floway.app');
  await withFailureSafeCleanup(async cleanup => {
    for (const [path, source] of originals) {
      cleanup.defer(`release authority ${path} restoration`, async () => await writeFile(path, source));
    }
    for (const path of jsonAuthorities) {
      const manifest = JSON.parse(originals.get(path)!) as { version?: unknown };
      if (manifest.version !== BASE_VERIFICATION_VERSION) {
        throw new Error(`Release authority ${path} is not at ${BASE_VERIFICATION_VERSION}`);
      }
      manifest.version = UPDATE_VERIFICATION_VERSION;
      await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`);
    }
    const cargoSource = originals.get(cargoManifest)!;
    if (!cargoSource.includes(`version = "${BASE_VERIFICATION_VERSION}"`)) {
      throw new Error(`Cargo release authority is not at ${BASE_VERIFICATION_VERSION}`);
    }
    await writeFile(cargoManifest, cargoSource.replace(
      `version = "${BASE_VERIFICATION_VERSION}"`,
      `version = "${UPDATE_VERIFICATION_VERSION}"`,
    ));
    await runPnpm(repositoryRoot, [
      '--filter',
      '@floway-dev/desktop',
      'exec',
      'tauri',
      'build',
      ...(profile === 'debug' ? ['--debug'] : []),
      '--bundles',
      'app',
      '--target',
      targetTriple,
    ], {
      ...process.env,
      CARGO_BUILD_JOBS: '1',
      CARGO_INCREMENTAL: '0',
      CARGO_PROFILE_DEV_CODEGEN_UNITS: '1',
      CARGO_PROFILE_DEV_DEBUG: '0',
      FLOWAY_DESKTOP_EXECUTE_NODE: '1',
      FLOWAY_DESKTOP_NODE_EXECUTABLE: nodeExecutable,
      TAURI_CONFIG: '{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}',
      APPLE_SIGNING_IDENTITY: undefined,
      APPLE_API_ISSUER: undefined,
      APPLE_API_KEY: undefined,
      APPLE_API_KEY_PATH: undefined,
      APPLE_ID: undefined,
      APPLE_PASSWORD: undefined,
      APPLE_TEAM_ID: undefined,
      TAURI_SIGNING_PRIVATE_KEY: undefined,
    });
  }, 'Floway updated fixture build failed and version authority restoration also failed');
  return updatedApp;
};

// Release checks use the same optimized application and feature gates as the
// shipping bundle. Plain HTTP is enabled only in an isolated fixture build;
// the original shipping bundle must first prove that it rejects that transport.
// https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.12.0/plugins/updater/src/config.rs
const buildReleaseUpdateFixture = async (scenario: UpdateScenarioContext): Promise<string> => {
  await runPnpm(scenario.repositoryRoot, [
    '--filter', '@floway-dev/desktop', 'exec', 'tauri', 'build', '--bundles', 'app', '--target', scenario.targetTriple,
  ], {
    ...process.env,
    FLOWAY_DESKTOP_EXECUTE_NODE: '1',
    FLOWAY_DESKTOP_NODE_EXECUTABLE: scenario.nodeExecutable,
    TAURI_CONFIG: '{"bundle":{"createUpdaterArtifacts":false},"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}',
    APPLE_SIGNING_IDENTITY: undefined,
    APPLE_API_ISSUER: undefined,
    APPLE_API_KEY: undefined,
    APPLE_API_KEY_PATH: undefined,
    APPLE_ID: undefined,
    APPLE_PASSWORD: undefined,
    APPLE_TEAM_ID: undefined,
    TAURI_SIGNING_PRIVATE_KEY: undefined,
  });
  return resolve(scenario.desktopRoot, 'src-tauri/target', scenario.targetTriple, 'release/bundle/macos/Floway.app');
};

export const cloneApplication = async (source: string, destination: string): Promise<void> => {
  // APFS copy-on-write clones keep the pristine and variant application copies
  // effectively free on the shared verification disk.
  await execFileAsync('cp', ['-Rc', source, destination]);
};

export const restorePristineApplication = async (scenario: UpdateScenarioContext): Promise<void> => {
  await rm(scenario.installedApp, { force: true, recursive: true });
  await cloneApplication(scenario.pristineApp, scenario.installedApp);
};

const waitForLoopbackHealth = async (
  origin: string,
  output: () => string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${origin}/api/health`);
      if (health.ok) return;
    } catch { /* the listener is still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Floway updated runtime did not become healthy\n${output()}`);
};

const terminatePid = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, TERMINATION_SIGNAL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await waitForProcessStopped(pid);
};

const waitForShellProcess = async (
  executable: string,
  excludedPid: number | undefined,
  output: () => string,
): Promise<number> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-f', executable]);
      const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => pid !== excludedPid);
      if (pids.length === 1) return pids[0]!;
      if (pids.length > 1) throw new Error(`Multiple Floway shells matched ${executable}: ${pids.join(', ')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code !== 1) throw error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Floway updated shell did not relaunch\n${output()}`);
};

interface UpdateLaunch {
  readonly child: CapturedChild;
  readonly output: () => string;
}

const launchForUpdate = (
  scenario: UpdateScenarioContext,
  options: {
    readonly applicationHome: string;
    readonly args?: readonly string[];
    readonly locale?: 'en' | 'zh-Hans';
  },
): UpdateLaunch => {
  const environment = appEnvironmentWithoutPortOverride(options.locale);
  environment.FLOWAY_DESKTOP_UPDATE_ENDPOINTS = scenario.server.manifestUrl;
  environment.FLOWAY_DESKTOP_UPDATE_PUBKEY = scenario.signingKey.pubkey;
  return captureApp(scenario.context.executable, environment, [
    ...desktopAppArguments(options.applicationHome, options.locale),
    ...(options.args ?? []),
  ]);
};

const waitForCaptured = async (
  launch: UpdateLaunch,
  expectedFragments: readonly string[],
  timeoutMs = 60_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = launch.output();
    if (expectedFragments.every(fragment => captured.includes(fragment))) return captured;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Floway update flow omitted ${JSON.stringify(expectedFragments)}\n${launch.output()}`);
};

interface ScenarioArtifact {
  readonly bytes: Buffer;
  readonly signature: string;
}

const buildScenarioArtifact = async (
  scenario: UpdateScenarioContext,
  options: {
    readonly credentialIdentity: CredentialIdentity;
    readonly personalRoot: string;
    readonly tamper?: (context: InstalledAppVerificationContext) => Promise<void>;
    readonly workDir: string;
  },
): Promise<ScenarioArtifact> => {
  const variantParent = resolve(options.workDir, `variant-${randomUUID()}`);
  await mkdir(variantParent, { recursive: true });
  const variantApp = resolve(variantParent, 'Floway.app');
  try {
    await cloneApplication(scenario.updatedApp, variantApp);
    const variantContext = await createInstalledAppVerificationContext(
      variantApp,
      scenario.keyringRelativePath,
      scenario.migrationNames,
    );
    await writeContractedEntry(
      variantContext,
      personalUpdateEntrySource(options.personalRoot, options.credentialIdentity),
    );
    if (options.tamper !== undefined) await options.tamper(variantContext);
    const archivePath = resolve(options.workDir, `artifact-${randomUUID()}.tar.gz`);
    const bytes = await packageApplicationArchive(variantApp, archivePath);
    const signature = await signUpdateArtifact(scenario.repositoryRoot, scenario.signingKey, archivePath);
    await rm(archivePath, { force: true });
    return { bytes, signature };
  } finally {
    await rm(variantParent, { force: true, recursive: true });
  }
};

const signBytesWithKey = async (
  scenario: UpdateScenarioContext,
  key: UpdateSigningKey,
  bytes: Buffer,
  workDir: string,
): Promise<string> => {
  const path = resolve(workDir, `artifact-to-sign-${randomUUID()}.tar.gz`);
  await writeFile(path, bytes);
  try {
    return await signUpdateArtifact(scenario.repositoryRoot, key, path);
  } finally {
    await rm(path, { force: true });
  }
};

const assertUpdateState = async (
  applicationHome: string,
  expectations: {
    readonly failurePhase?: string | null;
    readonly lastHealthyVersion?: string | null;
    readonly pending?: { readonly previousVersion: string; readonly version: string } | null;
    readonly staged?: string | null;
  },
): Promise<void> => {
  const state = await readUpdateState(applicationHome);
  const problems: string[] = [];
  if (expectations.failurePhase !== undefined && state.failure?.phase !== expectations.failurePhase) {
    problems.push(`failure phase ${state.failure?.phase ?? 'none'} != ${expectations.failurePhase ?? 'none'}`);
  }
  if (expectations.lastHealthyVersion !== undefined && state.lastHealthyVersion !== expectations.lastHealthyVersion) {
    problems.push(`last healthy ${state.lastHealthyVersion ?? 'none'} != ${expectations.lastHealthyVersion ?? 'none'}`);
  }
  if (expectations.pending !== undefined) {
    const pending = state.pending === null || expectations.pending === null
      ? state.pending === (expectations.pending ?? null)
      : state.pending.version === expectations.pending.version
        && state.pending.previousVersion === expectations.pending.previousVersion;
    if (!pending) problems.push(`pending ${JSON.stringify(state.pending)} != ${JSON.stringify(expectations.pending)}`);
  }
  if (expectations.staged !== undefined && (state.staged?.version ?? null) !== expectations.staged) {
    problems.push(`staged ${state.staged?.version ?? 'none'} != ${expectations.staged ?? 'none'}`);
  }
  if (problems.length > 0) {
    throw new Error(`Floway update state diverged: ${problems.join('; ')}\n${JSON.stringify(state)}`);
  }
};

const assertRecoveryPointOpensWithDeviceKey = async (
  scenario: UpdateScenarioContext,
  credentialIdentity: CredentialIdentity,
  recoveryPointPath: string,
): Promise<void> => {
  const script = `
const { Entry } = await import('@napi-rs/keyring');
const { openEncryptedBackupArchive } = await import('@floway-dev/gateway');
const { readFile } = await import('node:fs/promises');
const entry = new Entry(${JSON.stringify(credentialIdentity.service)}, ${JSON.stringify(credentialIdentity.account)});
const secret = entry.getSecret();
if (secret === null) throw new Error('isolated update credential was not created');
const password = Buffer.from(secret).toString('hex');
const archive = JSON.parse(await readFile(${JSON.stringify(recoveryPointPath)}, 'utf8'));
const payload = await openEncryptedBackupArchive(archive, password);
if (!payload?.data?.users?.some(user => user.id === 1)) throw new Error('recovery point lost the single owner');
let wrongPasswordFailed = false;
try { await openEncryptedBackupArchive(archive, 'definitely-wrong-password'); }
catch { wrongPasswordFailed = true; }
if (!wrongPasswordFailed) throw new Error('recovery point opened with a wrong password');
console.log('update recovery point opens with the device master key');
`;
  const { stdout } = await execFileAsync(scenario.context.node, ['--input-type=module', '--eval', script], {
    cwd: scenario.context.platformNode,
    timeout: 60_000,
  });
  if (!stdout.includes('update recovery point opens with the device master key')) {
    throw new Error(`Recovery point device-key probe returned unexpected output: ${stdout}`);
  }
};

const recoveryPointShaFromOutput = (output: string): string => {
  const sha = /"phase":"recovery-point","sha256":"([0-9a-f]{64})"/.exec(output)?.[1];
  if (sha === undefined) throw new Error(`Floway update flow emitted no recovery point digest\n${output}`);
  return sha;
};

const assertProductionRejectsInsecureUpdates = async (scenario: UpdateScenarioContext): Promise<void> => {
  const applicationHome = resolve(scenario.isolatedRoot, 'ShellData-update-transport');
  const personalRoot = resolve(scenario.isolatedRoot, 'PersonalData-update-transport');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer('update-transport personal data', async () => await rm(personalRoot, { force: true, recursive: true }));
    cleanup.defer('update-transport shell data', async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer('update-transport credential', async () => await runCredentialScript(scenario.context, credentialIdentity, 'delete'));
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    cleanup.defer('update-transport listener', async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));
    await restorePristineApplication(scenario);
    await writeContractedEntry(scenario.context, personalUpdateEntrySource(personalRoot, credentialIdentity));
    const requests = scenario.server.requestCount;
    const launch = launchForUpdate(scenario, { applicationHome });
    cleanup.defer('update-transport process group', async () => await terminateProcessGroup(launch.child));
    await waitForCaptured(launch, [
      'FLOWAY_DESKTOP_UPDATE ', '"phase":"error"', '"updatePhase":"check"',
      'Floway could not configure its updater endpoints',
      'The configured updater endpoint must use a secure protocol like `https`.',
    ]);
    await waitForLoopbackHealth(`http://127.0.0.1:${PERSONAL_DASHBOARD_PORT}`, launch.output);
    await assertUpdateState(applicationHome, {
      failurePhase: 'check', lastHealthyVersion: BASE_VERIFICATION_VERSION, pending: null, staged: null,
    });
    if (scenario.server.requestCount !== requests) throw new Error('Floway production updater requested an insecure fixture endpoint');
    await terminateProcessGroup(launch.child);
  });
  console.log('Floway production release rejected plain-HTTP update authority before any fixture request and kept the Gateway serving');
};

// S1: a signed update stages in the background while the gateway keeps
// serving, installs at a controlled restart behind a device-protected
// recovery point, and reports the new version healthy.
export const assertSignedUpdateInstallsAndReportsHealthy = async (
  scenario: UpdateScenarioContext,
): Promise<void> => {
  const applicationHome = resolve(scenario.isolatedRoot, 'ShellData-update-success');
  const personalRoot = resolve(scenario.isolatedRoot, 'PersonalData-update-success');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const origin = `http://127.0.0.1:${PERSONAL_DASHBOARD_PORT}`;
  const workDir = resolve(scenario.isolatedRoot, 'update-work-success');

  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer('update-success work directory', async () => await rm(workDir, { force: true, recursive: true }));
    cleanup.defer('update-success personal data', async () => await rm(personalRoot, { force: true, recursive: true }));
    cleanup.defer('update-success shell data', async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer('update-success credential', async () => await runCredentialScript(scenario.context, credentialIdentity, 'delete'));
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    cleanup.defer('update-success listener', async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));

    await restorePristineApplication(scenario);
    const artifact = await buildScenarioArtifact(scenario, { credentialIdentity, personalRoot, workDir });
    scenario.server.serve({
      artifact: artifact.bytes,
      manifest: updateManifest({
        artifactUrl: scenario.server.artifactUrl,
        signature: artifact.signature,
        target: scenario.updateTarget,
        version: scenario.verifyUpdateUi ? BASE_VERIFICATION_VERSION : UPDATE_VERIFICATION_VERSION,
      }),
    });

    await writeContractedEntry(scenario.context, personalUpdateEntrySource(personalRoot, credentialIdentity));
    const first = launchForUpdate(scenario, { applicationHome });
    cleanup.defer('update-success first process group', async () => await terminateProcessGroup(first.child));
    await waitForCaptured(first, scenario.verifyUpdateUi ? ['"phase":"no-update"'] : [
      'FLOWAY_DESKTOP_UPDATE ',
      '"channel":"stable"',
      '"phase":"staged"',
      `"version":"${UPDATE_VERIFICATION_VERSION}"`,
    ], 120_000);
    await waitForLoopbackHealth(origin, first.output);
    await assertUpdateState(applicationHome, {
      lastHealthyVersion: BASE_VERIFICATION_VERSION,
      pending: null,
      staged: scenario.verifyUpdateUi ? null : UPDATE_VERIFICATION_VERSION,
    });
    let second: ReturnType<typeof launchForUpdate>;
    if (scenario.verifyUpdateUi) {
      // Health and updater completion precede the browser's one-time owner
      // login. Keep its bootstrap document live until that exchange completes.
      await waitForCaptured(first, ['FLOWAY_DASHBOARD_BOOTSTRAP {"phase":"completed"}'], 120_000);
      const probe = async (step: string, expected: (surface: Record<string, unknown>) => boolean) => {
        await sendDesktopControl(scenario.context.executable, applicationHome, `verify-update-ui?step=${step}`);
        const marker = `"step":"${step}"`;
        const output = await waitForCaptured(first, ['FLOWAY_DESKTOP_UPDATE_UI ', marker], 30_000);
        const line = output.split('\n').findLast(line => line.startsWith('FLOWAY_DESKTOP_UPDATE_UI ') && line.includes(marker));
        if (!line) throw new Error(`Floway update UI emitted no ${step} evidence`);
        const surface = JSON.parse(line.slice('FLOWAY_DESKTOP_UPDATE_UI '.length)) as Record<string, unknown>;
        if (surface.error || !expected(surface)) throw new Error(`Floway update UI ${step} failed: ${JSON.stringify(surface)}`);
      };
      await probe('open-settings', surface => surface.readyButtons === 0 && surface.phase === 'upToDate');
      scenario.server.serve({
        artifact: artifact.bytes,
        manifest: updateManifest({
          artifactUrl: scenario.server.artifactUrl, signature: artifact.signature,
          target: scenario.updateTarget, version: UPDATE_VERIFICATION_VERSION,
        }),
      });
      await probe('check', surface => ['upToDate', 'checking', 'downloading', 'verifying', 'ready'].includes(String(surface.phase)));
      // The UI gesture only initiates work. Download, signature verification,
      // and durable staging use the same owning completion bound as the CLI
      // path; a renderer readiness wait must not bound the whole installation
      // package download on a slower native runner.
      await waitForCaptured(first, ['FLOWAY_DESKTOP_UPDATE ', '"phase":"staged"', `"version":"${UPDATE_VERIFICATION_VERSION}"`], 120_000);
      await probe('ready', surface => surface.readyButtons === 2 && surface.phase === 'ready' && surface.version === UPDATE_VERIFICATION_VERSION);
      await assertUpdateState(applicationHome, { lastHealthyVersion: BASE_VERIFICATION_VERSION, pending: null, staged: UPDATE_VERIFICATION_VERSION });
      // Keep pixel evidence outside the disposable application data root.
      await writeFile('/private/tmp/floway-update-packaged-ready.png', await readFile(resolve(applicationHome, 'update-ui.png')));
      await probe('later', surface => surface.readyButtons === 1 && surface.laterButtons === 0);
      await probe('notes', surface => surface.notesVisible === true);
      await writeFile('/private/tmp/floway-update-packaged-notes.png', await readFile(resolve(applicationHome, 'update-ui.png')));
      await probe('close', surface => surface.notesVisible === false);
      await probe('install', surface => surface.readyButtons === 2);
      await sendDesktopControl(scenario.context.executable, applicationHome, 'verify-update-ui?step=confirm');
      second = first;
      console.log('Floway packaged settings controls checked the native update, persisted Later, displayed release notes, and explicitly started installation');
    } else {
      await terminateProcessGroup(first.child);
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
      second = launchForUpdate(scenario, { applicationHome, args: ['--install-staged-update'] });
      cleanup.defer('update-success second process group', async () => await terminateProcessGroup(second.child));
    }
    const captured = await waitForCaptured(second, [
      '"phase":"recovery-point"',
      `"previousVersion":"${BASE_VERIFICATION_VERSION}"`,
      '"phase":"installed"',
      '"phase":"healthy"',
      `"version":"${UPDATE_VERIFICATION_VERSION}"`,
    ], 240_000);
    await waitForLoopbackHealth(origin, second.output, 60_000);
    const desktopHealth = await fetch(`${origin}/api/desktop/health`);
    if (!desktopHealth.ok) throw new Error(`Floway updated runtime health returned ${desktopHealth.status}`);
    const health = await desktopHealth.json() as { compatibility?: { releaseVersion?: unknown } };
    if (health.compatibility?.releaseVersion !== UPDATE_VERIFICATION_VERSION) {
      throw new Error(`Floway updated runtime reported ${JSON.stringify(health.compatibility)} instead of ${UPDATE_VERIFICATION_VERSION}`);
    }
    await assertUpdateState(applicationHome, {
      lastHealthyVersion: UPDATE_VERIFICATION_VERSION,
      pending: null,
      staged: null,
    });
    const recoveryPointPath = resolve(applicationHome, 'update', 'recovery-point.json');
    if (await sha256File(recoveryPointPath) !== recoveryPointShaFromOutput(captured)) {
      throw new Error('Floway recovery point digest diverged from its creation evidence');
    }
    await assertRecoveryPointOpensWithDeviceKey(scenario, credentialIdentity, recoveryPointPath);
    console.log(`Floway installed the signed update behind a device-protected recovery point and marked ${UPDATE_VERIFICATION_VERSION} healthy after its controlled restart`);
    await terminateProcessGroup(second.child);
  });
};

// A staged artifact tampered between staging and the controlled restart is
// re-authenticated at install and rejected with the staged update, the pending
// state, and the recovery point intact.
export const assertStagedArtifactTamperRejected = async (
  scenario: UpdateScenarioContext,
): Promise<void> => {
  const applicationHome = resolve(scenario.isolatedRoot, 'ShellData-update-staged-tamper');
  const personalRoot = resolve(scenario.isolatedRoot, 'PersonalData-update-staged-tamper');
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const workDir = resolve(scenario.isolatedRoot, 'update-work-staged-tamper');

  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer('staged-tamper work directory', async () => await rm(workDir, { force: true, recursive: true }));
    cleanup.defer('staged-tamper personal data', async () => await rm(personalRoot, { force: true, recursive: true }));
    cleanup.defer('staged-tamper shell data', async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer('staged-tamper credential', async () => await runCredentialScript(scenario.context, credentialIdentity, 'delete'));
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    cleanup.defer('staged-tamper listener', async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));

    await restorePristineApplication(scenario);
    const artifact = await buildScenarioArtifact(scenario, { credentialIdentity, personalRoot, workDir });
    scenario.server.serve({
      artifact: artifact.bytes,
      manifest: updateManifest({
        artifactUrl: scenario.server.artifactUrl,
        signature: artifact.signature,
        target: scenario.updateTarget,
        version: UPDATE_VERIFICATION_VERSION,
      }),
    });

    await mkdir(resolve(applicationHome, 'update'), { recursive: true });
    const sentinelRecoveryPoint = '{"preserved":"pre-update recovery point"}\n';
    await writeFile(resolve(applicationHome, 'update', 'recovery-point.json'), sentinelRecoveryPoint, { mode: 0o600 });

    await writeContractedEntry(scenario.context, personalUpdateEntrySource(personalRoot, credentialIdentity));
    const first = launchForUpdate(scenario, { applicationHome });
    cleanup.defer('staged-tamper first process group', async () => await terminateProcessGroup(first.child));
    await waitForCaptured(first, [
      '"phase":"staged"',
      `"version":"${UPDATE_VERIFICATION_VERSION}"`,
    ], 120_000);
    await terminateProcessGroup(first.child);
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);

    const stagedState = await readUpdateState(applicationHome);
    if (!stagedState.staged) throw new Error('Floway tamper fixture has no staged artifact');
    const stagedArtifact = resolve(applicationHome, 'update', stagedState.staged.artifactFile);
    const stagedBytes = await readFile(stagedArtifact);
    stagedBytes[Math.floor(stagedBytes.byteLength / 2)] ^= 0xFF;
    await writeFile(stagedArtifact, stagedBytes);

    const second = launchForUpdate(scenario, {
      applicationHome,
      args: ['--install-staged-update'],
    });
    cleanup.defer('staged-tamper second process group', async () => await terminateProcessGroup(second.child));
    await waitForCaptured(second, [
      '"phase":"installing"',
      '"phase":"error"',
      '"updatePhase":"signature"',
      'failed re-authentication',
    ], 120_000);
    await assertUpdateState(applicationHome, {
      failurePhase: 'signature',
      lastHealthyVersion: BASE_VERIFICATION_VERSION,
      pending: null,
      staged: UPDATE_VERIFICATION_VERSION,
    });
    if ((await readFile(resolve(applicationHome, 'update', 'recovery-point.json'), 'utf8')) !== sentinelRecoveryPoint) {
      throw new Error('Floway staged-artifact tamper rejection rewrote the preserved recovery point');
    }
    console.log('Floway rejected the tampered staged artifact at install re-authentication with the staged update and recovery point intact');
    await terminateProcessGroup(second.child);
  });
};

// S2/S3: a bad signature or a corrupted artifact fails authentication before
// installation, leaves the running gateway serving, and preserves any
// pre-existing recovery point.
export const assertSignatureFailureKeepsRuntimeServing = async (
  scenario: UpdateScenarioContext,
  options: {
    readonly channel?: 'preview';
    readonly corruptArtifact: boolean;
    readonly label: string;
  },
): Promise<void> => {
  const applicationHome = resolve(scenario.isolatedRoot, `ShellData-update-${options.label}`);
  const personalRoot = resolve(scenario.isolatedRoot, `PersonalData-update-${options.label}`);
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const origin = `http://127.0.0.1:${PERSONAL_DASHBOARD_PORT}`;
  const workDir = resolve(scenario.isolatedRoot, `update-work-${options.label}`);

  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer(`${options.label} work directory`, async () => await rm(workDir, { force: true, recursive: true }));
    cleanup.defer(`${options.label} personal data`, async () => await rm(personalRoot, { force: true, recursive: true }));
    cleanup.defer(`${options.label} shell data`, async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer(`${options.label} credential`, async () => await runCredentialScript(scenario.context, credentialIdentity, 'delete'));
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    cleanup.defer(`${options.label} listener`, async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));

    await restorePristineApplication(scenario);
    const artifact = await buildScenarioArtifact(scenario, { credentialIdentity, personalRoot, workDir });
    let signature = artifact.signature;
    let servedBytes = artifact.bytes;
    if (options.corruptArtifact) {
      servedBytes = Buffer.from(artifact.bytes);
      servedBytes[Math.floor(servedBytes.byteLength / 2)] ^= 0xFF;
    } else {
      const wrongKeyDir = resolve(workDir, 'wrong-key');
      await mkdir(wrongKeyDir, { recursive: true });
      const wrongKey = await generateUpdateSigningKey(scenario.repositoryRoot, wrongKeyDir);
      signature = await signBytesWithKey(scenario, wrongKey, artifact.bytes, workDir);
    }
    scenario.server.serve({
      artifact: servedBytes,
      manifest: updateManifest({
        artifactUrl: scenario.server.artifactUrl,
        signature,
        target: scenario.updateTarget,
        version: UPDATE_VERIFICATION_VERSION,
      }),
    });

    // A pre-existing recovery point must survive every authentication failure.
    await mkdir(resolve(applicationHome, 'update'), { recursive: true });
    const sentinelRecoveryPoint = '{"preserved":"pre-update recovery point"}\n';
    await writeFile(resolve(applicationHome, 'update', 'recovery-point.json'), sentinelRecoveryPoint, { mode: 0o600 });
    if (options.channel !== undefined) await writeUpdateChannelFile(applicationHome, options.channel);

    await writeContractedEntry(scenario.context, personalUpdateEntrySource(personalRoot, credentialIdentity));
    const launch = launchForUpdate(scenario, { applicationHome });
    cleanup.defer(`${options.label} process group`, async () => await terminateProcessGroup(launch.child));
    const captured = await waitForCaptured(launch, [
      'FLOWAY_DESKTOP_UPDATE ',
      `"channel":"${options.channel ?? 'stable'}"`,
      '"phase":"error"',
      '"updatePhase":"signature"',
      `"version":"${UPDATE_VERIFICATION_VERSION}"`,
      'FLOWAY_DESKTOP_UPDATE_SURFACE ',
      '"failurePhase":"signature"',
      '"text":"Update Failed — Download Previous Version"',
      '"enabled":true',
    ], 120_000);
    await waitForLoopbackHealth(origin, launch.output);
    await assertUpdateState(applicationHome, {
      failurePhase: 'signature',
      lastHealthyVersion: BASE_VERIFICATION_VERSION,
      pending: null,
      staged: null,
    });
    if ((await readFile(resolve(applicationHome, 'update', 'recovery-point.json'), 'utf8')) !== sentinelRecoveryPoint) {
      throw new Error(`Floway signature failure rewrote the preserved recovery point\n${captured}`);
    }
    await terminateProcessGroup(launch.child);
  });
};

// S4/S5: a post-update startup failure presents the recovery surface with the
// full error, the preserved recovery point, and the previous-version download
// entry, without marking the new version healthy.
export const assertPostUpdateFailurePresentsRecovery = async (
  nativeWindowProbe: string,
  scenario: UpdateScenarioContext,
  options: {
    readonly expectedLocale?: 'en' | 'zh-Hans';
    readonly expectedFragments: readonly string[];
    readonly failureKind: 'asset' | 'migration';
    readonly label: string;
    readonly tamper: (context: InstalledAppVerificationContext) => Promise<void>;
  },
): Promise<void> => {
  const applicationHome = resolve(scenario.isolatedRoot, `ShellData-update-${options.label}`);
  const personalRoot = resolve(scenario.isolatedRoot, `PersonalData-update-${options.label}`);
  const credentialIdentity: CredentialIdentity = {
    service: `Floway desktop package verification ${randomUUID()}`,
    account: `device-master-key-${randomUUID()}`,
  };
  const workDir = resolve(scenario.isolatedRoot, `update-work-${options.label}`);

  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer(`${options.label} work directory`, async () => await rm(workDir, { force: true, recursive: true }));
    cleanup.defer(`${options.label} personal data`, async () => await rm(personalRoot, { force: true, recursive: true }));
    cleanup.defer(`${options.label} shell data`, async () => await rm(applicationHome, { force: true, recursive: true }));
    cleanup.defer(`${options.label} credential`, async () => await runCredentialScript(scenario.context, credentialIdentity, 'delete'));
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    cleanup.defer(`${options.label} listener`, async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));

    await restorePristineApplication(scenario);
    const artifact = await buildScenarioArtifact(scenario, {
      credentialIdentity,
      personalRoot,
      tamper: options.tamper,
      workDir,
    });
    scenario.server.serve({
      artifact: artifact.bytes,
      manifest: updateManifest({
        artifactUrl: scenario.server.artifactUrl,
        signature: artifact.signature,
        target: scenario.updateTarget,
        version: UPDATE_VERIFICATION_VERSION,
      }),
    });

    await writeContractedEntry(scenario.context, personalUpdateEntrySource(personalRoot, credentialIdentity));
    const first = launchForUpdate(scenario, { applicationHome });
    cleanup.defer(`${options.label} first process group`, async () => await terminateProcessGroup(first.child));
    await waitForCaptured(first, [
      '"phase":"staged"',
      `"version":"${UPDATE_VERIFICATION_VERSION}"`,
    ], 120_000);
    await assertUpdateState(applicationHome, {
      lastHealthyVersion: BASE_VERIFICATION_VERSION,
      pending: null,
      staged: UPDATE_VERIFICATION_VERSION,
    });
    await terminateProcessGroup(first.child);
    await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);

    const second = launchForUpdate(scenario, {
      applicationHome,
      args: ['--install-staged-update'],
      locale: options.expectedLocale,
    });
    cleanup.defer(`${options.label} second process group`, async () => await terminateProcessGroup(second.child));
    const captured = await waitForCaptured(second, [
      '"phase":"installed"',
      `Floway desktop runtime state: failed kind=${options.failureKind}`,
      'FLOWAY_DESKTOP_SURFACE ',
      'FLOWAY_DESKTOP_RECOVERY_SURFACE ',
      '"download-previous-version"',
    ], 240_000);
    await assertUpdateState(applicationHome, {
      failurePhase: 'health',
      lastHealthyVersion: BASE_VERIFICATION_VERSION,
      pending: { previousVersion: BASE_VERIFICATION_VERSION, version: UPDATE_VERIFICATION_VERSION },
      staged: null,
    });
    const recoveryPointPath = resolve(applicationHome, 'update', 'recovery-point.json');
    if (await sha256File(recoveryPointPath) !== recoveryPointShaFromOutput(captured)) {
      throw new Error(`Floway post-update ${options.failureKind} failure rewrote the pre-update recovery point`);
    }
    await assertRecoveryPointOpensWithDeviceKey(scenario, credentialIdentity, recoveryPointPath);
    const shellPid = await waitForShellProcess(scenario.context.executable, second.child.pid, second.output);
    cleanup.defer(`${options.label} relaunched shell process`, async () => await terminatePid(shellPid));
    await assertUpdateRecoverySurface(nativeWindowProbe, shellPid, captured, {
      dataRoot: applicationHome,
      expectedLocale: options.expectedLocale,
      expectedRenderedFragments: options.expectedFragments,
      failureKind: options.failureKind,
      previousVersion: BASE_VERIFICATION_VERSION,
      updateVersion: UPDATE_VERIFICATION_VERSION,
    });
    console.log(`Floway post-update ${options.failureKind} failure kept the recovery point, the full error, and the previous-version download entry without marking ${UPDATE_VERIFICATION_VERSION} healthy`);
  });
};

export const tamperRemoveLazyDashboardAsset = async (
  context: InstalledAppVerificationContext,
): Promise<void> => {
  const contract = JSON.parse(await readFile(context.contract, 'utf8')) as {
    dashboard: { assets: Array<{ path: string }> };
  };
  const lazy = contract.dashboard.assets.find(asset => asset.path.startsWith('assets/'));
  if (lazy === undefined) throw new Error('Update health-failure tamper found no lazy Dashboard asset');
  await rm(resolve(context.appRoot, 'Contents/Resources/runtime/apps/web/dist/client', lazy.path));
};

export const tamperAddInvalidMigration = async (
  context: InstalledAppVerificationContext,
): Promise<void> => {
  const migrationName = '0099_update_fault.sql';
  const invalid = 'SELECT 1;\nTHIS IS NOT SQL;\n';
  await writeFile(resolve(context.migrations, migrationName), invalid);
  const contract = JSON.parse(await readFile(context.contract, 'utf8')) as {
    migrations: { files: Array<{ path: string; sha256: string }> };
  };
  contract.migrations.files.push({
    path: migrationName,
    sha256: createHash('sha256').update(invalid).digest('hex'),
  });
  contract.migrations.files.sort((a, b) => a.path < b.path ? -1 : 1);
  await writeFile(context.contract, `${JSON.stringify(contract, undefined, 2)}\n`);
};

export const assertPackagedUpdateFlows = async (
  nativeWindowProbe: string,
  scenarioBase: Omit<UpdateScenarioContext, 'pristineApp' | 'server' | 'signingKey' | 'updatedApp' | 'updateTarget' | 'nodeExecutable'> & { readonly nodeExecutable: string | undefined },
): Promise<void> => {
  const { nodeExecutable } = scenarioBase;
  if (nodeExecutable === undefined) {
    throw new Error('Packaged update verification requires FLOWAY_DESKTOP_NODE_EXECUTABLE');
  }
  const base = { ...scenarioBase, nodeExecutable };
  await withFailureSafeCleanup(async cleanup => {
    const signingDir = resolve(base.isolatedRoot, 'update-signing');
    cleanup.defer('update signing directory', async () => await rm(signingDir, { force: true, recursive: true }));
    const signingKey = await generateUpdateSigningKey(base.repositoryRoot, signingDir);
    const server = await UpdateFixtureServer.start();
    cleanup.defer('update fixture server', async () => await server.close());
    const pristineApp = resolve(base.isolatedRoot, 'Floway-pristine.app');
    cleanup.defer('pristine update fixture', async () => await rm(pristineApp, { force: true, recursive: true }));
    await cloneApplication(base.installedApp, pristineApp);
    const profile = base.verifyUpdateUi ? 'debug' : 'release';
    const bundlePath = resolve(base.desktopRoot, 'src-tauri/target', base.targetTriple, profile, 'bundle/macos/Floway.app');
    cleanup.defer('updated fixture bundle', async () => await rm(bundlePath, { force: true, recursive: true }));
    const updatedBundle = await buildUpdatedApplication({
      desktopRoot: base.desktopRoot, nodeExecutable, repositoryRoot: base.repositoryRoot,
      targetTriple: base.targetTriple, profile,
    });
    const updatedApp = base.verifyUpdateUi ? updatedBundle : resolve(base.isolatedRoot, 'Floway-updated.app');
    if (!base.verifyUpdateUi) {
      cleanup.defer('isolated updated application', async () => await rm(updatedApp, { force: true, recursive: true }));
      await cloneApplication(updatedBundle, updatedApp);
    }
    const scenario: UpdateScenarioContext = {
      ...base, pristineApp, server, signingKey, updatedApp,
      updateTarget: `darwin-${base.targetTriple.startsWith('aarch64') ? 'aarch64' : 'x86_64'}`,
    };
    if (!scenario.verifyUpdateUi) {
      await assertProductionRejectsInsecureUpdates(scenario);
      const fixture = await buildReleaseUpdateFixture(scenario);
      await rm(pristineApp, { force: true, recursive: true });
      await cloneApplication(fixture, pristineApp);
    }
    await assertSignedUpdateInstallsAndReportsHealthy(scenario);
    await assertStagedArtifactTamperRejected(scenario);
    await assertSignatureFailureKeepsRuntimeServing(scenario, {
      corruptArtifact: false,
      label: 'bad-signature',
    });
    console.log('Floway rejected the wrongly-signed update before installation, kept the gateway serving, and preserved the recovery point');
    await assertSignatureFailureKeepsRuntimeServing(scenario, {
      channel: 'preview',
      corruptArtifact: true,
      label: 'corrupt-artifact',
    });
    console.log('Floway rejected the corrupted update artifact before installation through the explicit preview channel and preserved the recovery point');
    await assertPostUpdateFailurePresentsRecovery(nativeWindowProbe, scenario, {
      expectedFragments: ['runtime resource is unavailable'],
      failureKind: 'asset',
      label: 'health-failure',
      tamper: tamperRemoveLazyDashboardAsset,
    });
    await assertPostUpdateFailurePresentsRecovery(nativeWindowProbe, scenario, {
      expectedLocale: 'zh-Hans',
      expectedFragments: ['could not apply its local database migrations'],
      failureKind: 'migration',
      label: 'migration-failure',
      tamper: tamperAddInvalidMigration,
    });
  }, 'Floway packaged update verification failed and fixture cleanup also failed');
};
