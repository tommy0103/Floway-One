import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import {
  installPersonalLogging,
  PERSONAL_STDERR_LOG,
} from '../../src/personal-logging.ts';

const [mode, logsDir] = process.argv.slice(2);
if (mode === undefined || logsDir === undefined) throw new Error('Expected a failure mode and logs directory');

installPersonalLogging(logsDir);

if (mode === 'startup') {
  const storageFailure = new Error('forced storage cause');
  const migrationFailure = new Error('forced migration failure', { cause: storageFailure });
  throw new Error('forced personal startup failure', { cause: migrationFailure });
} else if (mode === 'sink') {
  const stderrPath = join(logsDir, PERSONAL_STDERR_LOG);
  renameSync(stderrPath, `${stderrPath}.moved`);
  mkdirSync(stderrPath);
  console.error('forwarded before forced sink failure');
} else {
  throw new Error(`Unsupported failure mode: ${mode}`);
}
