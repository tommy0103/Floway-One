import { rm } from 'node:fs/promises';

import { type FailureSafeCleanup, withFailureSafeCleanup } from '../../src/failure-chain.ts';

export interface DisposableDesktopPath {
  readonly label: string;
  readonly path: string;
}

type RemoveTree = (path: string) => Promise<void>;

// Recursive removal can transiently receive ENOTEMPTY while Cargo finishes
// closing or recreating an output entry. Node retries that class only when
// maxRetries is nonzero, waiting retryDelay milliseconds between attempts.
// https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrmpath-options
const removeTree: RemoveTree = async path => await rm(path, {
  force: true,
  maxRetries: 10,
  recursive: true,
  retryDelay: 100,
});

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
