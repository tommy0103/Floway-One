export const aggregateCleanupFailure = (
  message: string,
  primary: unknown,
  cleanupFailures: readonly unknown[],
): AggregateError => new AggregateError(
  [primary, ...cleanupFailures],
  message,
  { cause: primary },
);

export interface FailureSafeCleanup {
  defer(label: string, action: () => Promise<void>): void;
}

interface CleanupAction {
  readonly action: () => Promise<void>;
  readonly label: string;
}

export const withFailureSafeCleanup = async <T>(
  operation: (cleanup: FailureSafeCleanup) => Promise<T>,
  message = 'Floway desktop operation failed and lifecycle cleanup also failed',
): Promise<T> => {
  const actions: CleanupAction[] = [];
  let result: T | undefined;
  let operationFailed = false;
  let primary: unknown;
  try {
    result = await operation({
      defer: (label, action) => actions.push({ action, label }),
    });
  } catch (error) {
    operationFailed = true;
    primary = error;
  }

  const cleanupFailures: unknown[] = [];
  for (const { action, label } of actions.reverse()) {
    try {
      await action();
    } catch (cause) {
      cleanupFailures.push(new Error(`Failure-safe cleanup failed for ${label}`, { cause }));
    }
  }

  if (operationFailed) {
    if (cleanupFailures.length > 0) {
      throw aggregateCleanupFailure(message, primary, cleanupFailures);
    }
    throw primary;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Floway desktop lifecycle cleanup failed', {
      cause: cleanupFailures[0],
    });
  }
  return result as T;
};

export const settleWithCleanup = async <T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  message: string,
): Promise<T> => await withFailureSafeCleanup(async failureSafe => {
  failureSafe.defer('operation cleanup', cleanup);
  return await operation();
}, message);
