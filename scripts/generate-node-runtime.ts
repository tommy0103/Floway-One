import { spawn } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv[2];
if (outputArgument === undefined) throw new Error('Usage: generate-node-runtime.ts <output-directory>');

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
    const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', [
      '--filter',
      '@floway-dev/platform-node',
      'deploy',
      '--prod',
      '--legacy',
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
