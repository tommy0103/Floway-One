import { execFileSync } from 'node:child_process';
import { platform as currentPlatform, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

import { DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY } from './device-master-key-credential-identity.ts';

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
    throw new Error('Floway One could not resolve the Windows Roaming AppData Known Folder', { cause });
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
  if (!posix.isAbsolute(userHome)) throw new Error('Floway One requires an absolute operating-system user home directory');
  const normalizedHome = posix.normalize(userHome);
  if (platform === 'darwin') {
    // Application Support is the macOS location for app-created support files.
    // https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
    const dataDir = posix.join(normalizedHome, 'Library', 'Application Support', 'Floway One');
    return { credentialStateDir: dataDir, dataDir };
  }

  const credentialStateDir = posix.join(normalizedHome, '.local', 'share', 'floway-one');
  const xdgDataHome = process.env.XDG_DATA_HOME;
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

export const resolvePersonalRuntimePaths = (
  options: PersonalRuntimePathOptions = {},
): PersonalRuntimePaths => {
  const platform = options.platform ?? currentPlatform();
  const path = platform === 'win32' ? win32 : posix;
  const roots = resolvePersonalRuntimeRoots(options);
  const dataDir = options.dataDir === undefined ? roots.dataDir : path.normalize(options.dataDir);
  if (!path.isAbsolute(dataDir)) throw new Error(`Floway One application data directory must be absolute: ${dataDir}`);

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
