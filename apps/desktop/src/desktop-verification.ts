import { rm } from 'node:fs/promises';

import { type FailureSafeCleanup, withFailureSafeCleanup } from './failure-chain.ts';

export interface DisposableDesktopPath {
  readonly label: string;
  readonly path: string;
}

type RemoveTree = (path: string) => Promise<void>;

const removeTree: RemoveTree = async path => await rm(path, { force: true, recursive: true });

export const deferDisposableDesktopPaths = (
  cleanup: FailureSafeCleanup,
  paths: readonly DisposableDesktopPath[],
  remove: RemoveTree = removeTree,
): void => {
  for (const disposable of paths) {
    cleanup.defer(disposable.label, async () => await remove(disposable.path));
  }
};

export const removeDisposableDesktopPaths = async (
  paths: readonly DisposableDesktopPath[],
  remove: RemoveTree = removeTree,
): Promise<void> => await withFailureSafeCleanup(async cleanup => {
  deferDisposableDesktopPaths(cleanup, paths, remove);
}, 'Floway desktop output removal had multiple failures');
