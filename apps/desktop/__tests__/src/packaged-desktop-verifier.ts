import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInstalledAppVerificationContext } from './support/installed-app.ts';
import { verifyPackagedApplication } from './support/package-contract.ts';
import {
  assertPersonalRuntime,
  assertUnexpectedSidecarExitClosesShell,
  errorChainIncludes,
  PERSONAL_FAILURE_PHASES,
  personalEntrySource,
  type CredentialIdentity,
} from './support/personal-runtime.ts';
import {
  appEnvironmentWithoutPortOverride,
  assertLoopbackPortReleased,
  captureApp,
  observeProductionApp,
  observeSetupFailureWithoutSidecar,
  PERSONAL_DASHBOARD_PORT,
  processIsRunning,
  reserveNonDefaultLoopbackPort,
  terminateProcessGroup,
  waitForDirectChild,
  waitForOutput,
} from './support/process-lifecycle.ts';
import { withFailureSafeCleanup } from '../../src/failure-chain.ts';
import { machOCpuTypeForArchitecture, type MachOArchitecture } from '../../src/mach-o.ts';
import {
  architectureForTargetTriple,
  MACOS_TARGET_TRIPLES,
  type DesktopTargetTriple,
} from '../../src/release-contract.ts';

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
if (process.platform !== 'darwin') {
  throw new Error('The exploded packaged-desktop verifier requires a native macOS .app bundle');
}

const targetTriple = targetArgument as DesktopTargetTriple;
const buildProfile = profile as 'debug' | 'release';
const launchSupported = launchArgument === 'yes';
const expectedArchitecture = architectureForTargetTriple(targetTriple);
const packaged = await verifyPackagedApplication({
  desktopRoot,
  launchSupported,
  profile: buildProfile,
  repositoryRoot,
  targetTriple,
});

// Tauri rejects a starting executable with a symlink in any macOS path ancestor;
// canonicalize the system temp root before the direct executable launch.
// https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/crates/tauri-utils/src/platform/starting_binary.rs#L61-L75
if (launchSupported) {
  if (packaged.loadedKeyringNative === undefined) {
    throw new Error('Native launch verification requires the exact loaded Keyring binding');
  }
  const isolatedRoot = await mkdtemp(join(await realpath(tmpdir()), 'floway-desktop-installed-'));
  await withFailureSafeCleanup(async cleanup => {
    cleanup.defer('isolated installed application root', async () => await rm(isolatedRoot, { force: true, recursive: true }));
    const installedApp = resolve(isolatedRoot, 'Applications/Floway.app');
    await mkdir(dirname(installedApp), { recursive: true });
    await rename(packaged.appRoot, installedApp);
    const context = await createInstalledAppVerificationContext(
      installedApp,
      relative(packaged.appRoot, packaged.loadedKeyringNative!),
      packaged.migrationNames,
    );
    const productionEntry = await readFile(context.entry, 'utf8');
    const productionContract = await readFile(context.contract, 'utf8');
    cleanup.defer('production runtime entry restoration', async () => await writeFile(context.entry, productionEntry));
    cleanup.defer('production bundle contract restoration', async () => await writeFile(context.contract, productionContract));

    const customPort = await reserveNonDefaultLoopbackPort();
    await assertPersonalRuntime(
      context,
      resolve(isolatedRoot, 'PersonalData-persisted-port'),
      { port: customPort, seedPersistedPort: true },
    );
    console.log(`Floway production app preserved runtime.json unchanged and loaded persisted personal endpoint http://127.0.0.1:${customPort}`);

    await assertPersonalRuntime(
      context,
      resolve(isolatedRoot, 'PersonalData-success'),
      { requestApplicationExit: true },
    );
    console.log('Floway production app completed the canonical migration set, Dashboard bootstrap exchange, authenticated control plane, health, assets, credential, and failure-safe cleanup');
    console.log('Floway normal Tauri application exit terminated and waited for its packaged runtime with no sidecar, listener, credential, or data root remaining');

    await assertUnexpectedSidecarExitClosesShell(
      context,
      resolve(isolatedRoot, 'PersonalData-unexpected-sidecar-exit'),
    );
    console.log('Floway production shell surfaced the original sidecar failure, exited non-zero, and left no listener or process');

    for (const phase of PERSONAL_FAILURE_PHASES) {
      const verificationRoot = resolve(isolatedRoot, `PersonalData-fault-${phase}`);
      try {
        await assertPersonalRuntime(context, verificationRoot, { forcedFailure: phase });
        throw new Error(`Expected forced personal runtime ${phase} phase failure`);
      } catch (error) {
        if (!errorChainIncludes(error, `forced personal runtime ${phase} phase failure`)) throw error;
      }
      console.log(`Floway personal ${phase} fault left no app, sidecar, listener, credential, or data root`);
    }

    await writeFile(context.entry, productionEntry);
    const lazyDashboardAsset = packaged.dashboardAssets.find(asset => asset.path.startsWith('assets/'));
    if (lazyDashboardAsset === undefined) throw new Error('Packaged Dashboard contract names no lazy production asset');
    const installedLazyAsset = resolve(installedApp, 'Contents/Resources/runtime/apps/web/dist/client', lazyDashboardAsset.path);
    await withFailureSafeCleanup(async faultCleanup => {
      const missingLazyAsset = `${installedLazyAsset}.missing`;
      await rename(installedLazyAsset, missingLazyAsset);
      faultCleanup.defer('missing lazy Dashboard asset restoration', async () => await rename(missingLazyAsset, installedLazyAsset));
      await observeSetupFailureWithoutSidecar(context.executable, [
        'Floway desktop runtime resource is unavailable',
        lazyDashboardAsset.path,
        'No such file',
      ]);
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    });
    console.log(`Floway production preflight rejected missing lazy Dashboard asset ${lazyDashboardAsset.path} without spawning a sidecar`);

    await withFailureSafeCleanup(async faultCleanup => {
      faultCleanup.defer('stale bundle contract restoration', async () => await writeFile(context.contract, productionContract));
      const staleContract = JSON.parse(productionContract) as { dashboard: { assets: Array<{ path: string; sha256: string }> } };
      const staleAsset = staleContract.dashboard.assets.find(asset => asset.path === lazyDashboardAsset.path);
      if (staleAsset === undefined) throw new Error('Stale-contract probe could not find its Dashboard asset');
      staleAsset.sha256 = '0'.repeat(64);
      await writeFile(context.contract, `${JSON.stringify(staleContract, undefined, 2)}\n`);
      await observeSetupFailureWithoutSidecar(context.executable, ['Dashboard asset digest is stale', lazyDashboardAsset.path]);
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    });
    console.log('Floway production preflight rejected a stale Dashboard contract without spawning a sidecar');

    const independentMigrations = context.migrationNames.filter(name => name !== '0084_protected_search_secret_columns.sql');
    const [missingMigrationName, modifiedMigrationName] = independentMigrations;
    if (missingMigrationName === undefined || modifiedMigrationName === undefined) {
      throw new Error('Packaged migration contract needs two independent non-0084 migrations for fault verification');
    }
    const installedMissingMigration = resolve(context.migrations, missingMigrationName);
    await withFailureSafeCleanup(async faultCleanup => {
      const renamedMigration = `${installedMissingMigration}.missing`;
      await rename(installedMissingMigration, renamedMigration);
      faultCleanup.defer('missing migration restoration', async () => await rename(renamedMigration, installedMissingMigration));
      await observeSetupFailureWithoutSidecar(context.executable, [
        'Floway desktop runtime resource is unavailable',
        missingMigrationName,
        'No such file',
      ]);
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    });
    console.log(`Floway production preflight rejected missing independent migration ${missingMigrationName} without spawning a sidecar`);

    const installedModifiedMigration = resolve(context.migrations, modifiedMigrationName);
    await withFailureSafeCleanup(async faultCleanup => {
      const originalMigration = await readFile(installedModifiedMigration);
      faultCleanup.defer('modified migration restoration', async () => await writeFile(installedModifiedMigration, originalMigration));
      await writeFile(installedModifiedMigration, Buffer.concat([originalMigration, Buffer.from('\n-- tampered\n')]));
      await observeSetupFailureWithoutSidecar(context.executable, ['migration file digest is stale', modifiedMigrationName]);
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
    });
    console.log(`Floway production preflight rejected modified independent migration ${modifiedMigrationName} without spawning a sidecar`);

    const missingEntry = `${context.entry}.missing`;
    await withFailureSafeCleanup(async faultCleanup => {
      await rename(context.entry, missingEntry);
      faultCleanup.defer('missing-entry fault restoration', async () => await rename(missingEntry, context.entry));
      await observeProductionApp(context.executable, ['Floway desktop runtime resource is unavailable', 'entry.js']);
    });

    await writeFile(context.entry, 'setInterval(() => {}, 60_000);\n');
    const blockingFailure = new Error('forced verifier failure with live packaged sidecar');
    try {
      await withFailureSafeCleanup(async blockingCleanup => {
        const { child } = captureApp(context.executable, process.env);
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
      const credentialIdentity: CredentialIdentity = {
        service: `Floway desktop package verification ${randomUUID()}`,
        account: `device-master-key-${randomUUID()}`,
      };
      await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT);
      await mkdir(verificationRoot, { recursive: true });
      faultCleanup.defer('Keyring-fault application data', async () => await rm(verificationRoot, { force: true, recursive: true }));
      faultCleanup.defer('Keyring-fault listener', async () => await assertLoopbackPortReleased(PERSONAL_DASHBOARD_PORT));
      await writeFile(context.entry, personalEntrySource(verificationRoot, credentialIdentity));
      const keyringFile = await open(context.keyringNative, 'r+');
      faultCleanup.defer('exact loaded Keyring binding file handle', async () => await keyringFile.close());
      const originalKeyringHeader = Buffer.alloc(8);
      await keyringFile.read(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
      faultCleanup.defer('exact loaded Keyring binding restoration', async () => {
        await keyringFile.write(originalKeyringHeader, 0, originalKeyringHeader.byteLength, 0);
        await keyringFile.sync();
      });
      await keyringFile.write(Buffer.alloc(originalKeyringHeader.byteLength), 0, originalKeyringHeader.byteLength, 0);
      await keyringFile.sync();
      const { child, output } = captureApp(context.executable, appEnvironmentWithoutPortOverride());
      faultCleanup.defer('Keyring-fault application process group', async () => await terminateProcessGroup(child));
      await waitForOutput(child, output, ['Floway runtime exit']);
    });
    console.log(`Floway corrupted the exact loaded Keyring binding and observed packaged sidecar failure: ${context.keyringNative}`);

    await writeFile(context.entry, productionEntry);
    await withFailureSafeCleanup(async faultCleanup => {
      const nodeFile = await open(context.node, 'r+');
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
      // https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/errno.h#L226-L230
      // https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/errlst.c#L165-L168
      await observeProductionApp(context.executable, ['Bad CPU type in executable (os error 86)']);
    });
  });
}

console.log(
  launchSupported
    ? `Packaged Floway desktop app ${targetTriple} verified thin architecture, canonical migrations, embedded Node/Keyring/gateway, locked dependencies, production app launch/fault chains, failure-safe cleanup, secure Dashboard bootstrap/control-plane, native sharp, and assets`
    : `Packaged Floway desktop app ${targetTriple} passed static thin architecture, canonical-migration, locked-dependency, native-module, and Dashboard verification; this host cannot execute that target`,
);
