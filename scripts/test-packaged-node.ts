import { execFile, spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createOperatingSystemCredential,
  type DeviceMasterKeyCredential,
} from '../apps/platform-node/src/device-master-key.ts';
import { FsFileStore } from '../apps/platform-node/src/fs-file-store.ts';
import { resolvePersonalRuntimePaths, type PersonalRuntimePaths } from '../apps/platform-node/src/personal-runtime.ts';
import { PersonalStorageHardener } from '../apps/platform-node/src/personal-storage.ts';
import { createAes256GcmStoredSecretCodec, type StoredSecretContext } from '../packages/platform/src/stored-secret-codec.ts';

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
    credential = await createOperatingSystemCredential(service, account);
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
const packagedDefaultPersonalEntry = resolve(packageRoot, 'apps/platform-node/personal-default-entry-verification.ts');
const packagedPersonalEntry = resolve(packageRoot, 'apps/platform-node/personal-entry-verification.ts');
const packagedServerBoundaryEntry = resolve(packageRoot, 'apps/platform-node/server-boundary-verification.ts');
const children = new Set<ChildProcessByStdio<null, Readable, Readable>>();
const serviceChildren = new Set<ChildProcess>();

const probe = createServer();
await new Promise<void>((resolveListening, rejectListening) => {
  probe.once('error', rejectListening);
  probe.listen(0, '127.0.0.1', resolveListening);
});
const verificationPort = (probe.address() as { port: number }).port;
await new Promise<void>((resolveClosed, rejectClosed) => probe.close(error => {
  if (error === undefined) resolveClosed();
  else rejectClosed(error);
}));

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
      await createOperatingSystemCredential(`Floway Secret Service readiness ${randomUUID()}`, 'probe');
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
  personalPaths?: PersonalRuntimePaths,
  entryPath?: string,
): Promise<{ boundHost: string; child: ChildProcessByStdio<null, Readable, Readable>; origin: string; output: () => string }> => {
  const command = profile === 'personal'
    ? [...serverCommand.slice(1, -1), packagedPersonalEntry, '--profile=personal']
    : entryPath === undefined
      ? serverCommand.slice(1)
      : [...serverCommand.slice(1, -1), entryPath, '--profile=server'];
  if (profile === 'personal' && personalPaths === undefined) fail('personal packaged runtime requires explicit verification paths');
  const child = spawn(serverCommand[0]!, command, {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY,
      FLOWAY_DB_PATH: databasePath,
      FLOWAY_FILES_DIR: resolve(runtimeRoot, `${profile}-files`),
      FLOWAY_PACKAGED_PERSONAL_PATHS: personalPaths === undefined ? undefined : JSON.stringify(personalPaths),
      NODE_ENV: 'production',
      PORT: profile === 'personal' ? String(verificationPort) : '0',
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

  const ready = await new Promise<{ host: string; port: number }>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`${profile} startup timed out\n${combinedOutput}`)),
      process.platform === 'win32' && profile === 'personal' ? 120_000 : 30_000,
    );
    const inspect = () => {
      const match = /Floway listening on http:\/\/([^:]+):(\d+)/.exec(combinedOutput);
      if (match === null) return;
      clearTimeout(timeout);
      resolveReady({ host: match[1]!, port: Number(match[2]) });
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
  if (profile === 'personal' && ready.host !== '127.0.0.1') {
    await stopRuntime(child);
    fail(`personal runtime bound ${ready.host} instead of 127.0.0.1`);
  }
  return {
    boundHost: ready.host,
    child,
    origin: `http://127.0.0.1:${ready.port}`,
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
  personalPaths: PersonalRuntimePaths | undefined,
  extraEnv: NodeJS.ProcessEnv,
  expectedChain: readonly string[],
  entryPath = packagedPersonalEntry,
): Promise<void> => {
  const child = spawn(serverCommand[0]!, [...serverCommand.slice(1, -1), entryPath, '--profile=personal'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ADMIN_KEY,
      FLOWAY_DB_PATH: resolve(runtimeRoot, `${name}-ignored-floway.db`),
      FLOWAY_FILES_DIR: resolve(runtimeRoot, `${name}-files`),
      FLOWAY_PACKAGED_PERSONAL_PATHS: personalPaths === undefined ? undefined : JSON.stringify(personalPaths),
      NODE_ENV: 'production',
      PORT: String(verificationPort),
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
    const index = output.indexOf(message, previousIndex + 1);
    if (index === -1) {
      fail(`${name} personal runtime lost or reordered its error chain at ${JSON.stringify(message)}\n${output}`);
    }
    previousIndex = index;
  }
  await new Promise<void>((resolveRefused, rejectRefused) => {
    const socket = connect({ host: '127.0.0.1', port: verificationPort });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectRefused(new Error(`${name} listener probe timed out`));
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      rejectRefused(new Error(`${name} accepted a connection after startup failure`));
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolveRefused();
      else rejectRefused(error);
    });
  });
};

const readWindowsRoamingAppData = async (): Promise<string> => {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::Out.Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))',
  ], { encoding: 'utf8' });
  const roamingAppData = stdout.trim();
  if (!isAbsolute(roamingAppData)) fail(`Windows returned a non-absolute Roaming AppData Known Folder: ${roamingAppData}`);
  return roamingAppData;
};

const setWindowsRoamingAppData = async (path: string): Promise<void> => {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlowayKnownFolderRedirect {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHSetKnownFolderPath(ref Guid rfid, uint flags, IntPtr token, string path);
}
'@
$FolderId = [Guid]'3EB685DB-65F9-4CF6-A03A-E3EF65729F3D'
$Path = [Environment]::GetEnvironmentVariable('FLOWAY_REDIRECTED_KNOWN_FOLDER')
$HResult = [FlowayKnownFolderRedirect]::SHSetKnownFolderPath([ref]$FolderId, 0, [IntPtr]::Zero, $Path)
if ($HResult -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($HResult) }
`], {
    env: { ...process.env, FLOWAY_REDIRECTED_KNOWN_FOLDER: path },
  });
};

const assertWindowsDefaultPersonalEntry = async (): Promise<void> => {
  if (process.platform !== 'win32') return;

  const originalRoamingAppData = await readWindowsRoamingAppData();
  const redirectedRoamingAppData = resolve(runtimeRoot, 'redirected-roaming-app-data');
  await mkdir(redirectedRoamingAppData, { recursive: true });
  try {
    await setWindowsRoamingAppData(redirectedRoamingAppData);
    const observedRedirect = await readWindowsRoamingAppData();
    if (observedRedirect.toLowerCase() !== redirectedRoamingAppData.toLowerCase()) {
      fail(`Windows ignored Roaming AppData redirection: ${observedRedirect}`);
    }

    const dataDir = join(redirectedRoamingAppData, 'Floway One');
    await assertPersonalStartupFailure(
      'windows-default-personal-paths',
      undefined,
      {
        APPDATA: 'Y:\\hostile-appdata',
        HOME: 'Z:\\hostile-home',
      },
      [
        'Floway packaged default entry stopped after path resolution',
        `data directory: ${dataDir}`,
        `credential lock: ${join(dataDir, 'credential-lock', 'device-master-key-v1.creation-lock.db')}`,
      ],
      packagedDefaultPersonalEntry,
    );
  } finally {
    await setWindowsRoamingAppData(originalRoamingAppData);
  }
  if ((await readWindowsRoamingAppData()).toLowerCase() !== originalRoamingAppData.toLowerCase()) {
    fail('Windows Roaming AppData Known Folder was not restored');
  }
};

const assertWindowsKnownFolderHresultFailure = async (): Promise<void> => {
  if (process.platform !== 'win32') return;

  const personalRuntimePath = resolve(packageRoot, 'apps/platform-node/src/personal-runtime.ts');
  const originalSource = await readFile(personalRuntimePath, 'utf8');
  const roamingAppDataFolderId = '3EB685DB-65F9-4CF6-A03A-E3EF65729F3D';
  if (!originalSource.includes(roamingAppDataFolderId)) fail('packaged personal runtime has no Roaming AppData Known Folder ID');
  try {
    await writeFile(personalRuntimePath, originalSource.replaceAll(
      roamingAppDataFolderId,
      '00000000-0000-0000-0000-000000000000',
    ));
    await assertPersonalStartupFailure(
      'windows-known-folder-hresult',
      undefined,
      {},
      [
        'Floway One could not resolve the Windows Roaming AppData Known Folder',
        '0x80070002',
      ],
      packagedDefaultPersonalEntry,
    );
  } finally {
    await writeFile(personalRuntimePath, originalSource);
  }
};

const withUnavailablePackagedKeyring = async (
  sentinel: string,
  operation: () => Promise<void>,
): Promise<void> => {
  const deviceMasterKeyPath = resolve(packageRoot, 'apps/platform-node/src/device-master-key.ts');
  const unavailableKeyringPath = resolve(packageRoot, 'apps/platform-node/src/unavailable-keyring-verification.ts');
  const originalSource = await readFile(deviceMasterKeyPath, 'utf8');
  const productionImport = "await import('@napi-rs/keyring')";
  if (!originalSource.includes(productionImport)) fail('packaged device master key has no dynamic native keyring import');
  try {
    // Redirect only the temporary deployed source's dynamic import to a
    // module-load failure. Server mode must never evaluate it; personal mode
    // must retain the loader failure in its startup cause chain.
    await writeFile(unavailableKeyringPath, `throw new Error(${JSON.stringify(sentinel)});\n`);
    await writeFile(deviceMasterKeyPath, originalSource.replace(
      productionImport,
      "await import('./unavailable-keyring-verification.ts')",
    ));
    await operation();
  } finally {
    await writeFile(deviceMasterKeyPath, originalSource);
    await rm(unavailableKeyringPath, { force: true });
  }
};

const assertUnavailableCredentialStorePersonalStartup = async (): Promise<void> => {
  const outer = 'Failed to read the Floway One device master key from the operating system credential store';
  const personalPaths = resolvePersonalRuntimePaths({ dataDir: resolve(runtimeRoot, 'unavailable-credential-store') });
  if (process.platform === 'linux') {
    await assertPersonalStartupFailure(
      'unavailable-linux-secret-service',
      personalPaths,
      { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/floway-verification/missing-session-bus' },
      [outer, 'Linux Secret Service is unavailable for the Floway One device master key'],
    );
    return;
  }

  const sentinel = process.platform === 'darwin'
    ? 'macOS Keychain locked sentinel'
    : 'Windows Credential Manager unavailable sentinel';
  await withUnavailablePackagedKeyring(sentinel, async () => {
    await assertPersonalStartupFailure(
      `unavailable-${process.platform}-credential-store`,
      personalPaths,
      {},
      [outer, sentinel],
    );
  });
};

const storedSecretContext = (value: string): StoredSecretContext => value as StoredSecretContext;

const authenticate = async (origin: string): Promise<string> => {
  const response = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: ADMIN_KEY }),
  });
  if (!response.ok) fail(`personal admin login returned ${response.status}`);
  const body = await response.json() as { token?: unknown };
  return requireString(body.token, 'personal admin login returned no session token');
};

const assertPersistedPersonalSecret = async (origin: string): Promise<void> => {
  const response = await fetch(`${origin}/api/search-config`, {
    headers: { 'x-floway-session': await authenticate(origin) },
  });
  if (!response.ok) fail(`personal search credential read returned ${response.status}`);
  const body = await response.json() as { tavily?: { apiKey?: unknown } };
  if (body.tavily?.apiKey !== PERSONAL_SECRET) fail('valid encrypted restart did not return the persisted Tavily secret');
};

const seedProtectedUpstream = async (databasePath: string, masterKey: Uint8Array): Promise<void> => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const id = 'up_packaged_entry';
  const config = await codec.seal(
    '{"baseUrl":"https://provider.example","authStyle":"bearer","apiKey":"packaged-api-key"}',
    storedSecretContext(`upstream:${id}:config`),
  );
  const state = await codec.seal(
    '{"refreshToken":"packaged-refresh","accessToken":{"token":"packaged-access"}}',
    storedSecretContext(`upstream:${id}:state`),
  );
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(
      `INSERT INTO upstreams (id, provider, name, created_at, updated_at, config_json, state_json, flag_overrides, hue)
       VALUES (?, 'custom', 'Packaged entry validation', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', ?, ?, '{}', 210)`,
    ).run(id, config, state);
  } finally {
    database.close();
  }
};

const tamperEnvelope = (stored: string): string => {
  const envelope = JSON.parse(stored) as { $flowayEncrypted: { ciphertext: string } };
  const first = envelope.$flowayEncrypted.ciphertext[0] ?? fail('stored ciphertext is empty');
  envelope.$flowayEncrypted.ciphertext = `${first === 'A' ? 'B' : 'A'}${envelope.$flowayEncrypted.ciphertext.slice(1)}`;
  return JSON.stringify(envelope);
};

const unsupportedEnvelope = (stored: string): string => {
  const envelope = JSON.parse(stored) as { $flowayEncrypted: { version: number } };
  envelope.$flowayEncrypted.version = 2;
  return JSON.stringify(envelope);
};

const assertInvalidPersonalEntries = async (baseDatabasePath: string, masterKey: Uint8Array): Promise<void> => {
  const base = new DatabaseSync(baseDatabasePath, { readOnly: true });
  const upstream = base.prepare('SELECT config_json, state_json FROM upstreams WHERE id = ?')
    .get('up_packaged_entry') as { config_json: string; state_json: string };
  const search = base.prepare('SELECT tavily_api_key FROM search_config WHERE id = 1')
    .get() as { tavily_api_key: string };
  base.close();
  const wrongKey = Uint8Array.from(masterKey, byte => byte ^ 0xff);
  const wrongCodec = createAes256GcmStoredSecretCodec(wrongKey);
  const wrongUpstream = await wrongCodec.seal('{"refreshToken":"wrong"}', storedSecretContext('upstream:up_packaged_entry:state'));
  const wrongSearch = await wrongCodec.seal('wrong', storedSecretContext('web-search:tavily:api-key'));

  const cases: Array<{
    name: string;
    expectedChain: readonly string[];
    mutate(database: DatabaseSync): void;
  }> = [
    {
      name: 'plaintext-upstream',
      expectedChain: ['Invalid encrypted stored secret format for upstream:up_packaged_entry:config'],
      mutate: database => { database.prepare('UPDATE upstreams SET config_json = ? WHERE id = ?').run('{"apiKey":"plaintext"}', 'up_packaged_entry'); },
    },
    {
      name: 'plaintext-search',
      expectedChain: ['Invalid encrypted stored secret format for web-search:tavily:api-key'],
      mutate: database => { database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run('plaintext'); },
    },
    {
      name: 'wrong-key-upstream',
      expectedChain: ['Failed to decrypt stored secret for upstream:up_packaged_entry:state', 'OperationError'],
      mutate: database => { database.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?').run(wrongUpstream, 'up_packaged_entry'); },
    },
    {
      name: 'wrong-key-search',
      expectedChain: ['Failed to decrypt stored secret for web-search:tavily:api-key', 'OperationError'],
      mutate: database => { database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run(wrongSearch); },
    },
    {
      name: 'tampered-upstream',
      expectedChain: ['Failed to decrypt stored secret for upstream:up_packaged_entry:config', 'OperationError'],
      mutate: database => { database.prepare('UPDATE upstreams SET config_json = ? WHERE id = ?').run(tamperEnvelope(upstream.config_json), 'up_packaged_entry'); },
    },
    {
      name: 'tampered-search',
      expectedChain: ['Failed to decrypt stored secret for web-search:tavily:api-key', 'OperationError'],
      mutate: database => { database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run(tamperEnvelope(search.tavily_api_key)); },
    },
    {
      name: 'malformed-upstream',
      expectedChain: ['Invalid encrypted stored secret format for upstream:up_packaged_entry:state', 'SyntaxError'],
      mutate: database => { database.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?').run('{', 'up_packaged_entry'); },
    },
    {
      name: 'malformed-search',
      expectedChain: ['Invalid encrypted stored secret format for web-search:tavily:api-key', 'SyntaxError'],
      mutate: database => { database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run('{'); },
    },
    {
      name: 'unsupported-version-upstream',
      expectedChain: ['Unsupported encrypted stored secret version 2 for upstream:up_packaged_entry:config'],
      mutate: database => { database.prepare('UPDATE upstreams SET config_json = ? WHERE id = ?').run(unsupportedEnvelope(upstream.config_json), 'up_packaged_entry'); },
    },
    {
      name: 'unsupported-version-search',
      expectedChain: ['Unsupported encrypted stored secret version 2 for web-search:tavily:api-key'],
      mutate: database => { database.prepare('UPDATE search_config SET tavily_api_key = ? WHERE id = 1').run(unsupportedEnvelope(search.tavily_api_key)); },
    },
  ];

  for (const entry of cases) {
    const paths = resolvePersonalRuntimePaths({ dataDir: resolve(runtimeRoot, `invalid-${entry.name}`) });
    await mkdir(paths.dataDir, { recursive: true });
    await copyFile(baseDatabasePath, paths.databasePath);
    const database = new DatabaseSync(paths.databasePath);
    try { entry.mutate(database); } finally { database.close(); }
    await assertPersonalStartupFailure(entry.name, paths, {}, entry.expectedChain);
  }
};

type WindowsAclExpectation = 'directory' | 'inherited-file' | 'protected-file';

const assertWindowsOwnerOnlyAcl = async (target: string, expectation: WindowsAclExpectation): Promise<void> => {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$Target = [Environment]::GetEnvironmentVariable('FLOWAY_ACL_VERIFY_TARGET')
$Expectation = [Environment]::GetEnvironmentVariable('FLOWAY_ACL_VERIFY_EXPECTATION')
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$IsDirectory = $Expectation -eq 'directory'
$ExpectedProtected = $Expectation -ne 'inherited-file'
$ExpectedInherited = $Expectation -eq 'inherited-file'
$ExpectedCurrentOwner = $Expectation -ne 'inherited-file'
$ExpectedInheritance = if ($IsDirectory) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
$Acl = if ($IsDirectory) { [System.IO.Directory]::GetAccessControl($Target) } else { [System.IO.File]::GetAccessControl($Target) }
$Rules = @($Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($Acl.AreAccessRulesProtected -ne $ExpectedProtected -or ($ExpectedCurrentOwner -and $Acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $Sid) -or $Rules.Count -ne 1 -or $Rules[0].IdentityReference -ne $Sid -or $Rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $Rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $Rules[0].InheritanceFlags -ne $ExpectedInheritance -or $Rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or $Rules[0].IsInherited -ne $ExpectedInherited) {
  throw "ACL verification failed for $Target as $Expectation (owner=$($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value), sid=$($Sid.Value), identity=$($Rules[0].IdentityReference.Value), access=$($Rules[0].AccessControlType), rights=$($Rules[0].FileSystemRights), protected=$($Acl.AreAccessRulesProtected), inherited=$($Rules[0].IsInherited), inheritance=$($Rules[0].InheritanceFlags), propagation=$($Rules[0].PropagationFlags), rules=$($Rules.Count))"
}
`], {
    env: {
      ...process.env,
      FLOWAY_ACL_VERIFY_EXPECTATION: expectation,
      FLOWAY_ACL_VERIFY_TARGET: target,
    },
  });
};

const setWindowsOwnerToAdministrators = async (target: string): Promise<void> => {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$Target = [Environment]::GetEnvironmentVariable('FLOWAY_ACL_OWNER_TARGET')
$Acl = [System.IO.File]::GetAccessControl($Target)
$Acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
[System.IO.File]::SetAccessControl($Target, $Acl)
`], {
    env: { ...process.env, FLOWAY_ACL_OWNER_TARGET: target },
  });
};

const assertPrivatePersonalStorage = async (
  paths: PersonalRuntimePaths,
  contentPath: string,
  hardener: PersonalStorageHardener,
): Promise<void> => {
  if (process.platform !== 'win32') {
    for (const directory of [paths.dataDir, paths.filesDir, paths.logsDir, dirname(contentPath)]) {
      if (((await stat(directory)).mode & 0o777) !== 0o700) fail(`personal directory is not mode 0700: ${directory}`);
    }
    for (const file of [paths.databasePath, contentPath]) {
      if (((await stat(file)).mode & 0o777) !== 0o600) fail(`personal file is not mode 0600: ${file}`);
    }
    return;
  }

  for (const directory of [paths.dataDir, paths.filesDir, paths.logsDir, dirname(contentPath)]) {
    await assertWindowsOwnerOnlyAcl(directory, 'directory');
  }
  for (const file of [paths.databasePath, contentPath]) {
    await assertWindowsOwnerOnlyAcl(file, 'protected-file');
  }

  const verificationDatabasePath = join(paths.dataDir, 'sqlite-acl-verification.db');
  const journalPath = `${verificationDatabasePath}-journal`;
  let database = new DatabaseSync(verificationDatabasePath);
  try {
    database.exec('PRAGMA journal_mode = DELETE; CREATE TABLE acl_probe (value INTEGER)');
    hardener.hardenSqliteFiles(verificationDatabasePath);
    for (const value of [1, 2]) {
      database.exec(`BEGIN IMMEDIATE; INSERT INTO acl_probe VALUES (${value})`);
      if (value === 2) await setWindowsOwnerToAdministrators(journalPath);
      await assertWindowsOwnerOnlyAcl(journalPath, 'inherited-file');
      hardener.hardenSqliteFiles(verificationDatabasePath);
      await assertWindowsOwnerOnlyAcl(journalPath, 'protected-file');
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }

  const walPath = `${verificationDatabasePath}-wal`;
  const shmPath = `${verificationDatabasePath}-shm`;
  for (const value of [3, 4]) {
    database = new DatabaseSync(verificationDatabasePath);
    try {
      database.exec(`PRAGMA journal_mode = WAL; INSERT INTO acl_probe VALUES (${value})`);
      if (value === 4) {
        await setWindowsOwnerToAdministrators(walPath);
        await setWindowsOwnerToAdministrators(shmPath);
      }
      await assertWindowsOwnerOnlyAcl(walPath, 'inherited-file');
      await assertWindowsOwnerOnlyAcl(shmPath, 'inherited-file');
      hardener.hardenSqliteFiles(verificationDatabasePath);
      await assertWindowsOwnerOnlyAcl(walPath, 'protected-file');
      await assertWindowsOwnerOnlyAcl(shmPath, 'protected-file');
    } finally {
      database.close();
    }
    await Promise.all([rm(walPath, { force: true }), rm(shmPath, { force: true })]);
  }
  await rm(verificationDatabasePath);
};

try {
  const stopIsolatedLinuxSecretService = await startIsolatedLinuxSecretService();
  try {
    await execFileAsync(process.execPath, ['--experimental-strip-types', GENERATOR, packageRoot], { cwd: ROOT });
    if (serverCommand.at(-1) !== 'apps/platform-node/entry.ts') {
      fail('the packaged server command no longer ends at the production Node entry');
    }
    await writeFile(packagedPersonalEntry, `
import { runNodeEntry } from './src/run-node-entry.ts';
const source = process.env.FLOWAY_PACKAGED_PERSONAL_PATHS;
if (source === undefined) throw new Error('Missing packaged personal path fixture');
const paths = JSON.parse(source);
await runNodeEntry({ resolvePersonalRuntimePaths: () => paths });
`);
    await writeFile(packagedDefaultPersonalEntry, `
import { runNodeEntry } from './src/run-node-entry.ts';
await runNodeEntry({
  bootstrapNodePlatform: options => {
    if (options.profile !== 'personal') throw new Error('Expected the personal runtime profile');
    throw new Error([
      'Floway packaged default entry stopped after path resolution',
      \`data directory: \${options.storage.dataDir}\`,
      \`credential lock: \${options.storage.credentialLockDatabasePath}\`,
    ].join('\\n'));
  },
});
`);
    await writeFile(packagedServerBoundaryEntry, `
import { bootstrapNodePlatform } from './src/bootstrap.ts';
import { runNodeEntry } from './src/run-node-entry.ts';
await runNodeEntry({
  resolvePersonalRuntimePaths: () => { throw new Error('server touched personal path resolver'); },
  bootstrapNodePlatform: options => bootstrapNodePlatform(options, {
    createDeviceMasterKeyCreationLock: () => { throw new Error('server constructed personal device-key lock'); },
  }),
});
`);

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

    await withUnavailablePackagedKeyring('server native keyring loader unavailable sentinel', async () => {
      const server = await startRuntime(
        resolve(runtimeRoot, 'server.db'),
        'server',
        {},
        undefined,
        packagedServerBoundaryEntry,
      );
      await assertServerSurface(server.origin);
      await stopRuntime(server.child);
    });

    await assertWindowsDefaultPersonalEntry();
    await assertWindowsKnownFolderHresultFailure();

    const systemStoreAvailable = await exerciseIsolatedCredentialStore();
    if (systemStoreAvailable) {
      const productionCredential = await createOperatingSystemCredential();
      const existingMasterKey = await readCredential(productionCredential);
      try {
        const personalPaths = resolvePersonalRuntimePaths({ dataDir: resolve(runtimeRoot, 'personal-data') });
        const personal = await startRuntime(personalPaths.databasePath, 'personal', {}, personalPaths);
        await persistPersonalSecret(personal.origin);
        await stopRuntime(personal.child);
        const storedMasterKey = await readCredential(productionCredential);
        const validMasterKey = storedMasterKey ?? fail('personal runtime did not persist a device master key in the system credential store');
        if (validMasterKey.byteLength !== 32) fail('personal runtime did not persist a 256-bit key in the system credential store');
        assertCiphertextAtRest(personalPaths.databasePath);
        await seedProtectedUpstream(personalPaths.databasePath, validMasterKey);

        const hardener = new PersonalStorageHardener(personalPaths);
        hardener.initialize();
        const fileStore = new FsFileStore(personalPaths.filesDir, hardener);
        const contentPath = join(personalPaths.filesDir, 'packaged', 'body.bin');
        await fileStore.put('packaged/body.bin', new TextEncoder().encode('private-content'));
        const restarted = await startRuntime(personalPaths.databasePath, 'personal', {}, personalPaths);
        await assertPersistedPersonalSecret(restarted.origin);
        await stopRuntime(restarted.child);
        await assertPrivatePersonalStorage(personalPaths, contentPath, hardener);
        await assertInvalidPersonalEntries(personalPaths.databasePath, validMasterKey);

        const hardeningFailurePaths = resolvePersonalRuntimePaths({ dataDir: resolve(runtimeRoot, 'hardening-failure') });
        await mkdir(hardeningFailurePaths.dataDir, { recursive: true });
        await writeFile(hardeningFailurePaths.filesDir, 'occupied');
        await assertPersonalStartupFailure(
          'personal-storage-hardening',
          hardeningFailurePaths,
          {},
          [
            `Floway One could not enforce current-user-only access on directory ${hardeningFailurePaths.filesDir}`,
            'EEXIST',
          ],
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
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log('Packaged Node runtime verified server compatibility, platform credential storage, and personal ciphertext at rest where supported');
