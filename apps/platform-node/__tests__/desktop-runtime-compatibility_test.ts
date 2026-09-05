import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  loadDesktopRuntimeCompatibility,
} from '../src/desktop-runtime-compatibility.ts';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { force: true, recursive: true })));
  roots.clear();
});

const writeContract = async (value: unknown): Promise<{ path: string; source: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-desktop-contract-'));
  roots.add(root);
  const path = join(root, 'desktop-bundle-contract.json');
  const source = `${JSON.stringify(value, undefined, 2)}\n`;
  await writeFile(path, source);
  return { path, source };
};

test('loads the matching packaged desktop release and returns its exact digest', async () => {
  const { path, source } = await writeContract({
    schemaVersion: 2,
    compatibility: { protocolVersion: 1, releaseVersion: '0.1.0' },
  });

  expect(loadDesktopRuntimeCompatibility(path)).toEqual({
    contractDigest: createHash('sha256').update(source).digest('hex'),
    protocolVersion: 1,
    releaseVersion: '0.1.0',
  });
});

test('keeps ordinary server and personal development runtimes free of desktop coupling', () => {
  expect(loadDesktopRuntimeCompatibility(undefined)).toBeNull();
});

test.each([
  [{ schemaVersion: 1, compatibility: { protocolVersion: 1, releaseVersion: '0.1.0' } }, 'schema 1'],
  [{ schemaVersion: 2, compatibility: { protocolVersion: 2, releaseVersion: '0.1.0' } }, 'protocol 2'],
  [{ schemaVersion: 2, compatibility: { protocolVersion: 1, releaseVersion: '0.2.0' } }, 'sidecar 0.1.0'],
])('rejects an incompatible contract while retaining exact values', async (contract, message) => {
  const { path } = await writeContract(contract);
  expect(() => loadDesktopRuntimeCompatibility(path)).toThrow(message);
});
