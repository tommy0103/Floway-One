import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { assertSingleMachOArchitecture } from '../../src/mach-o.ts';
import { architectureForTargetTriple, type DesktopTargetTriple } from '../../src/release-contract.ts';

const execFileAsync = promisify(execFile);

interface NodeDistribution {
  readonly archive: string;
  readonly sha256: string;
}

// https://nodejs.org/dist/v24.19.0/SHASUMS256.txt
const NODE_DISTRIBUTIONS: Record<string, Partial<Record<DesktopTargetTriple, NodeDistribution>>> = {
  '24.19.0': {
    'aarch64-apple-darwin': {
      archive: 'node-v24.19.0-darwin-arm64.tar.gz',
      sha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
    },
    'x86_64-apple-darwin': {
      archive: 'node-v24.19.0-darwin-x64.tar.gz',
      sha256: 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
    },
  },
};

export const nodeDistributionForTarget = (
  version: string,
  targetTriple: DesktopTargetTriple,
): NodeDistribution => {
  const distribution = NODE_DISTRIBUTIONS[version]?.[targetTriple];
  if (distribution === undefined) {
    throw new Error(`No locked Node.js ${version} distribution is configured for ${targetTriple}`);
  }
  return distribution;
};

export const acquireNodeDistribution = async (
  version: string,
  targetTriple: DesktopTargetTriple,
  outputRoot: string,
): Promise<string> => {
  const distribution = nodeDistributionForTarget(version, targetTriple);
  const response = await fetch(`https://nodejs.org/dist/v${version}/${distribution.archive}`);
  if (!response.ok) throw new Error(`Node.js archive ${distribution.archive} returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash('sha256').update(archive).digest('hex');
  if (actualHash !== distribution.sha256) {
    throw new Error(`Node.js archive ${distribution.archive} has SHA-256 ${actualHash}; expected ${distribution.sha256}`);
  }
  await mkdir(outputRoot, { recursive: true });
  const archivePath = resolve(outputRoot, distribution.archive);
  await writeFile(archivePath, archive);
  await execFileAsync('tar', ['-xzf', archivePath, '-C', outputRoot]);
  const directory = distribution.archive.replace(/\.tar\.gz$/, '');
  const executable = resolve(outputRoot, directory, 'bin/node');
  await readFile(executable);
  await assertSingleMachOArchitecture(executable, architectureForTargetTriple(targetTriple));
  return executable;
};
