import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface FileTreeEntry {
  readonly dirent: Dirent;
  readonly path: string;
}

export type FileTreeVisitResult = 'skip-directory' | void;

export const visitFileTree = async (
  root: string,
  visit: (entry: FileTreeEntry) => FileTreeVisitResult | Promise<FileTreeVisitResult>,
): Promise<void> => {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const dirent of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, dirent.name);
      const result = await visit({ dirent, path });
      if (dirent.isDirectory() && result !== 'skip-directory') pending.push(path);
    }
  }
};
