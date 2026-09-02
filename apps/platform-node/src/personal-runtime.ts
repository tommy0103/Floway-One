import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as currentPlatform } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';

export const PERSONAL_HOSTNAME = '127.0.0.1' as const;
export const DEFAULT_PERSONAL_PORT = 8788;

interface PersistedRuntimeState {
  readonly version: 1;
  readonly port: number;
}

export interface PersonalRuntime {
  readonly profile: 'personal';
  readonly hostname: typeof PERSONAL_HOSTNAME;
  readonly port: number;
  readonly endpoint: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly filesDir: string;
  readonly logsDir: string;
  readonly runtimeStatePath: string;
}

interface PersonalRuntimeOptions {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly warn?: (message: string) => void;
}

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!isPort(port) || String(port) !== value.trim()) {
    throw new Error(`Floway One port must be an integer from 1 through 65535; received ${JSON.stringify(value)}`);
  }
  return port;
};

export const resolveDefaultPersonalDataDir = (
  platform: NodeJS.Platform = currentPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string => {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData || !win32.isAbsolute(appData)) {
      throw new Error('Floway One requires an absolute APPDATA directory on Windows');
    }
    // FOLDERID_RoamingAppData is the supported per-user roaming application-data root.
    // Ref: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid
    return win32.join(appData, 'Floway One');
  }

  if (!posix.isAbsolute(homeDir)) throw new Error('Floway One requires an absolute user home directory');
  if (platform === 'darwin') {
    // Application Support is the macOS location for app-created support files.
    // Ref: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
    return posix.join(homeDir, 'Library', 'Application Support', 'Floway One');
  }

  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome !== undefined && !posix.isAbsolute(xdgDataHome)) {
    throw new Error('Floway One requires XDG_DATA_HOME to be absolute when it is set');
  }
  // XDG_DATA_HOME defaults to $HOME/.local/share when it is absent.
  // Ref: https://specifications.freedesktop.org/basedir-spec/latest/#variables
  return posix.join(xdgDataHome ?? posix.join(homeDir, '.local', 'share'), 'floway-one');
};

const readRuntimeState = (path: string): PersistedRuntimeState | null => {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Floway One could not read runtime state at ${path}`, { cause });
  }

  try {
    const value: unknown = JSON.parse(source);
    if (
      typeof value !== 'object'
      || value === null
      || !('version' in value)
      || value.version !== 1
      || !('port' in value)
      || !isPort(value.port)
    ) {
      throw new Error('expected { "version": 1, "port": <1-65535> }');
    }
    return { version: 1, port: value.port };
  } catch (cause) {
    throw new Error(`Floway One runtime state is invalid at ${path}`, { cause });
  }
};

const writeRuntimeState = (path: string, state: PersistedRuntimeState): void => {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (cause) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* preserve the original storage failure */ }
    throw new Error(`Floway One could not persist runtime state at ${path}`, { cause });
  }
};

export const loadPersonalRuntime = (options: PersonalRuntimeOptions = {}): PersonalRuntime => {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir
    ?? resolveDefaultPersonalDataDir(options.platform, env, options.homeDir);
  if (!isAbsolute(dataDir)) throw new Error(`Floway One application data directory must be absolute: ${dataDir}`);

  const filesDir = join(dataDir, 'files');
  const logsDir = join(dataDir, 'logs');
  const runtimeStatePath = join(dataDir, 'runtime.json');
  try {
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(dataDir, 0o700);
      chmodSync(filesDir, 0o700);
      chmodSync(logsDir, 0o700);
    }
    accessSync(dataDir, constants.R_OK | constants.W_OK);
  } catch (cause) {
    throw new Error(
      `Floway One cannot use application data directory ${dataDir}. Check that the location exists and is writable.`,
      { cause },
    );
  }

  const requestedPort = env.PORT === undefined ? undefined : parsePort(env.PORT);
  const storedState = readRuntimeState(runtimeStatePath);
  const previousPort = storedState?.port ?? DEFAULT_PERSONAL_PORT;
  const port = requestedPort ?? previousPort;
  if (storedState?.port !== port) writeRuntimeState(runtimeStatePath, { version: 1, port });

  const endpoint = `http://${PERSONAL_HOSTNAME}:${port}`;
  if (requestedPort !== undefined && requestedPort !== previousPort) {
    (options.warn ?? console.warn)(
      `Floway One endpoint changed from http://${PERSONAL_HOSTNAME}:${previousPort} to ${endpoint}. Update configured client endpoints before reconnecting.`,
    );
  }

  return {
    profile: 'personal',
    hostname: PERSONAL_HOSTNAME,
    port,
    endpoint,
    dataDir,
    databasePath: join(dataDir, 'floway.db'),
    filesDir,
    logsDir,
    runtimeStatePath,
  };
};
