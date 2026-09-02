import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LOCK_WAIT_MS = 30_000;

export interface DeviceMasterKeyCreationLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

const processQueues = new Map<string, Promise<void>>();

const serializeInProcess = async <T>(databasePath: string, operation: () => Promise<T>): Promise<T> => {
  const predecessor = processQueues.get(databasePath) ?? Promise.resolve();
  let release!: () => void;
  const owner = new Promise<void>(resolveOwner => { release = resolveOwner; });
  const tail = predecessor.then(() => owner);
  processQueues.set(databasePath, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (processQueues.get(databasePath) === tail) processQueues.delete(databasePath);
  }
};

const rollback = (database: DatabaseSync): unknown => {
  try {
    database.exec('ROLLBACK');
    return undefined;
  } catch (cause) {
    return cause;
  }
};

const runWithSqliteLock = async <T>(databasePath: string, operation: () => Promise<T>): Promise<T> => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    // A bounded busy timeout lets another Floway process finish its key-store
    // operation instead of turning ordinary launch contention into a failure.
    // https://www.sqlite.org/pragma.html#pragma_busy_timeout
    database.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    // SQLite permits only one simultaneous write transaction across processes.
    // The operating system owns the database lock, so process death releases
    // it without a PID/token record that could be partially written or removed
    // after another owner replaces it.
    // https://www.sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions
    // https://www.sqlite.org/lockingv3.html#locking
    database.exec('BEGIN IMMEDIATE');
  } catch (cause) {
    try { database?.close(); } catch { /* the acquisition error remains authoritative */ }
    throw new Error('Failed to acquire the Floway One device master key creation lock', { cause });
  }

  let result: T | undefined;
  let failure: unknown;
  let transactionOpen = true;
  try {
    result = await operation();
    try {
      database.exec('COMMIT');
    } catch (cause) {
      throw new Error('Failed to release the Floway One device master key creation lock', { cause });
    }
    transactionOpen = false;
  } catch (cause) {
    failure = cause;
  }

  const cleanupFailure = transactionOpen ? rollback(database) : undefined;
  try {
    database.close();
  } catch (cause) {
    if (failure === undefined && cleanupFailure === undefined) {
      throw new Error('Failed to close the Floway One device master key creation lock database', { cause });
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) {
    throw new Error('Failed to release the Floway One device master key creation lock', { cause: cleanupFailure });
  }
  return result as T;
};

export const createDeviceMasterKeyCreationLock = (databasePath: string): DeviceMasterKeyCreationLock => {
  const resolvedPath = resolve(databasePath);
  return Object.freeze({
    run: async <T>(operation: () => Promise<T>): Promise<T> => await serializeInProcess(
      resolvedPath,
      () => runWithSqliteLock(resolvedPath, operation),
    ),
  });
};
