import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Microsoft documents this GUID as FOLDERID_RoamingAppData.
// https://github.com/MicrosoftDocs/win32/blob/79eaaa46b30bd0efef0d0f5a65fd7d11fdd8e2de/desktop-src/shell/knownfolderid.md#folderid_roamingappdata
export const WINDOWS_ROAMING_APP_DATA_FOLDER_ID = '3EB685DB-65F9-4CF6-A03A-E3EF65729F3D';
// Microsoft defines S-1-5-32-544 as the built-in Administrators group.
// https://github.com/MicrosoftDocs/win32/blob/79eaaa46b30bd0efef0d0f5a65fd7d11fdd8e2de/desktop-src/SecAuthZ/well-known-sids.md#well-known-sids
const WINDOWS_BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544';

export const readWindowsRoamingAppData = async (): Promise<string> => {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::Out.Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))',
  ], { encoding: 'utf8' });
  const roamingAppData = stdout.trim();
  if (!isAbsolute(roamingAppData)) throw new Error(`Windows returned a non-absolute Roaming AppData Known Folder: ${roamingAppData}`);
  return roamingAppData;
};

export const setWindowsRoamingAppData = async (path: string): Promise<void> => {
  // SHSetKnownFolderPath is the official Known Folder redirection boundary.
  // https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shsetknownfolderpath
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
$FolderId = [Guid]'${WINDOWS_ROAMING_APP_DATA_FOLDER_ID}'
$Path = [Environment]::GetEnvironmentVariable('FLOWAY_REDIRECTED_KNOWN_FOLDER')
$HResult = [FlowayKnownFolderRedirect]::SHSetKnownFolderPath([ref]$FolderId, 0, [IntPtr]::Zero, $Path)
if ($HResult -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($HResult) }
`], { env: { ...process.env, FLOWAY_REDIRECTED_KNOWN_FOLDER: path } });
};

export type WindowsAclExpectation = 'directory' | 'inherited-file' | 'protected-file';

export const assertWindowsOwnerOnlyAcl = async (target: string, expectation: WindowsAclExpectation): Promise<void> => {
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
  throw "ACL verification failed for $Target as $Expectation"
}
`], {
    env: { ...process.env, FLOWAY_ACL_VERIFY_EXPECTATION: expectation, FLOWAY_ACL_VERIFY_TARGET: target },
  });
};

export const setWindowsOwnerToAdministrators = async (target: string): Promise<void> => {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$Target = [Environment]::GetEnvironmentVariable('FLOWAY_ACL_OWNER_TARGET')
$Acl = [System.IO.File]::GetAccessControl($Target)
$Acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_BUILTIN_ADMINISTRATORS_SID}'))
[System.IO.File]::SetAccessControl($Target, $Acl)
`], { env: { ...process.env, FLOWAY_ACL_OWNER_TARGET: target } });
};
