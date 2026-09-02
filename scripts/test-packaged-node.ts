import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createOperatingSystemCredential,
  type DeviceMasterKeyCredential,
} from '../apps/platform-node/src/device-master-key.ts';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(ROOT, 'scripts/generate-node-runtime.ts');
const ADMIN_KEY = 'packaged-layout-test';
const PERSONAL_SECRET = `packaged-personal-secret-${randomUUID()}`;

const fail = (message: string): never => {
  throw new Error(`packaged Node runtime: ${message}`);
};

const requireString = (value: unknown, message: string): string =>
  typeof value === 'string' ? value : fail(message);

const errorChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join('\ncaused by: ');
};

const readCredential = async (credential: DeviceMasterKeyCredential): Promise<Uint8Array | null> => {
  const stored = await credential.getSecret();
  return stored === null ? null : Uint8Array.from(stored);
};

const deleteCredential = async (credential: DeviceMasterKeyCredential): Promise<void> => {
  const deleteSecret = credential.deleteSecret
    ?? fail('the system credential adapter cannot delete its test entry');
  await deleteSecret();
};

const exerciseIsolatedCredentialStore = async (): Promise<boolean> => {
  const service = `Floway packaged credential verification ${randomUUID()}`;
  const account = `test-${randomUUID()}`;
  let credential: DeviceMasterKeyCredential;
  try {
    credential = createOperatingSystemCredential(service, account);
    const expected = randomBytes(32);
    await credential.setSecret(expected);
    const loaded = await readCredential(credential);
    if (loaded === null || !Buffer.from(loaded).equals(expected)) fail('system credential set/get changed the test secret');
    await deleteCredential(credential);
    if (await readCredential(credential) !== null) fail('system credential delete left the test secret readable');
    return true;
  } catch (error) {
    if (process.platform === 'linux' && errorChain(error).includes('Linux Secret Service is unavailable')) {
      console.log(`Linux Secret Service unavailable; successful personal-store smoke is not runnable on this host: ${errorChain(error)}`);
      return false;
    }
    throw error;
  }
};

const dockerfile = (await readFile(resolve(ROOT, 'docker/Dockerfile'), 'utf8')).replaceAll('\r\n', '\n');
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

const runtimeParent = process.platform === 'win32' ? resolve(ROOT, '.tmp') : tmpdir();
await mkdir(runtimeParent, { recursive: true });
const runtimeRoot = await mkdtemp(join(runtimeParent, 'floway-packaged-node-'));
const packageRoot = resolve(runtimeRoot, 'app');
const children = new Set<ChildProcessByStdio<null, Readable, Readable>>();

const stopRuntime = async (child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> => {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};

const startRuntime = async (
  databasePath: string,
  profile: 'server' | 'personal',
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; origin: string; output: () => string }> => {
  const child = spawn(serverCommand[0]!, [...serverCommand.slice(1), ...(profile === 'personal' ? ['--profile=personal'] : [])], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY,
      FLOWAY_DB_PATH: databasePath,
      FLOWAY_FILES_DIR: resolve(runtimeRoot, `${profile}-files`),
      NODE_ENV: 'production',
      PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);

  let combinedOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { combinedOutput += chunk; });
  child.stderr.on('data', chunk => { combinedOutput += chunk; });

  const readyPort = await new Promise<number>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`startup timed out\n${combinedOutput}`)), 10_000);
    const inspect = () => {
      const port = /Floway listening on http:\/\/localhost:(\d+)/.exec(combinedOutput)?.[1];
      if (port === undefined) return;
      clearTimeout(timeout);
      resolveReady(Number(port));
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`server exited before startup (${code ?? signal})\n${combinedOutput}`));
    });
    child.once('error', error => {
      clearTimeout(timeout);
      rejectReady(error);
    });
  });
  return {
    child,
    origin: `http://127.0.0.1:${readyPort}`,
    output: () => combinedOutput,
  };
};

const assertServerSurface = async (origin: string): Promise<void> => {
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
};

const persistPersonalSecret = async (origin: string): Promise<void> => {
  const login = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: ADMIN_KEY }),
  });
  if (!login.ok) fail(`personal admin login returned ${login.status}`);
  const loginBody = await login.json() as { token?: unknown };
  const sessionToken = requireString(loginBody.token, 'personal admin login returned no session token');

  const response = await fetch(`${origin}/api/search-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionToken },
    body: JSON.stringify({
      provider: 'tavily',
      tavily: { apiKey: PERSONAL_SECRET },
      microsoftWebIq: { apiKey: '' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
  });
  if (!response.ok) fail(`personal search credential update returned ${response.status}: ${await response.text()}`);
};

const assertCiphertextAtRest = (databasePath: string): void => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT tavily_api_key FROM search_config WHERE id = 1').get() as { tavily_api_key?: unknown } | undefined;
    const stored = requireString(row?.tavily_api_key, 'personal database contains no Tavily credential');
    if (stored.includes(PERSONAL_SECRET)) fail('personal database exposes the provider credential as plaintext');
    const parsed = JSON.parse(stored) as { $flowayEncrypted?: { version?: unknown } };
    if (parsed.$flowayEncrypted?.version !== 1) fail('personal database credential is not a version 1 encrypted envelope');
  } finally {
    database.close();
  }
};

const assertUnavailableLinuxPersonalStartup = async (): Promise<void> => {
  if (process.platform !== 'linux') return;
  const child = spawn(serverCommand[0]!, [...serverCommand.slice(1), '--profile=personal'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/floway-verification/missing-session-bus',
      FLOWAY_DB_PATH: resolve(runtimeRoot, 'unavailable-secret-service.db'),
      FLOWAY_FILES_DIR: resolve(runtimeRoot, 'unavailable-secret-service-files'),
      NODE_ENV: 'production',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  children.delete(child);
  if (code === 0) fail('personal runtime accepted an unavailable Linux Secret Service');
  if (!output.includes('Failed to read the Floway One device master key from the operating system credential store')
    || !output.includes('Linux Secret Service is unavailable for the Floway One device master key')) {
    fail(`personal runtime lost the unavailable Linux Secret Service error chain\n${output}`);
  }
};

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

  const server = await startRuntime(resolve(runtimeRoot, 'server.db'), 'server');
  await assertServerSurface(server.origin);
  await stopRuntime(server.child);

  const systemStoreAvailable = await exerciseIsolatedCredentialStore();
  if (systemStoreAvailable) {
    const productionCredential = createOperatingSystemCredential();
    const existingMasterKey = await readCredential(productionCredential);
    try {
      const personalDatabase = resolve(runtimeRoot, 'personal.db');
      const personal = await startRuntime(personalDatabase, 'personal');
      await persistPersonalSecret(personal.origin);
      await stopRuntime(personal.child);
      const storedMasterKey = await readCredential(productionCredential);
      if (storedMasterKey?.byteLength !== 32) fail('personal runtime did not persist a 256-bit key in the system credential store');
      assertCiphertextAtRest(personalDatabase);
    } finally {
      if (existingMasterKey === null) await deleteCredential(productionCredential);
    }
  }

  await assertUnavailableLinuxPersonalStartup();
} finally {
  await Promise.all([...children].map(stopRuntime));
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log('Packaged Node runtime verified server compatibility, platform credential storage, and personal ciphertext at rest where supported');
