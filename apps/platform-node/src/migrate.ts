import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTECTED_STORED_SECRET_FIELDS,
  type ProtectedStoredSecretField,
  type StoredSecretSqlLocation,
} from '@floway-dev/gateway';
import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import type { SqlDatabase, StoredSecretCodec } from '@floway-dev/platform';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(migrationsDir);

// Applies every pending migration, recording each one's name in a
// `_migrations` table so reruns are no-ops. Each file's full contents go
// through SqlDatabase.exec() rather than a hand-rolled statement split,
// because the migration corpus contains:
//   * trailing comment-only chunks that a `;` split turns into empty
//     statements, which `prepare()` rejects with "statement has been
//     finalized";
//   * `CREATE TRIGGER ... BEGIN ... END;` blocks whose embedded `;` characters
//     are part of the trigger body, which a regex split cannot honour.
// `exec()` is sqlite's native multi-statement entry point — the same one D1
// uses to apply migrations server-side.
//
// We bracket each file with our own BEGIN/COMMIT so a mid-file failure rolls
// the whole file back; without that bracket, the partial DDL from earlier
// statements would persist after a later one threw.
export interface ProtectedMigrationTransition {
  readonly field: ProtectedStoredSecretField;
  readonly before?: StoredSecretSqlLocation;
  readonly after?: StoredSecretSqlLocation;
}

export type ProtectedMigrationTransitions = Readonly<Record<string, readonly ProtectedMigrationTransition[]>>;

interface ResolvedProtectedMigrationTransition {
  readonly field: ProtectedStoredSecretField;
  readonly before: StoredSecretSqlLocation;
  readonly after: StoredSecretSqlLocation;
}

interface TransformedProtectedValue {
  readonly field: ProtectedStoredSecretField;
  readonly location: StoredSecretSqlLocation;
  readonly identity: string | number;
  readonly value: string;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const resolveProtectedTransitions = (
  file: string,
  transitions: ProtectedMigrationTransitions,
): readonly ResolvedProtectedMigrationTransition[] => {
  const overrides = new Map<string, ProtectedMigrationTransition>();
  for (const transition of transitions[file] ?? []) {
    if (!PROTECTED_STORED_SECRET_FIELDS.includes(transition.field)) {
      throw new Error(`Floway One migration ${file} names an unknown protected stored-secret field ${transition.field.id}`);
    }
    if (overrides.has(transition.field.id)) {
      throw new Error(`Floway One migration ${file} repeats protected stored-secret field ${transition.field.id}`);
    }
    overrides.set(transition.field.id, transition);
  }
  return PROTECTED_STORED_SECRET_FIELDS.map(field => {
    const override = overrides.get(field.id);
    return {
      field,
      before: override?.before ?? field.location,
      after: override?.after ?? field.location,
    };
  });
};

const transformProtectedValues = async (
  db: SqlDatabase,
  storedSecrets: StoredSecretCodec,
  file: string,
  transitions: readonly ResolvedProtectedMigrationTransition[],
  schema: 'before' | 'after',
  operation: 'open' | 'seal',
): Promise<readonly TransformedProtectedValue[]> => {
  const transformed: TransformedProtectedValue[] = [];
  for (const transition of transitions) {
    const location = transition[schema];
    const table = quoteIdentifier(location.table);
    const identityColumn = quoteIdentifier(location.identityColumn);
    const column = quoteIdentifier(location.column);
    let rows: { results: Array<{ identity: string | number; value: string | null }> };
    try {
      rows = await db.prepare(
        `SELECT ${identityColumn} AS identity, ${column} AS value FROM ${table}`,
      ).all<{ identity: string | number; value: string | null }>();
    } catch (cause) {
      throw new Error(
        `Floway One migration ${file} could not read its ${schema}-schema protected field ${transition.field.id} at ${location.table}.${location.column}`,
        { cause },
      );
    }
    for (const row of rows.results) {
      if (row.value === null) {
        if (!transition.field.nullable) {
          throw new Error(
            `Floway One migration ${file} found NULL in protected field ${transition.field.id} at ${location.table}.${location.column}`,
          );
        }
        continue;
      }
      if (transition.field.plaintextEmpty && row.value === '') continue;
      transformed.push({
        field: transition.field,
        location,
        identity: row.identity,
        value: await storedSecrets[operation](row.value, transition.field.contextFor(row.identity)),
      });
    }
  }
  return transformed;
};

const restoreProtectedValues = async (
  db: SqlDatabase,
  file: string,
  values: readonly TransformedProtectedValue[],
): Promise<void> => {
  for (const value of values) {
    const table = quoteIdentifier(value.location.table);
    const identityColumn = quoteIdentifier(value.location.identityColumn);
    const column = quoteIdentifier(value.location.column);
    try {
      const result = await db.prepare(
        `UPDATE ${table} SET ${column} = ? WHERE ${identityColumn} IS ?`,
      ).bind(value.value, value.identity).run();
      if (result.meta.changes !== 1) {
        throw new Error(
          `Floway One migration ${file} could not uniquely restore protected field ${value.field.id} for identity ${String(value.identity)}`,
        );
      }
    } catch (cause) {
      throw new Error(
        `Floway One migration ${file} could not restore protected field ${value.field.id} at ${value.location.table}.${value.location.column}`,
        { cause },
      );
    }
  }
};

export const applyMigrations = async (
  db: SqlDatabase,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  storedSecrets?: StoredSecretCodec,
  protectedTransitions: ProtectedMigrationTransitions = {},
): Promise<void> => {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');

  const appliedRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const applied = new Set(appliedRows.results.map(r => r.name));

  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).toSorted();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');

    await db.exec('BEGIN');
    try {
      const transitions = storedSecrets === undefined
        ? []
        : resolveProtectedTransitions(file, protectedTransitions);
      if (storedSecrets !== undefined) {
        const plaintext = await transformProtectedValues(db, storedSecrets, file, transitions, 'before', 'open');
        await restoreProtectedValues(db, file, plaintext);
      }
      await db.exec(sql);
      if (storedSecrets !== undefined) {
        const ciphertext = await transformProtectedValues(db, storedSecrets, file, transitions, 'after', 'seal');
        await restoreProtectedValues(db, file, ciphertext);
      }
      await db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind(file).run();
      await db.exec('COMMIT');
    } catch (e) {
      // SQLite auto-rolls-back on hard errors (SQLITE_FULL, SQLITE_IOERR,
      // …) — the explicit ROLLBACK then throws "no transaction is active"
      // and would shadow the real DDL/IO failure in the operator's logs.
      // Swallow it so the genuine cause survives.
      try { await db.exec('ROLLBACK'); } catch { /* txn already auto-rolled-back */ }
      throw e;
    }
  }
};
