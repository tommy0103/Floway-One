import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { deferDisposableDesktopPaths, removeDisposableDesktopPaths } from './desktop-verification.ts';
import { withFailureSafeCleanup } from './failure-chain.ts';
import { acquireNodeDistribution } from './node-distribution.ts';
import {
  architectureForTargetTriple,
  MACOS_TARGET_TRIPLES,
  readPackagedNodeVersion,
} from './release-contract.ts';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const desktopRoot = resolve(root, 'apps/desktop');
const pnpmCli = process.env.npm_execpath;
if (pnpmCli === undefined) throw new Error('Desktop verifier requires pnpm to provide npm_execpath');

const runPnpm = async (args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> => {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [pnpmCli, ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', cause => rejectRun(new Error(`Failed to start pnpm ${args.join(' ')}`, { cause })));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`pnpm ${args.join(' ')} exited with ${code ?? signal ?? 'an unknown status'}`));
    });
  });
};

const packagedNodeVersion = await readPackagedNodeVersion(desktopRoot);
if (process.versions.node !== packagedNodeVersion) {
  throw new Error(`Desktop verifier requires Node.js ${packagedNodeVersion}; received ${process.versions.node}`);
}
const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
  packageManager?: unknown;
};
const requiredPnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(String(rootManifest.packageManager))?.[1];
if (requiredPnpm === undefined) throw new Error('Root packageManager must pin an exact pnpm version');

let actualPnpm = '';
await new Promise<void>((resolveVersion, rejectVersion) => {
  const child = spawn(process.execPath, [pnpmCli, '--version'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { actualPnpm += chunk; });
  child.once('error', rejectVersion);
  child.once('exit', code => code === 0 ? resolveVersion() : rejectVersion(new Error(`pnpm --version exited with ${code}`)));
});
if (actualPnpm.trim() !== requiredPnpm) {
  throw new Error(`Desktop verifier requires pnpm ${requiredPnpm}; received ${actualPnpm.trim()}`);
}
if (process.platform !== 'darwin') {
  throw new Error('Desktop application packaging verification requires a native macOS runner');
}

const generatedPaths = [
  resolve(desktopRoot, 'src-tauri/target'),
  resolve(desktopRoot, 'src-tauri/bundle-inputs'),
  resolve(desktopRoot, 'src-tauri/.bundle-staging'),
  resolve(desktopRoot, 'src-tauri/.desktop-verification'),
  resolve(desktopRoot, 'src-tauri/gen'),
];
const generatedDesktopOutputs = generatedPaths.map(path => ({
  label: `generated desktop output ${path}`,
  path,
}));

const canExecuteNode = async (path: string): Promise<boolean> => {
  try {
    return (await execFileAsync(path, ['--version'])).stdout.trim() === `v${packagedNodeVersion}`;
  } catch {
    return false;
  }
};

await withFailureSafeCleanup(async cleanup => {
  deferDisposableDesktopPaths(cleanup, generatedDesktopOutputs);
  await removeDisposableDesktopPaths(generatedDesktopOutputs);
  await runPnpm(['--filter', '@floway-dev/desktop', 'run', 'test:rust']);
  await removeDisposableDesktopPaths([{
    label: 'no-default-feature Rust target output',
    path: resolve(desktopRoot, 'src-tauri/target'),
  }]);
  await runPnpm(['run', 'build:web']);
  for (const targetTriple of MACOS_TARGET_TRIPLES) {
    const distributionRoot = resolve(desktopRoot, 'src-tauri/.desktop-verification', targetTriple);
    const targetOutput = resolve(desktopRoot, 'src-tauri/target', targetTriple);
    await withFailureSafeCleanup(async targetCleanup => {
      deferDisposableDesktopPaths(targetCleanup, [
        { label: `target output ${targetTriple}`, path: targetOutput },
        { label: `Node distribution ${targetTriple}`, path: distributionRoot },
      ]);
      const nodeExecutable = await acquireNodeDistribution(packagedNodeVersion, targetTriple, distributionRoot);
      const targetArchitecture = architectureForTargetTriple(targetTriple);
      const launch = process.arch === targetArchitecture;
      if (launch && !(await canExecuteNode(nodeExecutable))) {
        throw new Error(`Floway desktop verifier could not execute native ${targetArchitecture} Node.js ${packagedNodeVersion}`);
      }
      console.log(
        `Floway desktop verifier target ${targetTriple} (${targetArchitecture}) on ${process.arch}: ${launch ? 'launch' : 'static inspection'}`,
      );
      const environment = {
        ...process.env,
        CARGO_BUILD_JOBS: '1',
        CARGO_INCREMENTAL: '0',
        CARGO_PROFILE_DEV_CODEGEN_UNITS: '1',
        CARGO_PROFILE_DEV_DEBUG: '0',
        FLOWAY_DESKTOP_EXECUTE_NODE: launch ? '1' : '0',
        FLOWAY_DESKTOP_NODE_EXECUTABLE: nodeExecutable,
      };
      await runPnpm([
        '--filter',
        '@floway-dev/desktop',
        'exec',
        'tauri',
        'build',
        '--debug',
        '--bundles',
        'app',
        '--target',
        targetTriple,
      ], environment);
      await runPnpm([
        '--filter',
        '@floway-dev/desktop',
        'run',
        'test:packaged:macos',
        '--',
        '--profile=debug',
        `--target=${targetTriple}`,
        `--launch=${launch ? 'yes' : 'no'}`,
      ], environment);
    }, `Floway ${targetTriple} desktop verification failed and target cleanup also failed`);
  }
}, 'Floway desktop verification failed and generated-output cleanup also failed');
