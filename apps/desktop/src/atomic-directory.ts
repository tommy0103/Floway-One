import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { settleWithCleanup } from './failure-chain.ts';

const execFileAsync = promisify(execFile);

// Darwin's RENAME_SWAP atomically exchanges two directory names, so readers
// observe either complete tree and never a half-published resource set.
// https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/include/unistd.h#L978-L981
const DARWIN_EXCHANGE_SOURCE = String.raw`
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
    perror("renameatx_np");
    return 1;
  }
  return 0;
}
`;

// Linux owns the matching RENAME_EXCHANGE contract used by the repository's
// non-packaging focused tests.
// https://github.com/torvalds/linux/blob/a500db7819c50db59e55f1b4fa1c3baa5a2616f3/include/uapi/linux/fs.h#L58-L61
const LINUX_EXCHANGE_SOURCE = String.raw`
#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  if (renameat2(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE) != 0) {
    perror("renameat2");
    return 1;
  }
  return 0;
}
`;

export type AtomicDirectoryExchange = (left: string, right: string, temporaryRoot: string) => Promise<void>;

export const exchangeDirectoriesAtomically: AtomicDirectoryExchange = async (
  left,
  right,
  temporaryRoot,
) => {
  const source = process.platform === 'darwin'
    ? DARWIN_EXCHANGE_SOURCE
    : process.platform === 'linux'
      ? LINUX_EXCHANGE_SOURCE
      : undefined;
  if (source === undefined) {
    throw new Error(`Atomic desktop input exchange is unsupported on ${process.platform}`);
  }

  await mkdir(temporaryRoot, { recursive: true });
  const helperRoot = await mkdtemp(join(temporaryRoot, '.atomic-exchange-'));
  await settleWithCleanup(async () => {
    const sourcePath = join(helperRoot, 'exchange.c');
    const executable = join(helperRoot, 'exchange');
    await writeFile(sourcePath, source);
    await execFileAsync('cc', ['-O2', sourcePath, '-o', executable]);
    await chmod(executable, 0o755);
    try {
      await execFileAsync(executable, [left, right]);
    } catch (cause) {
      throw new Error('Failed to atomically exchange complete desktop input trees', { cause });
    }
  }, async () => await rm(helperRoot, { force: true, recursive: true }),
  'Atomic desktop input exchange failed and helper cleanup also failed');
};
