import { execFile, spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
const REQUIRE_CREDENTIAL_STORE = process.env.FLOWAY_REQUIRE_CREDENTIAL_STORE === '1';
const START_LINUX_SECRET_SERVICE = process.env.FLOWAY_START_TEST_SECRET_SERVICE === '1';

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
      if (REQUIRE_CREDENTIAL_STORE) {
        fail(`this runner requires a working Linux Secret Service\n${errorChain(error)}`);
      }
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
const serviceChildren = new Set<ChildProcess>();

const terminateChild = async (child: ChildProcess): Promise<void> => {
  serviceChildren.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};

const waitForLine = async (child: ChildProcessWithoutNullStreams, stream: Readable): Promise<string> => await new Promise((resolveLine, rejectLine) => {
  let output = '';
  let errors = '';
  const timeout = setTimeout(() => rejectLine(new Error(`service startup timed out\nstdout: ${output}\nstderr: ${errors}`)), 10_000);
  stream.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  stream.on('data', chunk => {
    output += chunk;
    const line = output.split('\n').find(candidate => candidate.length > 0);
    if (line === undefined) return;
    clearTimeout(timeout);
    resolveLine(line);
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.once('error', error => { clearTimeout(timeout); rejectLine(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    rejectLine(new Error(`service exited before readiness (${code ?? signal})\nstdout: ${output}\nstderr: ${errors}`));
  });
});

const waitForPath = async (path: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`service exited before creating ${path}`, { cause: error });
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`service did not create ${path} before the startup deadline`);
};

const startIsolatedLinuxSecretService = async (): Promise<() => Promise<void>> => {
  if (!START_LINUX_SECRET_SERVICE) return async () => undefined;
  if (process.platform !== 'linux') fail('FLOWAY_START_TEST_SECRET_SERVICE is supported only on Linux');

  const originalBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const serviceRuntimeDirectory = resolve(runtimeRoot, 'secret-service-runtime');
  await mkdir(serviceRuntimeDirectory, { recursive: true, mode: 0o700 });
  process.env.XDG_RUNTIME_DIR = serviceRuntimeDirectory;

  // Run a private session bus and Secret Service daemon so the Linux job
  // requires the same org.freedesktop.secrets API used by desktop sessions.
  // https://dbus.freedesktop.org/doc/dbus-daemon.1.html
  // https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/adadbad2fdeb79a654dca37b31349e2a1d527ef0/daemon/gkd-main.c#L137-L146
  // https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/adadbad2fdeb79a654dca37b31349e2a1d527ef0/daemon/gkd-main.c#L999-L1006
  // https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/adadbad2fdeb79a654dca37b31349e2a1d527ef0/daemon/gkd-util.c#L122-L123
  // https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/adadbad2fdeb79a654dca37b31349e2a1d527ef0/daemon/control/gkd-control-server.c#L406-L446
  const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  serviceChildren.add(bus);
  const busAddress = await waitForLine(bus, bus.stdout);
  process.env.DBUS_SESSION_BUS_ADDRESS = busAddress;

  const keyring = spawn('gnome-keyring-daemon', ['--foreground', '--login', '--components=secrets'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serviceChildren.add(keyring);
  keyring.stdin.end('floway-ci-secret-service\n');
  await waitForPath(resolve(serviceRuntimeDirectory, 'keyring/control'), keyring);
  await execFileAsync('gnome-keyring-daemon', ['--start', '--components=secrets'], {
    env: process.env,
    timeout: 10_000,
  });

  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      createOperatingSystemCredential(`Floway Secret Service readiness ${randomUUID()}`, 'probe');
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
  }
  if (lastError !== undefined) {
    await Promise.all([...serviceChildren].map(terminateChild));
    throw new Error('Isolated Linux Secret Service did not become ready', { cause: lastError });
  }

  return async () => {
    await Promise.all([terminateChild(keyring), terminateChild(bus)]);
    if (originalBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = originalBusAddress;
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  };
};

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

const assertPersonalStartupFailure = async (
  name: string,
  databasePath: string,
  extraEnv: NodeJS.ProcessEnv,
  expectedChain: readonly string[],
): Promise<void> => {
  const child = spawn(serverCommand[0]!, [...serverCommand.slice(1), '--profile=personal'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY,
      FLOWAY_DB_PATH: databasePath,
      FLOWAY_FILES_DIR: resolve(runtimeRoot, `${name}-files`),
      NODE_ENV: 'production',
      PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited.then(result => ({ kind: 'exit' as const, result })),
    new Promise<{ kind: 'timeout' }>(resolveTimeout => {
      timeout = setTimeout(() => resolveTimeout({ kind: 'timeout' }), 10_000);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome.kind === 'timeout') {
    await stopRuntime(child);
    return fail(`${name} personal runtime did not fail before its startup deadline\n${output}`);
  }
  children.delete(child);
  const [code] = outcome.result;
  if (code === 0) fail(`${name} personal runtime unexpectedly exited successfully`);
  if (output.includes('Floway listening on ')) {
    fail(`${name} personal runtime opened its listener before reporting startup failure\n${output}`);
  }
  let previousIndex = -1;
  for (const message of expectedChain) {
    const index = output.indexOf(message);
    if (index === -1 || index <= previousIndex) {
      fail(`${name} personal runtime lost or reordered its error chain at ${JSON.stringify(message)}\n${output}`);
    }
    previousIndex = index;
  }
};

const assertUnavailableCredentialStorePersonalStartup = async (): Promise<void> => {
  const outer = 'Failed to read the Floway One device master key from the operating system credential store';
  if (process.platform === 'linux') {
    await assertPersonalStartupFailure(
      'unavailable-linux-secret-service',
      resolve(runtimeRoot, 'unavailable-linux-secret-service.db'),
      { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/floway-verification/missing-session-bus' },
      [outer, 'Linux Secret Service is unavailable for the Floway One device master key'],
    );
    return;
  }

  const sentinel = process.platform === 'darwin'
    ? 'macOS Keychain locked sentinel'
    : 'Windows Credential Manager unavailable sentinel';
  const packagedRequire = createRequire(resolve(packageRoot, 'apps/platform-node/package.json'));
  const keyringModulePath = packagedRequire.resolve('@napi-rs/keyring');
  const relativeKeyringPath = relative(await realpath(packageRoot), keyringModulePath);
  if (relativeKeyringPath.startsWith('..') || isAbsolute(relativeKeyringPath)) {
    fail(`resolved packaged keyring outside the temporary runtime: ${keyringModulePath}`);
  }
  const originalKeyringModule = await readFile(keyringModulePath);
  try {
    // pnpm deploy's temporary package retains keyring-node's documented
    // CommonJS entry. Replacing only that packaged copy makes the native
    // facility unavailable without adding a test-only branch to production.
    // https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/package.json#L4
    await writeFile(keyringModulePath, `'use strict';\nconst unavailable = () => { throw new Error(${JSON.stringify(sentinel)}); };\nexports.Entry = class Entry { constructor() { unavailable(); } };\nexports.findCredentials = unavailable;\n`);
    await assertPersonalStartupFailure(
      `unavailable-${process.platform}-credential-store`,
      resolve(runtimeRoot, `unavailable-${process.platform}-credential-store.db`),
      {},
      [outer, sentinel],
    );
  } finally {
    await writeFile(keyringModulePath, originalKeyringModule);
  }
};

const tamperSearchCredential = (databasePath: string): void => {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare('SELECT tavily_api_key FROM search_config WHERE id = 1').get() as { tavily_api_key: string };
    const envelope = JSON.parse(row.tavily_api_key) as { $flowayEncrypted: { ciphertext: string } };
    const first = envelope.$flowayEncrypted.ciphertext[0] ?? fail('stored Tavily ciphertext is empty');
    envelope.$flowayEncrypted.ciphertext = `${first === 'A' ? 'B' : 'A'}${envelope.$flowayEncrypted.ciphertext.slice(1)}`;
    database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run(JSON.stringify(envelope));
  } finally {
    database.close();
  }
};

try {
  const stopIsolatedLinuxSecretService = await startIsolatedLinuxSecretService();
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
        tamperSearchCredential(personalDatabase);
        await assertPersonalStartupFailure(
          'tampered-personal-search-credential',
          personalDatabase,
          {},
          ['Failed to decrypt stored secret for web-search:tavily:api-key'],
        );
      } finally {
        if (existingMasterKey === null) await deleteCredential(productionCredential);
      }
    }

    await assertUnavailableCredentialStorePersonalStartup();
  } finally {
    await stopIsolatedLinuxSecretService();
  }
} finally {
  await Promise.all([...children].map(stopRuntime));
  await Promise.all([...serviceChildren].map(terminateChild));
  await rm(runtimeRoot, { recursive: true, force: true });
}

console.log('Packaged Node runtime verified server compatibility, platform credential storage, and personal ciphertext at rest where supported');
