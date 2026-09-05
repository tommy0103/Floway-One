import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { settleWithCleanup } from './failure-chain.ts';

const execFileAsync = promisify(execFile);

export type MachOArchitecture = 'arm64' | 'x64';

// Apple's 64-bit Mach-O magic and CPU type definitions are the format
// authority for the app executable, embedded Node, and every native module.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/EXTERNAL_HEADERS/mach-o/loader.h#L83-L85
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/mach/machine.h#L127-L155
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/EXTERNAL_HEADERS/mach-o/fat.h#L48-L65
const MACH_O_64_MAGIC = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_ARCH_BYTES = 20;
const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_X86_64 = CPU_TYPE_X86 | CPU_ARCH_ABI64;
const CPU_TYPE_ARM64 = CPU_TYPE_ARM | CPU_ARCH_ABI64;

export const machOCpuTypeForArchitecture = (architecture: MachOArchitecture): number =>
  architecture === 'arm64' ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;

const architectureForCpuType = (cpuType: number): MachOArchitecture => {
  if (cpuType === CPU_TYPE_ARM64) return 'arm64';
  if (cpuType === CPU_TYPE_X86_64) return 'x64';
  throw new Error(`the Mach-O CPU type 0x${cpuType.toString(16)} is unsupported`);
};

export const readMachOArchitectures = async (path: string): Promise<readonly MachOArchitecture[]> => {
  let file;
  try {
    file = await open(path, 'r');
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength) throw new Error('the Mach-O header is truncated');
    if (header.readUInt32LE(0) === MACH_O_64_MAGIC) {
      return [architectureForCpuType(header.readUInt32LE(4))];
    }
    if (header.readUInt32BE(0) === MACH_O_64_MAGIC) {
      return [architectureForCpuType(header.readUInt32BE(4))];
    }

    const fatMagic = header.readUInt32BE(0);
    if (fatMagic !== FAT_MAGIC && fatMagic !== FAT_CIGAM) {
      throw new Error('the file is neither a thin 64-bit nor fat Mach-O image');
    }
    const readUInt32 = fatMagic === FAT_MAGIC
      ? (buffer: Buffer, offset: number): number => buffer.readUInt32BE(offset)
      : (buffer: Buffer, offset: number): number => buffer.readUInt32LE(offset);
    const architectureCount = readUInt32(header, 4);
    const table = Buffer.alloc(architectureCount * FAT_ARCH_BYTES);
    const tableRead = await file.read(table, 0, table.byteLength, header.byteLength);
    if (tableRead.bytesRead !== table.byteLength) throw new Error('the fat Mach-O architecture table is truncated');
    const architectures = Array.from({ length: architectureCount }, (_, index) => {
      return architectureForCpuType(readUInt32(table, index * FAT_ARCH_BYTES));
    });
    return Array.from(new Set(architectures));
  } catch (cause) {
    throw new Error(`Could not determine Mach-O architecture for ${path}`, { cause });
  } finally {
    await file?.close();
  }
};

export const assertMachOArchitecture = async (
  path: string,
  expected: MachOArchitecture,
): Promise<void> => {
  const actual = await readMachOArchitectures(path);
  if (!actual.includes(expected)) {
    throw new Error(`Mach-O architecture mismatch for ${path}: expected ${expected}, received ${actual.join(', ')}`);
  }
};

export const assertSingleMachOArchitecture = async (
  path: string,
  expected: MachOArchitecture,
): Promise<void> => {
  const actual = await readMachOArchitectures(path);
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error(
      `Mach-O package architecture mismatch for ${path}: expected only ${expected}, received ${actual.join(', ')}`,
    );
  }
};

export const thinMachOToArchitecture = async (
  path: string,
  expected: MachOArchitecture,
): Promise<void> => {
  const actual = await readMachOArchitectures(path);
  if (actual.length === 1) {
    await assertSingleMachOArchitecture(path, expected);
    return;
  }
  if (!actual.includes(expected)) {
    throw new Error(`Mach-O architecture mismatch for ${path}: expected ${expected}, received ${actual.join(', ')}`);
  }

  const output = `${path}.floway-thin-${randomUUID()}`;
  await settleWithCleanup(async () => {
    // Apple's lipo contract creates a thin output containing only the named
    // architecture; the package verifier independently rejects any fat result.
    // https://github.com/apple-oss-distributions/cctools/blob/e0d56624eca2a76c2ace4c21850df9e666de4ca5/man/lipo.1#L91-L100
    const lipoArchitecture = expected === 'x64' ? 'x86_64' : expected;
    try {
      await execFileAsync('lipo', [path, '-thin', lipoArchitecture, '-output', output]);
      await assertSingleMachOArchitecture(output, expected);
      await rename(output, path);
    } catch (cause) {
      throw new Error(`Could not make packaged native module ${path} thin for ${expected}`, { cause });
    }
  }, async () => await rm(output, { force: true }),
  `Native-module thinning failed for ${path} and temporary-output cleanup also failed`);
};
