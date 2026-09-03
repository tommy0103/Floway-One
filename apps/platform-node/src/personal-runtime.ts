import { execFileSync } from 'node:child_process';
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
import { platform as currentPlatform, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

import { DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY } from './device-master-key-credential-identity.ts';
import type { PrivateStoragePermissions } from './personal-storage.ts';

export const PERSONAL_HOSTNAME = '127.0.0.1' as const;
export const DEFAULT_PERSONAL_PORT = 8788;

interface PersistedRuntimeState {
  readonly version: 1;
  readonly port: number;
}

export interface PersonalRuntimePaths {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly filesDir: string;
  readonly logsDir: string;
  readonly runtimeStatePath: string;
  readonly credentialLockDatabasePath: string;
}

export interface WindowsKnownFolderResult {
  readonly hresult: number;
  readonly path: string | null;
}

export interface WindowsKnownFolderBoundary {
  resolveRoamingAppData(): WindowsKnownFolderResult;
  throwForHresult(hresult: number): never;
}

export interface PersonalRuntimeRootOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly stableUserHome?: string;
  readonly windowsKnownFolders?: WindowsKnownFolderBoundary;
}

export interface PersonalRuntimePathOptions extends PersonalRuntimeRootOptions {
  readonly dataDir?: string;
}

const stableUserHome = (): string => userInfo().homedir;

let cachedWindowsRoamingAppData: string | undefined;

const WINDOWS_ROAMING_APP_DATA_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlowayKnownFolders {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHGetKnownFolderPath(
    ref Guid rfid,
    uint flags,
    IntPtr token,
    out IntPtr path
  );
}
'@
$FolderId = [Guid]'3EB685DB-65F9-4CF6-A03A-E3EF65729F3D'
$Pointer = [IntPtr]::Zero
$HResult = [FlowayKnownFolders]::SHGetKnownFolderPath([ref]$FolderId, 0, [IntPtr]::Zero, [ref]$Pointer)
try {
  $Path = if ($Pointer -eq [IntPtr]::Zero) { $null } else { [Runtime.InteropServices.Marshal]::PtrToStringUni($Pointer) }
  [Console]::Out.Write(([pscustomobject]@{ hresult = $HResult; path = $Path } | ConvertTo-Json -Compress))
} finally {
  if ($Pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($Pointer) }
}
`;

// Marshal.GetExceptionForHR turns the native result into the original .NET
// exception that remains attached as the startup cause.
// https://github.com/dotnet/dotnet-api-docs/blob/ac69dc2863d25fb47493bfbd80a6a22eb0c4a140/xml/System.Runtime.InteropServices/Marshal.xml#L2811-L2869
const WINDOWS_HRESULT_EXCEPTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$HResult = [int][Environment]::GetEnvironmentVariable('FLOWAY_WINDOWS_HRESULT')
$Exception = [Runtime.InteropServices.Marshal]::GetExceptionForHR($HResult)
if ($null -eq $Exception) { throw "HRESULT $HResult did not produce a .NET exception" }
throw $Exception
`;

const queryWindowsRoamingAppData = (): WindowsKnownFolderResult => {
  if (cachedWindowsRoamingAppData !== undefined) {
    return { hresult: 0, path: cachedWindowsRoamingAppData };
  }

  const output = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_ROAMING_APP_DATA_QUERY_SCRIPT,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const result = JSON.parse(output) as WindowsKnownFolderResult;
  if (result.hresult === 0 && result.path !== null && win32.isAbsolute(result.path)) {
    cachedWindowsRoamingAppData = win32.normalize(result.path);
    return { hresult: 0, path: cachedWindowsRoamingAppData };
  }
  return result;
};

const throwWindowsHresult = (hresult: number): never => {
  execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_HRESULT_EXCEPTION_SCRIPT,
  ], {
    encoding: 'utf8',
    env: { ...process.env, FLOWAY_WINDOWS_HRESULT: String(hresult) },
    windowsHide: true,
  });
  throw new Error(`Windows HRESULT ${hresult} did not raise a .NET exception`);
};

const defaultWindowsKnownFolders: WindowsKnownFolderBoundary = {
  resolveRoamingAppData: queryWindowsRoamingAppData,
  throwForHresult: throwWindowsHresult,
};

const resolveWindowsPersonalDataDir = (knownFolders: WindowsKnownFolderBoundary): string => {
  let result: WindowsKnownFolderResult;
  try {
    result = knownFolders.resolveRoamingAppData();
    if (result.hresult !== 0) knownFolders.throwForHresult(result.hresult);
    if (result.path === null || !win32.isAbsolute(result.path)) {
      throw new Error(`Windows returned a non-absolute Roaming AppData Known Folder: ${result.path ?? ''}`);
    }
  } catch (cause) {
    throw new Error('Floway could not resolve the Windows Roaming AppData Known Folder', { cause });
  }

  // FOLDERID_RoamingAppData is the redirectable per-user application-data root.
  // SHGetKnownFolderPath resolves it through the operating system rather than
  // trusting process environment variables or synthesizing a profile path.
  // https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid#folderid_roamingappdata
  // https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath
  return win32.join(win32.normalize(result.path), 'Floway One');
};

interface PersonalRuntimeRoots {
  readonly credentialStateDir: string;
  readonly dataDir: string;
}

const resolvePersonalRuntimeRoots = (
  options: PersonalRuntimeRootOptions = {},
): PersonalRuntimeRoots => {
  const platform = options.platform ?? currentPlatform();
  if (platform === 'win32') {
    const dataDir = resolveWindowsPersonalDataDir(options.windowsKnownFolders ?? defaultWindowsKnownFolders);
    return { credentialStateDir: dataDir, dataDir };
  }

  const userHome = options.stableUserHome ?? stableUserHome();
  if (!posix.isAbsolute(userHome)) throw new Error('Floway requires an absolute operating-system user home directory');
  const normalizedHome = posix.normalize(userHome);
  if (platform === 'darwin') {
    // Application Support is the macOS location for app-created support files.
    // https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
    const dataDir = posix.join(normalizedHome, 'Library', 'Application Support', 'Floway One');
    return { credentialStateDir: dataDir, dataDir };
  }

  const credentialStateDir = posix.join(normalizedHome, '.local', 'share', 'floway-one');
  const xdgDataHome = (options.env ?? process.env).XDG_DATA_HOME;
  // XDG requires absolute paths and directs implementations to ignore relative
  // values. Keep the credential lock beneath the stable OS home so separate
  // process environments cannot split one user's OS-credential identity.
  // https://specifications.freedesktop.org/basedir-spec/latest/#variables
  // https://docs.libuv.org/en/v1.x/misc.html#c.uv_os_get_passwd
  const dataDir = xdgDataHome !== undefined && posix.isAbsolute(xdgDataHome)
    ? posix.join(posix.normalize(xdgDataHome), 'floway-one')
    : credentialStateDir;
  return { credentialStateDir, dataDir };
};

export const resolveDefaultPersonalDataDir = (
  options: PersonalRuntimeRootOptions = {},
): string => resolvePersonalRuntimeRoots(options).dataDir;

export interface PersonalRuntime extends PersonalRuntimePaths {
  readonly profile: 'personal';
  readonly hostname: typeof PERSONAL_HOSTNAME;
  readonly port: number;
  readonly endpoint: string;
}

export interface PersonalRuntimeOptions extends PersonalRuntimePathOptions {
  readonly paths?: PersonalRuntimePaths;
  readonly permissions?: PrivateStoragePermissions;
  readonly warn?: (message: string) => void;
}

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;

const parsePort = (value: string): number => {
  const port = Number(value);
  if (!isPort(port) || String(port) !== value.trim()) {
    throw new Error(`Floway port must be an integer from 1 through 65535; received ${JSON.stringify(value)}`);
  }
  return port;
};

export const resolvePersonalRuntimePaths = (
  options: PersonalRuntimePathOptions = {},
): PersonalRuntimePaths => {
  const platform = options.platform ?? currentPlatform();
  const path = platform === 'win32' ? win32 : posix;
  const roots = resolvePersonalRuntimeRoots(options);
  const dataDir = options.dataDir === undefined ? roots.dataDir : path.normalize(options.dataDir);
  if (!path.isAbsolute(dataDir)) throw new Error(`Floway application data directory must be absolute: ${dataDir}`);

  return Object.freeze({
    dataDir,
    databasePath: path.join(dataDir, 'floway.db'),
    filesDir: path.join(dataDir, 'files'),
    logsDir: path.join(dataDir, 'logs'),
    runtimeStatePath: path.join(dataDir, 'runtime.json'),
    credentialLockDatabasePath: path.join(
      roots.credentialStateDir,
      'credential-lock',
      DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY.creationLockFilename,
    ),
  });
};

const readRuntimeState = (path: string): PersistedRuntimeState | null => {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Floway could not read runtime state at ${path}`, { cause });
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
    throw new Error(`Floway runtime state is invalid at ${path}`, { cause });
  }
};

const writeRuntimeState = (
  path: string,
  state: PersistedRuntimeState,
  permissions?: PrivateStoragePermissions,
): void => {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    permissions?.hardenFile(path);
  } catch (cause) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* preserve the original storage failure */ }
    throw new Error(`Floway could not persist runtime state at ${path}`, { cause });
  }
};

export const loadPersonalRuntime = (options: PersonalRuntimeOptions = {}): PersonalRuntime => {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolvePersonalRuntimePaths(options);
  const { dataDir, filesDir, logsDir, runtimeStatePath } = paths;
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
      `Floway cannot use application data directory ${dataDir}. Check that the location exists and is writable.`,
      { cause },
    );
  }

  const requestedPort = env.PORT === undefined ? undefined : parsePort(env.PORT);
  const storedState = readRuntimeState(runtimeStatePath);
  const previousPort = storedState?.port ?? DEFAULT_PERSONAL_PORT;
  const port = requestedPort ?? previousPort;
  if (storedState?.port !== port) writeRuntimeState(runtimeStatePath, { version: 1, port }, options.permissions);

  const endpoint = `http://${PERSONAL_HOSTNAME}:${port}`;
  if (requestedPort !== undefined && requestedPort !== previousPort) {
    (options.warn ?? console.warn)(
      `Floway endpoint changed from http://${PERSONAL_HOSTNAME}:${previousPort} to ${endpoint}. Update configured client endpoints before reconnecting.`,
    );
  }

  return {
    profile: 'personal',
    hostname: PERSONAL_HOSTNAME,
    port,
    endpoint,
    ...paths,
  };
};
