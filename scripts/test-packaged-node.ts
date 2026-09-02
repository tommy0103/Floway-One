import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(ROOT, 'scripts/generate-node-runtime.ts');

const fail = (message: string): never => {
  throw new Error(`packaged Node runtime: ${message}`);
};

const dockerfile = await readFile(resolve(ROOT, 'docker/Dockerfile'), 'utf8');
const expectedAssembly = 'RUN node --experimental-strip-types scripts/generate-node-runtime.ts /server';
if (!dockerfile.includes(expectedAssembly)) {
  fail(`the server deploy stage must execute ${JSON.stringify(expectedAssembly)}`);
}
const serverStageStart = dockerfile.indexOf('FROM runtime AS server\n');
if (serverStageStart === -1) fail('docker/Dockerfile has no final server stage');
const followingStages = dockerfile.slice(serverStageStart + 'FROM runtime AS server\n'.length);
const nextStage = followingStages.indexOf('\nFROM ');
const serverStage = nextStage === -1 ? followingStages : followingStages.slice(0, nextStage);
const expectedCopy = 'COPY --from=server-deploy /server /app';
if (!serverStage.includes(expectedCopy)) {
  fail(`the final server stage must contain ${JSON.stringify(expectedCopy)}`);
}
const commandSource = /^CMD\s+(\[[^\n]+\])$/m.exec(serverStage)?.[1]
  ?? fail('the final server stage has no JSON CMD');
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
const parseServerCommand = (source: string): string[] => {
  const value: unknown = JSON.parse(source);
  if (isStringArray(value) && value.length > 0) return value;
  return fail('the final server CMD must be a non-empty string array');
};
const serverCommand = parseServerCommand(commandSource);

const runtimeRoot = await mkdtemp(join(tmpdir(), 'floway-packaged-node-'));
const packageRoot = resolve(runtimeRoot, 'app');
let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

try {
  await execFileAsync(process.execPath, ['--experimental-strip-types', GENERATOR, packageRoot], { cwd: ROOT });

  await Promise.all([
    access(resolve(packageRoot, 'apps/platform-node/entry.ts')),
    access(resolve(packageRoot, 'apps/platform-node/node_modules/@floway-dev/gateway')),
    access(resolve(packageRoot, 'apps/web/dist/client/index.html')),
    access(resolve(packageRoot, 'apps/web/dist/client/dashboard-routes.json')),
  ]);
  try {
    await access(resolve(packageRoot, 'apps/platform-node/node_modules/@floway-dev/test-utils'));
    fail('the isolated runtime contains a development-only dependency');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const runningChild = spawn(serverCommand[0]!, serverCommand.slice(1), {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY: 'packaged-layout-test',
      FLOWAY_DB_PATH: resolve(runtimeRoot, 'floway.db'),
      FLOWAY_FILES_DIR: resolve(runtimeRoot, 'files'),
      NODE_ENV: 'production',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = runningChild;

  let output = '';
  runningChild.stdout.setEncoding('utf8');
  runningChild.stderr.setEncoding('utf8');
  runningChild.stdout.on('data', chunk => { output += chunk; });
  runningChild.stderr.on('data', chunk => { output += chunk; });

  const readyPort = await new Promise<number>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`startup timed out\n${output}`)), 10_000);
    const inspect = () => {
      const port = /Floway listening on http:\/\/localhost:(\d+)/.exec(output)?.[1];
      if (port === undefined) return;
      clearTimeout(timeout);
      resolveReady(Number(port));
    };
    runningChild.stdout.on('data', inspect);
    runningChild.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`server exited before startup (${code ?? signal})\n${output}`));
    });
    runningChild.once('error', error => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });

  const origin = `http://127.0.0.1:${readyPort}`;
  const documentResponse = await fetch(origin);
  if (!documentResponse.ok) fail(`Dashboard document returned ${documentResponse.status}`);
  if (documentResponse.headers.get('cache-control') !== 'no-cache') fail('Dashboard document is not revalidated');

  const document = await documentResponse.text();
  const assetPath = /(?:href|src)="(\/assets\/[^"]+)"/.exec(document)?.[1]
    ?? fail('Dashboard document names no hashed asset');
  const assetResponse = await fetch(`${origin}${assetPath}`);
  if (!assetResponse.ok) fail(`Dashboard asset returned ${assetResponse.status}`);
  if (assetResponse.headers.get('cache-control') !== 'public, max-age=31536000, immutable') {
    fail('Dashboard asset is not immutable');
  }
  const assetContentType = assetResponse.headers.get('content-type');
  if (assetContentType === null || assetContentType === 'application/octet-stream') {
    fail('Dashboard asset has no specific MIME type');
  }

  const healthResponse = await fetch(`${origin}/api/health`);
  if (!healthResponse.ok) fail(`gateway health returned ${healthResponse.status}`);

  for (const path of ['/dashboard/settings', '/dashboard/providers/upstreams/up_test']) {
    const response = await fetch(`${origin}${path}`);
    if (!response.ok || response.headers.get('content-type') !== 'text/html; charset=utf-8') {
      fail(`declared Dashboard route ${path} did not receive the SPA document`);
    }
  }

  for (const path of ['/login', '/dashboard/not-a-route']) {
    const response = await fetch(`${origin}${path}`);
    if (response.status !== 404) fail(`undeclared path ${path} returned ${response.status}`);
  }
} finally {
  const runningChild = child;
  if (runningChild?.exitCode === null && runningChild.signalCode === null) {
    const exited = once(runningChild, 'exit');
    runningChild.kill('SIGTERM');
    await exited;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log('Packaged Node runtime executes its production CMD with the Dashboard and gateway on one origin');
