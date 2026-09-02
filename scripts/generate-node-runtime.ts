import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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
  await execFileAsync('pnpm', [
    '--filter',
    '@floway-dev/platform-node',
    'deploy',
    '--prod',
    '--legacy',
    '--ignore-scripts',
    platformNodeRoot,
  ], { cwd: ROOT });
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
