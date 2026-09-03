import { open } from 'node:fs/promises';

export type MachOArchitecture = 'arm64' | 'x64';

// Apple's 64-bit Mach-O magic and CPU type definitions are the format
// authority for the app executable, embedded Node, and every native module.
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/EXTERNAL_HEADERS/mach-o/loader.h#L83-L85
// https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/mach/machine.h#L127-L155
const MACH_O_64_MAGIC = 0xfeedfacf;
const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_X86_64 = CPU_TYPE_X86 | CPU_ARCH_ABI64;
const CPU_TYPE_ARM64 = CPU_TYPE_ARM | CPU_ARCH_ABI64;

export const machOCpuTypeForArchitecture = (architecture: MachOArchitecture): number =>
  architecture === 'arm64' ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;

export const readMachOArchitecture = async (path: string): Promise<MachOArchitecture> => {
  let file;
  try {
    file = await open(path, 'r');
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength) throw new Error('the Mach-O header is truncated');
    if (header.readUInt32LE(0) !== MACH_O_64_MAGIC) throw new Error('the file is not a thin 64-bit Mach-O image');
    const cpuType = header.readUInt32LE(4);
    if (cpuType === CPU_TYPE_ARM64) return 'arm64';
    if (cpuType === CPU_TYPE_X86_64) return 'x64';
    throw new Error(`the Mach-O CPU type 0x${cpuType.toString(16)} is unsupported`);
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
  const actual = await readMachOArchitecture(path);
  if (actual !== expected) {
    throw new Error(`Mach-O architecture mismatch for ${path}: expected ${expected}, received ${actual}`);
  }
};
