import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import type { PersonalRuntimePaths } from './personal-runtime.ts';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

// Build and verify one protected DACL containing only the current Windows SID.
// SetAccessRuleProtection(true, false) removes inherited rules rather than
// converting them to explicit entries.
// https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection
// https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.setaccesscontrol
const WINDOWS_OWNER_ONLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$Target = [Environment]::GetEnvironmentVariable('FLOWAY_PERSONAL_ACL_TARGET')
$Kind = [Environment]::GetEnvironmentVariable('FLOWAY_PERSONAL_ACL_KIND')
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$IsDirectory = $Kind -eq 'directory'
if ($IsDirectory) {
  $Acl = New-Object System.Security.AccessControl.DirectorySecurity
  $Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $Acl = New-Object System.Security.AccessControl.FileSecurity
  $Inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$Acl.SetAccessRuleProtection($true, $false)
$Acl.SetOwner($Sid)
$Rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $Sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $Inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void] $Acl.AddAccessRule($Rule)
if ($IsDirectory) {
  [System.IO.Directory]::SetAccessControl($Target, $Acl)
  $Verified = [System.IO.Directory]::GetAccessControl($Target)
} else {
  [System.IO.File]::SetAccessControl($Target, $Acl)
  $Verified = [System.IO.File]::GetAccessControl($Target)
}
$Rules = @($Verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $Verified.AreAccessRulesProtected -or $Verified.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $Sid -or $Rules.Count -ne 1 -or $Rules[0].IdentityReference -ne $Sid -or $Rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $Rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw "Floway One failed to verify the owner-only ACL for $Target"
}
`;

const applyWindowsOwnerOnlyAcl = (path: string, kind: 'directory' | 'file'): void => {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_OWNER_ONLY_ACL_SCRIPT], {
    env: {
      ...process.env,
      FLOWAY_PERSONAL_ACL_KIND: kind,
      FLOWAY_PERSONAL_ACL_TARGET: path,
    },
    stdio: 'pipe',
  });
};

export interface PrivateStoragePermissions {
  ensureDirectory(path: string): void;
  hardenFile(path: string): void;
  hardenSqliteFiles(databasePath: string): void;
}

interface PersonalStorageHardenerOptions {
  readonly platform?: NodeJS.Platform;
  readonly posixUid?: number;
  readonly applyWindowsAcl?: (path: string, kind: 'directory' | 'file') => void;
}

const sqliteFiles = (databasePath: string): readonly string[] => [
  databasePath,
  `${databasePath}-journal`,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
];

export class PersonalStorageHardener implements PrivateStoragePermissions {
  private readonly platform: NodeJS.Platform;
  private readonly posixUid: number;
  private readonly applyWindowsAcl: (path: string, kind: 'directory' | 'file') => void;
  private readonly hardenedSqliteFiles = new Map<string, string>();

  constructor(
    private readonly paths: PersonalRuntimePaths,
    options: PersonalStorageHardenerOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.posixUid = options.posixUid ?? userInfo().uid;
    this.applyWindowsAcl = options.applyWindowsAcl ?? applyWindowsOwnerOnlyAcl;
  }

  initialize(): void {
    this.ensureDirectory(this.paths.dataDir);
    this.ensureDirectory(this.paths.filesDir);
    this.ensureDirectory(this.paths.logsDir);
    this.hardenTree(this.paths.filesDir);
    this.hardenTree(this.paths.logsDir);
    if (existsSync(this.paths.runtimeStatePath)) this.hardenFile(this.paths.runtimeStatePath);
    this.hardenSqliteFiles(this.paths.databasePath);
  }

  ensureDirectory(path: string): void {
    try {
      mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      this.applyPrivateAccess(path, 'directory');
    } catch (cause) {
      throw new Error(`Floway One could not enforce current-user-only access on directory ${path}`, { cause });
    }
  }

  hardenFile(path: string): void {
    try {
      this.applyPrivateAccess(path, 'file');
    } catch (cause) {
      throw new Error(`Floway One could not enforce current-user-only access on file ${path}`, { cause });
    }
  }

  hardenSqliteFiles(databasePath: string): void {
    for (const path of sqliteFiles(databasePath)) {
      if (!existsSync(path)) {
        this.hardenedSqliteFiles.delete(path);
        continue;
      }
      if (this.platform !== 'win32') {
        this.hardenFile(path);
        continue;
      }
      const metadata = lstatSync(path);
      const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
      if (this.hardenedSqliteFiles.get(path) === identity) continue;
      this.hardenFile(path);
      this.hardenedSqliteFiles.set(path, identity);
    }
  }

  private hardenTree(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Floway One personal storage cannot contain symbolic links: ${child}`);
      }
      if (entry.isDirectory()) {
        this.ensureDirectory(child);
        this.hardenTree(child);
      } else {
        this.hardenFile(child);
      }
    }
  }

  private applyPrivateAccess(path: string, kind: 'directory' | 'file'): void {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`Floway One personal storage path is a symbolic link: ${path}`);
    if (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new Error(`Floway One personal storage path is not a ${kind}: ${path}`);
    }
    if (this.platform === 'win32') {
      this.applyWindowsAcl(path, kind);
      return;
    }

    const expectedMode = kind === 'directory' ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
    chmodSync(path, expectedMode);
    const verified = statSync(path);
    if (verified.uid !== this.posixUid || (verified.mode & 0o777) !== expectedMode) {
      throw new Error(`Floway One could not verify current-user-only access on ${path}`);
    }
  }
}
