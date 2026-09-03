import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolvePersonalRuntimePaths } from './personal-runtime.ts';

const LOCK_WAIT_MS = 30_000;

export interface DeviceMasterKeyCreationLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

interface DeviceMasterKeyCreationLockOptions {
  lockDatabasePath?: string;
}

const processQueues = new Map<string, Promise<void>>();

const serializeInProcess = async <T>(lockDatabasePath: string, operation: () => Promise<T>): Promise<T> => {
  const predecessor = processQueues.get(lockDatabasePath) ?? Promise.resolve();
  let release!: () => void;
  const owner = new Promise<void>(resolveOwner => { release = resolveOwner; });
  const tail = predecessor.then(() => owner);
  processQueues.set(lockDatabasePath, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (processQueues.get(lockDatabasePath) === tail) processQueues.delete(lockDatabasePath);
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

const preparePrivateLockDatabase = (lockDatabasePath: string): void => {
  const directory = dirname(lockDatabasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(lockDatabasePath, 'a', 0o600);
  closeSync(descriptor);
  if (process.platform !== 'win32') {
    chmodSync(directory, 0o700);
    chmodSync(lockDatabasePath, 0o600);
  }
};

const runWithSqliteLock = async <T>(lockDatabasePath: string, operation: () => Promise<T>): Promise<T> => {
  let database: DatabaseSync | undefined;
  try {
    preparePrivateLockDatabase(lockDatabasePath);
    database = new DatabaseSync(lockDatabasePath);
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
    throw new Error('Failed to acquire the Floway device master key creation lock', { cause });
  }

  let result: T | undefined;
  let failure: unknown;
  let transactionOpen = true;
  try {
    result = await operation();
    try {
      database.exec('COMMIT');
    } catch (cause) {
      throw new Error('Failed to release the Floway device master key creation lock', { cause });
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
      throw new Error('Failed to close the Floway device master key creation lock database', { cause });
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) {
    throw new Error('Failed to release the Floway device master key creation lock', { cause: cleanupFailure });
  }
  return result as T;
};

export const createDeviceMasterKeyCreationLock = (
  options: DeviceMasterKeyCreationLockOptions = {},
): DeviceMasterKeyCreationLock => {
  // The credential service/account is device-global, so every Floway database
  // owned by this OS user contends on the lock resolved from the same stable
  // platform application-data identity as the personal runtime.
  const lockDatabasePath = resolve(
    options.lockDatabasePath ?? resolvePersonalRuntimePaths().credentialLockDatabasePath,
  );
  return Object.freeze({
    run: async <T>(operation: () => Promise<T>): Promise<T> => await serializeInProcess(
      lockDatabasePath,
      () => runWithSqliteLock(lockDatabasePath, operation),
    ),
  });
};
