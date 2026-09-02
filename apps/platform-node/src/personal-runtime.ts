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

export interface PersonalRuntimePathOptions {
  readonly dataDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly stableUserHome?: string;
}

const stableUserHome = (): string => userInfo().homedir;

export const resolveDefaultPersonalDataDir = (
  platform: NodeJS.Platform = currentPlatform(),
  userHome = stableUserHome(),
): string => {
  if (platform === 'win32') {
    if (!win32.isAbsolute(userHome)) throw new Error('Floway One requires an absolute operating-system user profile directory');
    // FOLDERID_RoamingAppData is the Windows per-user roaming application-data root.
    // Node's OS user record supplies the stable profile location without trusting APPDATA.
    // https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid#folderid_roamingappdata
    // https://docs.libuv.org/en/v1.x/misc.html#c.uv_os_get_passwd
    return win32.join(win32.normalize(userHome), 'AppData', 'Roaming', 'Floway One');
  }

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
  const stableDataDir = resolveDefaultPersonalDataDir(platform, options.stableUserHome ?? stableUserHome());
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
