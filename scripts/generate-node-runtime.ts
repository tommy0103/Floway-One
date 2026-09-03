import { spawn } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv[2];
const optionArguments = process.argv.slice(3);
const layoutArgument = optionArguments.find(argument => argument === '--node-linker=hoisted');
const targetPlatform = optionArguments.find(argument => argument.startsWith('--target-platform='))?.slice('--target-platform='.length);
const targetArchitecture = optionArguments.find(argument => argument.startsWith('--target-architecture='))?.slice('--target-architecture='.length);
const knownOptions = optionArguments.filter(argument =>
  argument === '--node-linker=hoisted'
  || argument.startsWith('--target-platform=')
  || argument.startsWith('--target-architecture='));
if (
  outputArgument === undefined
  || knownOptions.length !== optionArguments.length
  || (targetPlatform === undefined) !== (targetArchitecture === undefined)
  || (targetPlatform !== undefined && targetPlatform !== 'darwin')
  || (targetArchitecture !== undefined && targetArchitecture !== 'arm64' && targetArchitecture !== 'x64')
) {
  throw new Error(
    'Usage: generate-node-runtime.ts <output-directory> [--node-linker=hoisted] [--target-platform=darwin --target-architecture=arm64|x64]',
  );
}

const outputRoot = resolve(outputArgument);
const platformNodeRoot = resolve(outputRoot, 'apps/platform-node');
const dashboardRoot = resolve(outputRoot, 'apps/web/dist/client');

try {
  await mkdir(outputRoot);
  await mkdir(resolve(outputRoot, 'apps'));
} catch (cause) {
  throw new Error(`Node runtime output must be a new directory: ${outputRoot}`, { cause });
}

try {
  await new Promise<void>((resolveRun, rejectRun) => {
    const windows = process.platform === 'win32';
    // A .cmd file is not executable by itself on Windows. Node documents
    // shell-backed spawn as the supported launch path:
    // https://nodejs.org/docs/latest-v22.x/api/child_process.html#spawning-bat-and-cmd-files-on-windows
    const deployTarget = windows ? relative(ROOT, platformNodeRoot) : platformNodeRoot;
    // Legacy deploy deliberately disables lockfile use for a hoisted linker.
    // The desktop path instead uses pnpm's modern, injected-workspace deploy,
    // which creates a dedicated frozen lockfile and physical dependencies.
    // https://github.com/pnpm/pnpm/blob/bcc678c257797bdca86db4d535fd9d9614b2197c/pnpm11/releasing/commands/src/deploy/deploy.ts#L209-L214
    // pnpm 10.24 maps --os/--cpu to its supported-architecture authority.
    // https://github.com/pnpm/pnpm/blob/16d08d0cb076a3d2e1fe75f558c08059b17dadd9/config/config/src/overrideSupportedArchitecturesWithCLI.ts#L3-L22
    const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', [
      ...(layoutArgument === '--node-linker=hoisted' ? ['--config.node-linker=hoisted'] : []),
      ...(targetPlatform === undefined ? [] : [`--os=${targetPlatform}`, `--cpu=${targetArchitecture}`]),
      '--filter',
      '@floway-dev/platform-node',
      'deploy',
      '--prod',
      ...(layoutArgument === undefined ? ['--legacy'] : []),
      '--ignore-scripts',
      deployTarget,
    ], { cwd: ROOT, env: process.env, shell: windows, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`pnpm deploy exited with ${code ?? signal}`));
    });
  });
} catch (cause) {
  throw new Error('Failed to deploy the production Node runtime', { cause });
}

try {
  await mkdir(dirname(dashboardRoot), { recursive: true });
  await cp(resolve(ROOT, 'apps/web/dist/client'), dashboardRoot, { recursive: true, errorOnExist: true });
  await cp(resolve(ROOT, 'LICENSE'), resolve(outputRoot, 'LICENSE'), { errorOnExist: true });
} catch (cause) {
  throw new Error('Failed to package the production Dashboard assets', { cause });
}
