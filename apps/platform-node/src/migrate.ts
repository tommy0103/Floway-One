import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planProtectedMigration,
  type ProtectedMigrationFieldPlan,
  type ProtectedMigrationPlan,
} from '@floway-dev/gateway';
import { migrationsDir } from '@floway-dev/gateway/migrations-dir';
import type { SqlDatabase, StoredSecretCodec } from '@floway-dev/platform';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(migrationsDir);

interface OpenedProtectedValue {
  readonly transition: ProtectedMigrationFieldPlan;
  readonly identity: string | number;
  readonly plaintext: string;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const openProtectedValues = async (
  db: SqlDatabase,
  storedSecrets: StoredSecretCodec,
  file: string,
  plan: ProtectedMigrationPlan,
): Promise<readonly OpenedProtectedValue[]> => {
  const opened: OpenedProtectedValue[] = [];
  for (const transition of plan.fields) {
    const { table, identityColumn, column } = transition.before;
    let rows: { results: Array<{ identity: string | number; value: string | null }> };
    try {
      rows = await db.prepare(
        `SELECT ${quoteIdentifier(identityColumn)} AS identity, ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)}`,
      ).all<{ identity: string | number; value: string | null }>();
    } catch (cause) {
      throw new Error(
        `Floway One migration ${file} could not read protected field ${transition.field.id} at ${table}.${column}`,
        { cause },
      );
    }
    for (const row of rows.results) {
      if (row.value === null) {
        if (!transition.field.nullable) {
          throw new Error(`Floway One migration ${file} found NULL in protected field ${transition.field.id}`);
        }
        continue;
      }
      if (transition.field.plaintextEmpty && row.value === '') continue;
      opened.push({
        transition,
        identity: row.identity,
        plaintext: await storedSecrets.open(row.value, transition.field.contextFor(row.identity)),
      });
    }
  }
  return opened;
};

const sealAndRestoreProtectedValues = async (
  db: SqlDatabase,
  storedSecrets: StoredSecretCodec,
  file: string,
  opened: readonly OpenedProtectedValue[],
): Promise<void> => {
  for (const value of opened) {
    const { transition } = value;
    const transformed = await transition.transform(value.plaintext, value.identity);
    const ciphertext = await storedSecrets.seal(
      transformed,
      transition.field.contextFor(value.identity),
    );
    const { table, identityColumn, column } = transition.after;
    try {
      const result = await db.prepare(
        `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(identityColumn)} IS ?`,
      ).bind(ciphertext, value.identity).run();
      if (result.meta.changes !== 1) {
        throw new Error(
          `Floway One migration ${file} could not uniquely restore protected field ${transition.field.id} for identity ${String(value.identity)}`,
        );
      }
    } catch (cause) {
      throw new Error(
        `Floway One migration ${file} could not restore protected field ${transition.field.id} at ${table}.${column}`,
        { cause },
      );
    }
  }
};

// Each SQL file is atomic. In personal mode, a checked-in protected migration
// plan opens and transforms values only in JavaScript memory. Its SQL is
// structural and copies ciphertext between persistent tables; resealing occurs
// after SQL and writes ciphertext directly to the declared post-schema fields.
export const applyMigrations = async (
  db: SqlDatabase,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  storedSecrets?: StoredSecretCodec,
): Promise<void> => {
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');

  const appliedRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const applied = new Set(appliedRows.results.map(row => row.name));
  const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).toSorted();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    let plan: ProtectedMigrationPlan | null = null;
    if (storedSecrets !== undefined) {
      try {
        plan = planProtectedMigration(file, sql, applied);
      } catch (cause) {
        throw new Error(`Floway One could not plan protected migration ${file}`, { cause });
      }
    }

    await db.exec('BEGIN');
    try {
      const opened = plan === null || storedSecrets === undefined
        ? []
        : await openProtectedValues(db, storedSecrets, file, plan);
      await db.exec(sql);
      if (plan !== null && storedSecrets !== undefined) {
        await sealAndRestoreProtectedValues(db, storedSecrets, file, opened);
      }
      await db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind(file).run();
      await db.exec('COMMIT');
      applied.add(file);
    } catch (error) {
      // SQLite may auto-rollback a hard error. Do not let recovery replace the
      // migration, codec, or storage-plan cause visible to the operator.
      try { await db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }
};
