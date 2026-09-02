import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  type Stats,
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
$Root = [Environment]::GetEnvironmentVariable('FLOWAY_PERSONAL_ACL_TARGET')
$Kind = [Environment]::GetEnvironmentVariable('FLOWAY_PERSONAL_ACL_KIND')
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Protect-FlowayPath([string] $Target, [bool] $IsDirectory) {
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
}
if ($Kind -eq 'tree') {
  $Items = @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  Protect-FlowayPath $Root $true
  foreach ($Item in $Items) { Protect-FlowayPath $Item.FullName $Item.PSIsContainer }
} else {
  Protect-FlowayPath $Root ($Kind -eq 'directory')
}
`;

type WindowsAclKind = 'directory' | 'file' | 'tree';

const applyWindowsOwnerOnlyAcl = (path: string, kind: WindowsAclKind): void => {
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
  readonly applyWindowsAcl?: (path: string, kind: WindowsAclKind) => void;
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
  private readonly applyWindowsAcl: (path: string, kind: WindowsAclKind) => void;
  private readonly hardenedWindowsPaths = new Map<string, string>();

  constructor(
    private readonly paths: PersonalRuntimePaths,
    options: PersonalStorageHardenerOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.posixUid = options.posixUid ?? userInfo().uid;
    this.applyWindowsAcl = options.applyWindowsAcl ?? applyWindowsOwnerOnlyAcl;
  }

  initialize(): void {
    if (this.platform === 'win32') {
      this.createDirectory(this.paths.dataDir);
      this.createDirectory(this.paths.filesDir);
      this.createDirectory(this.paths.logsDir);
      const entries = this.windowsTreeEntries(this.paths.dataDir);
      try {
        this.applyWindowsAcl(this.paths.dataDir, 'tree');
      } catch (cause) {
        throw new Error(`Floway One could not enforce current-user-only access on directory ${this.paths.dataDir}`, { cause });
      }
      for (const entry of entries) this.hardenedWindowsPaths.set(entry.path, entry.identity);
      return;
    }
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
        this.hardenedWindowsPaths.delete(path);
        continue;
      }
      this.hardenFile(path);
    }
  }

  private createDirectory(path: string): void {
    try {
      mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    } catch (cause) {
      throw new Error(`Floway One could not enforce current-user-only access on directory ${path}`, { cause });
    }
  }

  private windowsTreeEntries(root: string): Array<{ identity: string; path: string }> {
    const entries: Array<{ identity: string; path: string }> = [];
    const visit = (path: string): void => {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`Floway One personal storage cannot contain symbolic links: ${path}`);
      entries.push({ identity: this.fileIdentity(metadata), path });
      if (metadata.isDirectory()) {
        for (const child of readdirSync(path)) visit(join(path, child));
      }
    };
    visit(root);
    return entries;
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
      const identity = this.fileIdentity(metadata);
      if (this.hardenedWindowsPaths.get(path) === identity) return;
      this.applyWindowsAcl(path, kind);
      this.hardenedWindowsPaths.set(path, identity);
      return;
    }

    const expectedMode = kind === 'directory' ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
    chmodSync(path, expectedMode);
    const verified = statSync(path);
    if (verified.uid !== this.posixUid || (verified.mode & 0o777) !== expectedMode) {
      throw new Error(`Floway One could not verify current-user-only access on ${path}`);
    }
  }

  private fileIdentity(metadata: Stats): string {
    return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
  }
}
