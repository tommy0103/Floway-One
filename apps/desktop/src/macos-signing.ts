import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { visitFileTree } from './filesystem-tree.ts';
import { isMachOFile } from './mach-o.ts';

const execute = promisify(execFile);

// Tauri signs its shell and external binaries, but resource files are outside
// its nested-code inventory. Sign those bytes before the runtime integrity
// contract is frozen, then let Tauri seal and notarize the complete app.
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/app.rs#L89-L121
export const signPackagedMachOResources = async (runtimeRoot: string, identity: string): Promise<void> => {
  await visitFileTree(runtimeRoot, async ({ dirent, path }) => {
    if (!dirent.isFile() || !(await isMachOFile(path))) return;
    try {
      // A secure timestamp is required for notarization; executable tools also
      // need hardened runtime. The same Team ID keeps Node library validation.
      // https://developer.apple.com/documentation/security/resolving-common-notarization-issues
      await execute('codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', path]);
      await execute('codesign', ['--verify', '--strict', path]);
    } catch (cause) {
      throw new Error(`Floway could not sign packaged native code ${path}`, { cause });
    }
  });
};
