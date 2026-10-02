import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { collectReleaseArtifacts } from '../collect-release-artifacts.ts';
import { buildUpdateManifest, findReleaseArtifacts } from '../release-manifest.ts';
import type { MacosReleaseArchitecture } from '../release-manifest.ts';

const fixture = async (operation: (root: string, bundle: (architecture: MacosReleaseArchitecture) => Promise<string>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'floway-release-collection-'));
  try {
    await operation(root, async architecture => {
      const path = join(root, architecture);
      await mkdir(join(path, 'dmg'), { recursive: true });
      await mkdir(join(path, 'macos'));
      await writeFile(join(path, `dmg/Floway_0.1.0_${architecture}.dmg`), `installer-${architecture}`);
      await writeFile(join(path, 'macos/Floway.app.tar.gz'), Buffer.from(`signed-tarball-${architecture}\0`));
      await writeFile(join(path, 'macos/Floway.app.tar.gz.sig'), `signature-${architecture}\n`);
      return path;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('Floway architecture collection preserves signed bytes and yields both manifest download targets', () => fixture(async (root, bundle) => {
  const destination = join(root, 'release');
  for (const architecture of ['aarch64', 'x64'] as const) {
    const bundleRoot = await bundle(architecture);
    await collectReleaseArtifacts({ bundleRoot, destination, version: '0.1.0', architecture, updaterRequired: true });
    for (const suffix of ['app.tar.gz', 'app.tar.gz.sig']) {
      expect(await readFile(join(destination, `Floway_0.1.0_${architecture}.${suffix}`)))
        .toEqual(await readFile(join(bundleRoot, `macos/Floway.${suffix}`)));
    }
  }
  const files = await readdir(destination);
  expect(files).toHaveLength(6);
  const manifest = JSON.parse(await buildUpdateManifest({
    repo: 'example/floway', tag: 'v0.1.0', version: '0.1.0', dir: destination,
    artifacts: findReleaseArtifacts('0.1.0', files), notes: 'Floway changes', pubDate: '2026-10-03T00:00:00.000Z',
  })) as { platforms: Record<string, { url: string; signature: string }> };
  expect(manifest.platforms['darwin-aarch64']?.url).toContain('Floway_0.1.0_aarch64.app.tar.gz');
  expect(manifest.platforms['darwin-x86_64']?.url).toContain('Floway_0.1.0_x64.app.tar.gz');
  expect(manifest.platforms['darwin-x86_64']?.signature).toBe('signature-x64');
}));

test('Floway collection rejects a missing or empty signature before copying any release assets', () => fixture(async (root, bundle) => {
  const bundleRoot = await bundle('aarch64');
  const destination = join(root, 'release');
  const options = { bundleRoot, destination, version: '0.1.0', architecture: 'aarch64', updaterRequired: true } as const;
  await rm(join(bundleRoot, 'macos/Floway.app.tar.gz.sig'));
  await expect(collectReleaseArtifacts(options)).rejects.toThrow(/ENOENT/);
  await expect(readdir(destination)).rejects.toThrow(/ENOENT/);
  await writeFile(join(bundleRoot, 'macos/Floway.app.tar.gz.sig'), '');
  await expect(collectReleaseArtifacts(options)).rejects.toThrow(/empty/);
  await expect(readdir(destination)).rejects.toThrow(/ENOENT/);
}));

test('Floway unsigned preview preserves the installer-only artifact path', () => fixture(async (root, bundle) => {
  const bundleRoot = await bundle('aarch64');
  await rm(join(bundleRoot, 'macos'), { recursive: true });
  const destination = join(root, 'preview');
  await collectReleaseArtifacts({ bundleRoot, destination, version: '0.1.0', architecture: 'aarch64', updaterRequired: false });
  expect(await readdir(destination)).toEqual(['Floway_0.1.0_aarch64.dmg']);
}));
