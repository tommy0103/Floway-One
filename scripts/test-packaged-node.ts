import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_ROOT = resolve(ROOT, 'apps/web/dist/client');
const TSX_LOADER = pathToFileURL(resolve(ROOT, 'apps/platform-node/node_modules/tsx/dist/loader.mjs')).href;
const EXPECTED_DASHBOARD_COPY = 'COPY --from=web-build /app/apps/web/dist/client /app/apps/web/dist/client';

const fail = (message: string): never => {
  throw new Error(`packaged Node runtime: ${message}`);
};

const dockerfile = await readFile(resolve(ROOT, 'docker/Dockerfile'), 'utf8');
const serverStageStart = dockerfile.indexOf('FROM base AS server\n');
if (serverStageStart === -1) fail('docker/Dockerfile has no server stage');
const webBuildStage = dockerfile.indexOf(' AS web-build\n');
if (webBuildStage === -1 || webBuildStage > serverStageStart) {
  fail('the web-build stage must precede the server stage that copies from it');
}
const followingStages = dockerfile.slice(serverStageStart + 'FROM base AS server\n'.length);
const nextStage = followingStages.indexOf('\nFROM ');
const serverStage = nextStage === -1 ? followingStages : followingStages.slice(0, nextStage);
if (!serverStage.includes(EXPECTED_DASHBOARD_COPY)) {
  fail(`the server stage must contain ${JSON.stringify(EXPECTED_DASHBOARD_COPY)}`);
}

await Promise.all([
  readFile(resolve(DASHBOARD_ROOT, 'index.html')),
  readFile(resolve(DASHBOARD_ROOT, 'dashboard-routes.json')),
]);

const runtimeRoot = await mkdtemp(join(tmpdir(), 'floway-packaged-node-'));
const child = spawn(process.execPath, ['--import', TSX_LOADER, 'apps/platform-node/entry.ts'], {
  cwd: ROOT,
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

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

try {
  const readyPort = await new Promise<number>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`startup timed out\n${output}`)), 10_000);
    const inspect = () => {
      const port = /Floway listening on http:\/\/localhost:(\d+)/.exec(output)?.[1];
      if (port === undefined) return;
      clearTimeout(timeout);
      resolveReady(Number(port));
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`server exited before startup (${code ?? signal})\n${output}`));
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
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log('Packaged Node runtime serves the production Dashboard and gateway from one origin');
