import { execFile } from 'node:child_process';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileArguments = process.argv.slice(2).filter(argument => argument !== '--');
if (profileArguments.length > 1) {
  throw new Error('Usage: packaged-desktop-verifier.ts [--profile=debug|--profile=release]');
}
const profileArgument = profileArguments[0];
const profile = profileArgument === undefined
  ? 'release'
  : /^--profile=(debug|release)$/.exec(profileArgument)?.[1];
if (profile === undefined) throw new Error('Usage: packaged-desktop-verifier.ts [--profile=debug|--profile=release]');
if (process.platform !== 'darwin') {
  throw new Error('The exploded packaged-desktop verifier currently requires a macOS .app bundle');
}

const appRoot = resolve(desktopRoot, `src-tauri/target/${profile}/bundle/macos/Floway One.app`);
const nodeExecutable = resolve(appRoot, 'Contents/MacOS/floway-node');
const runtimeRoot = resolve(appRoot, 'Contents/Resources/runtime');
const platformNodeRoot = resolve(runtimeRoot, 'apps/platform-node');

await Promise.all([
  access(resolve(appRoot, 'Contents/MacOS/floway-one')),
  access(nodeExecutable),
  access(resolve(platformNodeRoot, 'entry.js')),
  access(resolve(platformNodeRoot, 'node_modules/@floway-dev/gateway/migrations/0084_protected_search_secret_columns.sql')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/index.html')),
  access(resolve(runtimeRoot, 'apps/web/dist/client/dashboard-routes.json')),
]);

const version = (await execFileAsync(nodeExecutable, ['--version'])).stdout.trim();
if (version !== 'v24.19.0') throw new Error(`Packaged desktop Node version is ${version}, expected v24.19.0`);

const probe = await execFileAsync(nodeExecutable, [
  '--input-type=module',
  '--eval',
  "await import('@floway-dev/gateway'); await import('./entry.js'); console.log('embedded runtime imports resolved');",
], { cwd: platformNodeRoot });
if (probe.stdout.trim() !== 'embedded runtime imports resolved') {
  throw new Error(`Packaged desktop import probe returned unexpected output: ${JSON.stringify(probe.stdout)}`);
}

const dependenciesRoot = resolve(platformNodeRoot, 'node_modules');
const pending = [dependenciesRoot];
const nativeModules: string[] = [];
while (pending.length > 0) {
  const directory = pending.pop()!;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Packaged desktop app retained an unresolved dependency symlink: ${path}`);
    }
    if (entry.isDirectory()) pending.push(path);
    else if (entry.isFile() && entry.name.endsWith('.node')) nativeModules.push(path);
  }
}
if (!nativeModules.some(path => path.includes('sharp'))) {
  throw new Error('Packaged desktop app does not contain the target sharp native module');
}
if (!nativeModules.some(path => path.includes('keyring'))) {
  throw new Error('Packaged desktop app does not contain the target operating-system Keyring native module');
}

const packagedLock = await readFile(resolve(platformNodeRoot, 'pnpm-lock.yaml'), 'utf8');
const rootLock = await readFile(resolve(desktopRoot, '../../pnpm-lock.yaml'), 'utf8');
for (const [name, versionPattern] of [
  ['@hono/node-server', '2.0.4'],
  ['@napi-rs/keyring', '2.0.0'],
  ['sharp', '0.35.3'],
  ['tsx', '4.22.4'],
  ['undici', '8.3.0'],
  ['ws', '8.18.0'],
] as const) {
  const manifest = JSON.parse(
    await readFile(resolve(dependenciesRoot, name, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (manifest.version !== versionPattern) {
    throw new Error(`Packaged desktop dependency ${name} is ${String(manifest.version)}, expected ${versionPattern}`);
  }
  if (!packagedLock.includes(`version: ${versionPattern}`) || !rootLock.includes(`version: ${versionPattern}`)) {
    throw new Error(`Packaged desktop dependency ${name} did not retain locked version ${versionPattern}`);
  }
}

console.log('Packaged Floway desktop app verified embedded Node, runnable compiled gateway, locked dependencies, migrations, native modules, and Dashboard assets');
