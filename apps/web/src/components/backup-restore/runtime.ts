import type { InferResponseType } from 'hono/client';

import type { ApiResult, GlobalError, api } from '../../api/client';

type RuntimeInfo = InferResponseType<typeof api.api['runtime-info']['$get'], 200>;

export type BackupRestoreRuntime =
  | { profile: RuntimeInfo['profile']['mode']; error: null }
  | { profile: null; error: GlobalError };

export const resolveBackupRestoreRuntime = (result: ApiResult<RuntimeInfo>): BackupRestoreRuntime =>
  result.error
    ? { profile: null, error: result.error }
    : { profile: result.data.profile.mode, error: null };
