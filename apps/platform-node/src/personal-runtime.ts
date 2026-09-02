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

export interface PersonalRuntimeRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly resolveWindowsRoamingAppData?: () => string;
  readonly stableUserHome?: string;
}

export interface PersonalRuntimePathOptions extends PersonalRuntimeRootOptions {
  readonly dataDir?: string;
}

const stableUserHome = (): string => userInfo().homedir;

let cachedWindowsRoamingAppData: string | undefined;

const queryWindowsRoamingAppData = (): string => {
  if (cachedWindowsRoamingAppData !== undefined) return cachedWindowsRoamingAppData;

  const value = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::Out.Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))',
  ], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!win32.isAbsolute(value)) {
    throw new Error(`Windows returned a non-absolute Roaming AppData Known Folder: ${value}`);
  }

  cachedWindowsRoamingAppData = win32.normalize(value);
  return cachedWindowsRoamingAppData;
};

const resolveWindowsPersonalDataDir = (windowsRoamingAppData: () => string): string => {
  let roamingAppData: string;
  try {
    roamingAppData = windowsRoamingAppData();
    if (!win32.isAbsolute(roamingAppData)) {
      throw new Error(`Windows returned a non-absolute Roaming AppData Known Folder: ${roamingAppData}`);
    }
  } catch (cause) {
    throw new Error('Floway One could not resolve the Windows Roaming AppData Known Folder', { cause });
  }

  // FOLDERID_RoamingAppData is the redirectable per-user application-data root.
  // Environment.GetFolderPath resolves it through the operating system rather
  // than trusting process environment variables or synthesizing a profile path.
  // https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid#folderid_roamingappdata
  // https://learn.microsoft.com/en-us/dotnet/api/system.environment.specialfolder
  return win32.join(win32.normalize(roamingAppData), 'Floway One');
};

export const resolveDefaultPersonalDataDir = (
  options: PersonalRuntimeRootOptions = {},
): string => {
  const platform = options.platform ?? currentPlatform();
  if (platform === 'win32') {
    return resolveWindowsPersonalDataDir(options.resolveWindowsRoamingAppData ?? queryWindowsRoamingAppData);
  }

  const userHome = options.stableUserHome ?? stableUserHome();
  if (!posix.isAbsolute(userHome)) throw new Error('Floway One requires an absolute operating-system user home directory');
  const normalizedHome = posix.normalize(userHome);
  if (platform === 'darwin') {
    // Application Support is the macOS location for app-created support files.
    // https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html
    return posix.join(normalizedHome, 'Library', 'Application Support', 'Floway One');
  }

  // Use the XDG default beneath the OS account's stable home. Process-local
  // HOME and XDG_DATA_HOME cannot split one user's credential-lock identity.
  // https://specifications.freedesktop.org/basedir-spec/latest/#variables
  // https://docs.libuv.org/en/v1.x/misc.html#c.uv_os_get_passwd
  return posix.join(normalizedHome, '.local', 'share', 'floway-one');
};

export const resolvePersonalRuntimePaths = (
  options: PersonalRuntimePathOptions = {},
): PersonalRuntimePaths => {
  const platform = options.platform ?? currentPlatform();
  const path = platform === 'win32' ? win32 : posix;
  const stableDataDir = resolveDefaultPersonalDataDir(options);
  const dataDir = options.dataDir === undefined ? stableDataDir : path.normalize(options.dataDir);
  if (!path.isAbsolute(dataDir)) throw new Error(`Floway One application data directory must be absolute: ${dataDir}`);

  return Object.freeze({
    dataDir,
    databasePath: path.join(dataDir, 'floway.db'),
    filesDir: path.join(dataDir, 'files'),
    logsDir: path.join(dataDir, 'logs'),
    runtimeStatePath: path.join(dataDir, 'runtime.json'),
    credentialLockDatabasePath: path.join(
      stableDataDir,
      'credential-lock',
      DEVICE_MASTER_KEY_CREDENTIAL_IDENTITY.creationLockFilename,
    ),
  });
};
