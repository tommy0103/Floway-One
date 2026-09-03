import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNodeEntry } from './src/run-node-entry.ts';

export { runNodeEntry };

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runNodeEntry();
}
