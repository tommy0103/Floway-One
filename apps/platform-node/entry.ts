import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NodeEntryInfo, NodeEntryOverrides } from './src/run-node-entry.ts';
import { reportDesktopStartupFailure } from './src/startup-failure.ts';

export const runNodeEntry = async (overrides?: NodeEntryOverrides): Promise<NodeEntryInfo> => {
  const implementation = await import('./src/run-node-entry.ts');
  return await implementation.runNodeEntry(overrides);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runNodeEntry();
  } catch (failure) {
    reportDesktopStartupFailure(failure, 'native-dependency');
    throw failure;
  }
}
