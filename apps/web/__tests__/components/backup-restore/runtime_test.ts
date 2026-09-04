import { expect, test } from 'vitest';

import type { GlobalError } from '../../../src/api/client.ts';
import { resolveBackupRestoreRuntime } from '../../../src/components/backup-restore/runtime.ts';

test('runtime discovery failure remains typed and cannot fall back to legacy server controls', () => {
  const transportCause = Object.assign(new Error('runtime-info transport failed'), { code: 'ECONNRESET' });
  const error: GlobalError = { status: 0, message: 'runtime-info transport failed', cause: transportCause };

  const resolved = resolveBackupRestoreRuntime({ error });

  expect(resolved.profile).toBeNull();
  expect(resolved.error).toBe(error);
  expect(resolved.error?.cause).toBe(transportCause);
});
