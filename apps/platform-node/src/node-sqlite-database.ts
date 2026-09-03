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
  ) {}

  bind(...values: SqlBindValue[]): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.stmt, values, this.hardenFiles);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = withPostcondition(
      () => this.stmt.get(...(this.bound as never[])),
      this.hardenFiles,
    );
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = withPostcondition(
      () => this.stmt.all(...(this.bound as never[])) as T[],
      this.hardenFiles,
    );
    return Promise.resolve({ results: rows, success: true, meta: {} });
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
    return Promise.resolve(this.runSync());
  }
}

class NodeSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: DatabaseSync, private readonly hardenFiles: () => void) {}

  prepare(query: string): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.db.prepare(query), [], this.hardenFiles);
  }

  // Wraps the supplied statements in a single transaction so the batch is
  // atomic. node:sqlite is fully synchronous, so we drive the batch with
  // runSync() to keep BEGIN…COMMIT inside one microtask — an `await` between
  // statements would yield, letting a concurrently-scheduled batch's BEGIN
  // run while this transaction is still open and trip
  // "cannot start a transaction within a transaction".
  batch(statements: SqlPreparedStatement[]): Promise<SqlResult[]> {
    this.db.exec('BEGIN');
    try {
      const results = statements.map(stmt => {
        if (!(stmt instanceof NodeSqlitePreparedStatement)) {
          throw new Error('NodeSqliteDatabase.batch received a statement from a different database adapter');
        }
        return stmt.runSync();
      });
      this.db.exec('COMMIT');
      this.hardenFiles();
      return Promise.resolve(results);
    } catch (e) {
      // SQLite auto-rolls-back on a hard error class (SQLITE_FULL,
      // SQLITE_IOERR, SQLITE_BUSY, SQLITE_NOMEM, SQLITE_INTERRUPT — see
      // https://www.sqlite.org/lang_transaction.html "Response To Errors
      // Within A Transaction"); the explicit ROLLBACK then throws
      // "cannot rollback - no transaction is active" and would replace
      // the original failure on the way out. Swallow that recovery throw
      // so `throw e` always wins and the operator sees the real cause.
      try { this.db.exec('ROLLBACK'); } catch { /* txn already auto-rolled-back */ }
      try { this.hardenFiles(); } catch { /* preserve the transaction failure */ }
      throw e;
    }
  }

  exec(sql: string): Promise<unknown> {
    withPostcondition(() => this.db.exec(sql), this.hardenFiles);
    return Promise.resolve(undefined);
  }
}

interface CreateNodeSqliteDatabaseOptions {
  readonly permissions?: InitializedPersonalStorage;
}

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
  return new NodeSqliteDatabase(db, hardenFiles);
};
