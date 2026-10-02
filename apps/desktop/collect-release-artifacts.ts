import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { architectureForTargetTriple, readDesktopReleaseVersion } from './src/release-contract.ts';
import type { MacosReleaseArchitecture } from './release-manifest.ts';

export const collectReleaseArtifacts = async (
  { bundleRoot, destination, version, architecture, updaterRequired }: {
    bundleRoot: string;
    destination: string;
    version: string;
    architecture: MacosReleaseArchitecture;
    updaterRequired: boolean;
  },
): Promise<void> => {
  const installer = `Floway_${version}_${architecture}.dmg`;
  const files = [[resolve(bundleRoot, 'dmg', installer), installer]];
  if (updaterRequired) {
    // Tauri emits the same app archive name for both architectures. Copy the
    // signed bytes verbatim into distinct versioned release asset names.
    // https://v2.tauri.app/plugin/updater/#building
    files.push(
      [resolve(bundleRoot, 'macos/Floway.app.tar.gz'), `Floway_${version}_${architecture}.app.tar.gz`],
      [resolve(bundleRoot, 'macos/Floway.app.tar.gz.sig'), `Floway_${version}_${architecture}.app.tar.gz.sig`],
    );
  }
  for (const [source] of files) {
    const info = await stat(source!);
    if (!info.isFile() || info.size === 0) throw new Error(`Floway release artifact is empty or not a file: ${source}`);
  }
  await mkdir(destination, { recursive: true });
  for (const [source, name] of files) await copyFile(source!, resolve(destination, name!));
};

if (process.argv[1]?.endsWith('collect-release-artifacts.ts')) {
  const args = process.argv.slice(2).filter(argument => argument !== '--');
  const option = (name: string): string | undefined => args.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const target = option('target');
  const destination = option('dir');
  const updater = option('updater');
  if (!target || !destination || !['true', 'false'].includes(updater ?? '')
    || args.some(argument => !['target', 'dir', 'updater'].some(name => argument.startsWith(`--${name}=`)))) {
    throw new Error('Usage: collect-release-artifacts.ts --target=<macOS triple> --dir=<destination> --updater=true|false');
  }
  const desktopRoot = dirname(fileURLToPath(import.meta.url));
  await collectReleaseArtifacts({
    bundleRoot: resolve(desktopRoot, 'src-tauri/target', target, 'release/bundle'),
    destination, version: await readDesktopReleaseVersion(desktopRoot),
    architecture: architectureForTargetTriple(target) === 'arm64' ? 'aarch64' : 'x64', updaterRequired: updater === 'true',
  });
}
