import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Release assembly for the macOS desktop application: the two per-architecture
// build jobs hand this script a directory of artifacts and it writes the
// updater manifest and the digest evidence the GitHub Release is published
// with. Failures are loud — a release missing an architecture must not
// publish.

export const MACOS_UPDATER_PLATFORMS = {
  aarch64: 'darwin-aarch64',
  x64: 'darwin-x86_64',
} as const;

export type MacosReleaseArchitecture = keyof typeof MACOS_UPDATER_PLATFORMS;

export interface ReleaseArtifactSet {
  // The Tauri updater pair (app tarball + minisign signature).
  updater: string;
  updaterSignature: string;
  // The operator-facing installer.
  installer: string;
}

const artifactNames = (version: string, architecture: MacosReleaseArchitecture): ReleaseArtifactSet => ({
  updater: `Floway_${version}_${architecture}.app.tar.gz`,
  updaterSignature: `Floway_${version}_${architecture}.app.tar.gz.sig`,
  installer: `Floway_${version}_${architecture}.dmg`,
});

export const findReleaseArtifacts = (
  version: string,
  files: readonly string[],
): Record<MacosReleaseArchitecture, ReleaseArtifactSet> => {
  const result = {} as Record<MacosReleaseArchitecture, ReleaseArtifactSet>;
  for (const architecture of Object.keys(MACOS_UPDATER_PLATFORMS) as MacosReleaseArchitecture[]) {
    const expected = artifactNames(version, architecture);
    const missing = Object.values(expected).filter(name => !files.includes(name));
    if (missing.length > 0) {
      throw new Error(`macOS ${architecture} release artifacts are missing: ${missing.join(', ')}`);
    }
    result[architecture] = expected;
  }
  return result;
};

// The Tauri updater manifest format: one platforms entry per architecture,
// each carrying the release download URL and the minisign signature content.
// https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-cli/src/helpers/updater_signature.rs
export const buildUpdateManifest = async (
  { repo, tag, version, dir, artifacts, notes, pubDate }: {
    repo: string;
    tag: string;
    version: string;
    dir: string;
    artifacts: Record<MacosReleaseArchitecture, ReleaseArtifactSet>;
    notes: string;
    pubDate: string;
  },
): Promise<string> => {
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const [architecture, set] of Object.entries(artifacts) as [MacosReleaseArchitecture, ReleaseArtifactSet][]) {
    const signature = (await readFile(join(dir, set.updaterSignature), 'utf8')).trim();
    if (!signature) throw new Error(`The updater signature ${set.updaterSignature} is empty`);
    platforms[MACOS_UPDATER_PLATFORMS[architecture]] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${set.updater}`,
    };
  }
  return `${JSON.stringify({ version, notes, pub_date: pubDate, platforms }, null, 2)}\n`;
};

export const buildSha256Sums = async (
  dir: string,
  artifacts: Record<MacosReleaseArchitecture, ReleaseArtifactSet>,
): Promise<string> => {
  const lines: string[] = [];
  for (const set of Object.values(artifacts)) {
    for (const name of [set.installer, set.updater, set.updaterSignature]) {
      const digest = createHash('sha256').update(await readFile(join(dir, name))).digest('hex');
      lines.push(`${digest}  ${name}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

export const readReleaseNotes = async (path: string): Promise<string> => {
  const notes = await readFile(path, 'utf8');
  if (!notes.trim()) throw new Error(`Release notes are empty: ${path}`);
  if ([...notes].length > 65_536) throw new Error(`Release notes exceed 65536 characters: ${path}`);
  return notes;
};

const main = async (): Promise<void> => {
  const arguments_ = process.argv.slice(2).filter(argument => argument !== '--');
  const option = (name: string): string | undefined =>
    arguments_.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const version = option('version');
  const tag = option('tag');
  const repo = option('repo');
  const dir = option('dir');
  const known = ['version', 'tag', 'repo', 'dir', 'notes-file'];
  if (!version || !tag || !repo || !dir || arguments_.some(argument => !known.some(name => argument.startsWith(`--${name}=`)))) {
    throw new Error('Usage: release-manifest.ts --version=X.Y.Z --tag=vX.Y.Z --repo=owner/repo --dir=<artifacts>');
  }
  const artifacts = findReleaseArtifacts(version, await readdir(dir));
  await writeFile(join(dir, 'floway-update.json'), await buildUpdateManifest({
    repo,
    tag,
    version,
    dir,
    artifacts,
    notes: option('notes-file') ? await readReleaseNotes(option('notes-file')!) : `Floway ${tag}`,
    pubDate: new Date().toISOString(),
  }));
  await writeFile(join(dir, 'sha256sums.txt'), await buildSha256Sums(dir, artifacts));
  console.log(`Release manifest and digests written for ${tag}`);
};

if (process.argv[1]?.endsWith('release-manifest.ts')) {
  await main();
}
