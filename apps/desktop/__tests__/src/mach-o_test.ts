import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  assertMachOArchitecture,
  assertSingleMachOArchitecture,
  readMachOArchitectures,
} from '../../src/mach-o.ts';

const roots = new Set<string>();

const machOFixture = async (cpuType: number): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-mach-o-'));
  roots.add(root);
  const path = resolve(root, 'image');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  await writeFile(path, header);
  return path;
};

const fatMachOFixture = async (cpuTypes: readonly number[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-fat-mach-o-'));
  roots.add(root);
  const path = resolve(root, 'image');
  const header = Buffer.alloc(8 + cpuTypes.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => header.writeUInt32BE(cpuType, 8 + index * 20));
  await writeFile(path, header);
  return path;
};

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { force: true, recursive: true })));
  roots.clear();
});

test('reads the Apple arm64 and x86_64 Mach-O CPU types', async () => {
  await expect(readMachOArchitectures(await machOFixture(0x0100000c))).resolves.toEqual(['arm64']);
  await expect(readMachOArchitectures(await machOFixture(0x01000007))).resolves.toEqual(['x64']);
});

test('accepts either target architecture from an Apple universal Mach-O image', async () => {
  const path = await fatMachOFixture([0x01000007, 0x0100000c]);
  await expect(readMachOArchitectures(path)).resolves.toEqual(['x64', 'arm64']);
  await expect(assertMachOArchitecture(path, 'x64')).resolves.toBeUndefined();
  await expect(assertMachOArchitecture(path, 'arm64')).resolves.toBeUndefined();
});

test.each(['arm64', 'x64'] as const)(
  'rejects a universal native module from the %s target-specific package',
  async architecture => {
    const path = await fatMachOFixture([0x01000007, 0x0100000c]);
    await expect(assertSingleMachOArchitecture(path, architecture)).rejects.toThrow(
      `Mach-O package architecture mismatch for ${path}: expected only ${architecture}, received x64, arm64`,
    );
  },
);

test('retains the filesystem cause for a missing image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-mach-o-missing-'));
  roots.add(root);
  const path = resolve(root, 'missing');
  let error: Error | undefined;
  try {
    await readMachOArchitectures(path);
  } catch (value) {
    error = value as Error;
  }
  if (error === undefined) throw new Error('Expected missing Mach-O image to fail');
  expect(error.message).toContain(path);
  expect(error.cause).toMatchObject({ code: 'ENOENT' });
});

test('rejects a valid image built for the wrong architecture', async () => {
  const path = await machOFixture(0x01000007);
  await expect(assertMachOArchitecture(path, 'arm64')).rejects.toThrow(
    `Mach-O architecture mismatch for ${path}: expected arm64, received x64`,
  );
});

test('rejects a non-Mach-O image with its parser cause intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-mach-o-invalid-'));
  roots.add(root);
  const path = resolve(root, 'invalid');
  await mkdir(root, { recursive: true });
  await writeFile(path, Buffer.alloc(8));
  let error: Error | undefined;
  try {
    await readMachOArchitectures(path);
  } catch (value) {
    error = value as Error;
  }
  if (error === undefined) throw new Error('Expected invalid Mach-O image to fail');
  expect(error.message).toContain(path);
  expect(error.cause).toMatchObject({ message: 'the file is neither a thin 64-bit nor fat Mach-O image' });
});
