import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import {
  buildSha256Sums,
  buildUpdateManifest,
  findReleaseArtifacts,
} from '../release-manifest.ts';

const withArtifacts = async (operation: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'floway-release-manifest-'));
  try {
    for (const architecture of ['aarch64', 'x64'] as const) {
      await writeFile(join(dir, `Floway_0.1.0_${architecture}.app.tar.gz`), `tarball-${architecture}`);
      await writeFile(join(dir, `Floway_0.1.0_${architecture}.app.tar.gz.sig`), `signature-${architecture}\n`);
      await writeFile(join(dir, `Floway_0.1.0_${architecture}.dmg`), `installer-${architecture}`);
    }
    await operation(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fakeArtifacts = {
  aarch64: {
    updater: 'Floway_0.1.0_aarch64.app.tar.gz',
    updaterSignature: 'Floway_0.1.0_aarch64.app.tar.gz.sig',
    installer: 'Floway_0.1.0_aarch64.dmg',
  },
  x64: {
    updater: 'Floway_0.1.0_x64.app.tar.gz',
    updaterSignature: 'Floway_0.1.0_x64.app.tar.gz.sig',
    installer: 'Floway_0.1.0_x64.dmg',
  },
} as const;

test('the update manifest carries both macOS platforms with their signatures and release URLs', () => withArtifacts(async dir => {
  const manifest = JSON.parse(await buildUpdateManifest({
    repo: 'tommy0103/Floway-One',
    tag: 'v0.1.0',
    version: '0.1.0',
    dir,
    artifacts: fakeArtifacts,
    notes: 'Floway v0.1.0',
    pubDate: '2026-09-28T00:00:00.000Z',
  }));
  expect(manifest.version).toBe('0.1.0');
  expect(manifest.pub_date).toBe('2026-09-28T00:00:00.000Z');
  expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
  expect(manifest.platforms['darwin-aarch64']).toEqual({
    signature: 'signature-aarch64',
    url: 'https://github.com/tommy0103/Floway-One/releases/download/v0.1.0/Floway_0.1.0_aarch64.app.tar.gz',
  });
  expect(manifest.platforms['darwin-x86_64'].signature).toBe('signature-x64');
}));

test('the digest evidence covers every installer and updater artifact', () => withArtifacts(async dir => {
  const sums = await buildSha256Sums(dir, fakeArtifacts);
  const lines = sums.trim().split('\n');
  expect(lines.length).toBe(6);
  for (const line of lines) {
    expect(line).toMatch(/^[0-9a-f]{64} {2}Floway_0\.1\.0_(aarch64|x64)\.(dmg|app\.tar\.gz|app\.tar\.gz\.sig)$/);
  }
}));

test('a missing architecture fails the release instead of publishing a partial manifest', () => withArtifacts(async () => {
  expect(() => findReleaseArtifacts('0.1.0', [
    'Floway_0.1.0_aarch64.app.tar.gz',
    'Floway_0.1.0_aarch64.app.tar.gz.sig',
    'Floway_0.1.0_aarch64.dmg',
  ])).toThrowError(/x64.*missing/);
}));

test('an empty updater signature fails the manifest', () => withArtifacts(async dir => {
  await writeFile(join(dir, 'Floway_0.1.0_aarch64.app.tar.gz.sig'), '   \n');
  await expect(buildUpdateManifest({
    repo: 'tommy0103/Floway-One',
    tag: 'v0.1.0',
    version: '0.1.0',
    dir,
    artifacts: fakeArtifacts,
    notes: '',
    pubDate: '2026-09-28T00:00:00.000Z',
  })).rejects.toThrow(/empty/);
}));
