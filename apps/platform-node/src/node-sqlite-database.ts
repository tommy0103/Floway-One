import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { InitializedPersonalStorage } from './personal-storage.ts';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

const withPostcondition = <T>(operation: () => T, postcondition: () => void): T => {
  let result: T;
  try {
    result = operation();
  } catch (cause) {
    try { postcondition(); } catch { /* the database error remains authoritative */ }
    throw cause;
  }
  postcondition();
  return result;
};

// node:sqlite's prepared statement is synchronous and returns plain rows.
// We adapt it to the platform's async, enveloped contract. bind() returns a
// fresh statement object so two awaited binds on the same prepared statement
// never share state.
class NodeSqlitePreparedStatement implements SqlPreparedStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly bound: readonly SqlBindValue[] = [],
    private readonly hardenFiles: () => void = () => undefined,
    private readonly schedule: <T>(operation: () => T | Promise<T>) => Promise<T> = operation => Promise.resolve().then(operation),
  ) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.stmt, values, this.hardenFiles, this.schedule);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.schedule(() => {
      const row = withPostcondition(
        () => this.stmt.get(...(this.bound as never[])),
        this.hardenFiles,
      );
      return (row as T | undefined) ?? null;
    });
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.schedule(() => {
      const rows = withPostcondition(
        () => this.stmt.all(...(this.bound as never[])) as T[],
        this.hardenFiles,
      );
      return { results: rows, success: true, meta: {} };
    });
  }

  runSync(): SqlResult {
    const result = withPostcondition(
      () => this.stmt.run(...(this.bound as never[])),
      this.hardenFiles,
    );
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }

  run(): Promise<SqlResult> {
    return this.schedule(() => this.runSync());
  }
}

class NodeSqliteDatabase implements SqlDatabase {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    private readonly hardenFiles: () => void,
    private readonly observeTransactionPhase: (phase: TransactionLifecyclePhase) => void = () => undefined,
  ) {}

  private recoverTransaction(cause: unknown, state: TransactionLifecycleState): never {
    const failures = [cause];
    const recovery = recoveryStateFor(state);
    this.observeTransactionPhase(transactionPhase(recovery));
    if (recovery.kind === 'recover-active') {
      try { this.db.exec('ROLLBACK'); } catch (rollbackFailure) { failures.push(rollbackFailure); }
    }
    try { this.hardenFiles(); } catch (hardeningFailure) { failures.push(hardeningFailure); }
    if (failures.length === 1) throw cause;
    throw new AggregateError(failures, 'Floway transaction failed and recovery was incomplete.', { cause });
  }

  private async runTransactionLifecycle<T>(
    kind: TransactionLifecycleKind,
    body: () => T | Promise<T>,
  ): Promise<T> {
    let state: TransactionLifecycleState = { kind: 'not-begun' };
    this.observeTransactionPhase(transactionPhase(state));
    const transition = (next: TransactionLifecycleState): void => {
      state = advanceTransactionLifecycle(state, next);
      this.observeTransactionPhase(transactionPhase(state));
    };
    try {
      this.db.exec(kind === 'batch' ? 'BEGIN' : 'BEGIN IMMEDIATE');
      transition({ kind: 'begun' });
      transition({ kind: 'body' });
      const result = await body();
      if (kind === 'interactive') {
        transition({ kind: 'precommit-finalize' });
        this.hardenFiles();
      }
      transition({ kind: 'commit' });
      this.db.exec('COMMIT');
      transition({ kind: 'committed' });
      if (kind === 'batch') {
        transition({ kind: 'postcommit-finalize' });
        this.hardenFiles();
      }
      transition({ kind: 'done' });
      return result;
    } catch (cause) {
      this.recoverTransaction(cause, state);
    }
  }

  private readonly schedule = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (this.transactionContext.getStore()) return Promise.resolve().then(operation);
    const pending = this.operationTail.then(operation, operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  prepare(query: string): SqlPreparedStatement {
    const hardenAfterStatement = (): void => {
      // A personal restore transaction hardens the complete SQLite file set
      // once, after every write succeeds and before COMMIT. Per-statement
      // hardening would fail earlier and could not verify that final state.
      if (!this.transactionContext.getStore()) this.hardenFiles();
    };
    return new NodeSqlitePreparedStatement(this.db.prepare(query), [], hardenAfterStatement, this.schedule);
  }

  // Wraps the supplied statements in a single transaction so the batch is
  // atomic. node:sqlite is fully synchronous, so we drive the batch with
  // runSync() to keep BEGIN…COMMIT inside one microtask — an `await` between
  // statements would yield, letting a concurrently-scheduled batch's BEGIN
  // run while this transaction is still open and trip
  // "cannot start a transaction within a transaction".
  batch(statements: SqlPreparedStatement[]): Promise<SqlResult[]> {
    const runStatements = (): SqlResult[] => statements.map(stmt => {
      if (!(stmt instanceof NodeSqlitePreparedStatement)) {
        throw new Error('NodeSqliteDatabase.batch received a statement from a different database adapter');
      }
      return stmt.runSync();
    });
    // A repository-level batch inside a broader restore transaction is
    // already protected by that transaction and must not open a nested BEGIN.
    if (this.transactionContext.getStore()) return this.schedule(runStatements);
    return this.schedule(() => this.runTransactionLifecycle('batch', runStatements));
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.schedule(() => this.transactionContext.run(
      true,
      async () => await this.runTransactionLifecycle('interactive', operation),
    ));
  }

  exec(sql: string): Promise<unknown> {
    return this.schedule(() => withPostcondition(() => this.db.exec(sql), this.hardenFiles));
  }
}

interface CreateNodeSqliteDatabaseOptions {
  readonly permissions?: InitializedPersonalStorage;
  readonly observeTransactionPhase?: (phase: TransactionLifecyclePhase) => void;
}

type TransactionLifecyclePhase = 'not-begun' | 'begun' | 'body' | 'commit' | 'committed' | 'finalize' | 'recovery' | 'done';
type TransactionLifecycleKind = 'batch' | 'interactive';
type TransactionLifecycleState =
  | { readonly kind: 'not-begun' }
  | { readonly kind: 'begun' }
  | { readonly kind: 'body' }
  | { readonly kind: 'precommit-finalize' }
  | { readonly kind: 'commit' }
  | { readonly kind: 'committed' }
  | { readonly kind: 'postcommit-finalize' }
  | { readonly kind: 'recover-active' }
  | { readonly kind: 'recover-closed' }
  | { readonly kind: 'done' };

const LIFECYCLE_TRANSITIONS = {
  'not-begun': ['begun'],
  begun: ['body'],
  body: ['commit', 'precommit-finalize'],
  'precommit-finalize': ['commit'],
  commit: ['committed'],
  committed: ['done', 'postcommit-finalize'],
  'postcommit-finalize': ['done'],
  'recover-active': [],
  'recover-closed': [],
  done: [],
} as const satisfies Record<TransactionLifecycleState['kind'], readonly TransactionLifecycleState['kind'][]>;

const advanceTransactionLifecycle = (
  current: TransactionLifecycleState,
  next: TransactionLifecycleState,
): TransactionLifecycleState => {
  const allowed = LIFECYCLE_TRANSITIONS[current.kind] as readonly TransactionLifecycleState['kind'][];
  if (!allowed.includes(next.kind)) {
    throw new Error(`Invalid Floway transaction lifecycle transition: ${current.kind} -> ${next.kind}`);
  }
  return next;
};

const recoveryStateFor = (state: TransactionLifecycleState): TransactionLifecycleState => {
  switch (state.kind) {
  case 'begun':
  case 'body':
  case 'precommit-finalize':
  case 'commit':
    return { kind: 'recover-active' };
  default:
    return { kind: 'recover-closed' };
  }
};

const transactionPhase = (state: TransactionLifecycleState): TransactionLifecyclePhase => {
  switch (state.kind) {
  case 'precommit-finalize':
  case 'postcommit-finalize':
    return 'finalize';
  case 'recover-active':
  case 'recover-closed':
    return 'recovery';
  default:
    return state.kind;
  }
};

export const createNodeSqliteDatabase = (
  path: string,
  options: CreateNodeSqliteDatabaseOptions = {},
): SqlDatabase => {
  // Standalone/server databases own parent creation. Personal databases
  // receive a nominal capability whose factory already created and hardened
  // the application-data root before this consumer can open SQLite.
  if (options.permissions === undefined) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const hardenFiles = (): void => options.permissions?.hardenSqliteFiles(path);
  try {
    hardenFiles();
  } catch (cause) {
    try { db.close(); } catch { /* preserve the hardening failure */ }
    throw cause;
  }
  // node:sqlite leaves foreign keys off by default; the schema relies on FK
  // enforcement, so turn it on at open.
  db.exec('PRAGMA foreign_keys = ON');
  hardenFiles();
  return new NodeSqliteDatabase(db, hardenFiles, options.observeTransactionPhase);
};
