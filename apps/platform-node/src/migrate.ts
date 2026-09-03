import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planProtectedMigration,
  PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION,
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

type OpenMigrationValue = (
  stored: string,
  transition: ProtectedMigrationFieldPlan,
  identity: string | number,
) => Promise<string>;

const openMigrationValues = async (
  db: SqlDatabase,
  file: string,
  plan: ProtectedMigrationPlan,
  openValue: OpenMigrationValue,
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
        `Floway One migration ${file} could not read protected migration field ${transition.field.id} at ${table}.${column}`,
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
        plaintext: await openValue(row.value, transition, row.identity),
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
  options: { readonly through?: string } = {},
): Promise<void> => {
  // SQLite runs the configured busy handler for the connection when a lock
  // cannot be obtained. The PRAGMA is the connection-level form of
  // sqlite3_busy_timeout().
  // https://sqlite.org/pragma.html#pragma_busy_timeout
  await db.exec('PRAGMA busy_timeout = 30000');
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');

  const appliedRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const applied = new Set(appliedRows.results.map(row => row.name));
  const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).toSorted();

  for (const file of files) {
    if (applied.has(file)) {
      if (options.through === file) break;
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    let plan: ProtectedMigrationPlan | null = null;
    if (storedSecrets !== undefined) {
      try {
        plan = planProtectedMigration(file, sql, applied);
      } catch (cause) {
        throw new Error(`Floway One could not plan protected migration ${file}`, { cause });
      }
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
      const alreadyApplied = await db.prepare('SELECT name FROM _migrations WHERE name = ?')
        .bind(file)
        .first<{ name: string }>();
      if (alreadyApplied !== null) {
        await db.exec('COMMIT');
        applied.add(file);
        if (options.through === file) break;
        continue;
      }
      const adoptThisMigration = plan?.inputMode === 'legacy-plaintext';
      if (adoptThisMigration) {
        // secure_delete overwrites deleted content with zeros so the legacy
        // plaintext consumed by this checked migration plan cannot remain in
        // freed database pages.
        // https://sqlite.org/pragma.html#pragma_secure_delete
        await db.exec('PRAGMA secure_delete = ON');
      }
      const opened = plan === null || storedSecrets === undefined
        ? []
        : await openMigrationValues(
            db,
            file,
            plan,
            adoptThisMigration
              ? value => Promise.resolve(value)
              : (value, transition, identity) => storedSecrets.open(
                  value,
                  transition.field.contextFor(identity),
                ),
          );
      await db.exec(plan?.persistentSql ?? sql);
      if (plan !== null && storedSecrets !== undefined) {
        await sealAndRestoreProtectedValues(db, storedSecrets, file, opened);
      }
      if (file === PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION) {
        await db.exec('CREATE TABLE IF NOT EXISTS _protected_storage_cleanup (id INTEGER PRIMARY KEY CHECK (id = 1))');
        await db.exec('INSERT OR IGNORE INTO _protected_storage_cleanup (id) VALUES (1)');
      }
      await db.prepare('INSERT INTO _migrations (name) VALUES (?)').bind(file).run();
      await db.exec('COMMIT');
      applied.add(file);
      if (options.through === file) break;
    } catch (error) {
      // SQLite may auto-rollback a hard error. Do not let recovery replace the
      // migration, codec, or storage-plan cause visible to the operator.
      try { await db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    }
  }
  const cleanupTable = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_protected_storage_cleanup'",
  ).first<{ name: string }>();
  const cleanupPending = cleanupTable !== null
    && await db.prepare('SELECT id FROM _protected_storage_cleanup WHERE id = 1').first<{ id: number }>() !== null;
  if (cleanupPending) {
    // TRUNCATE checkpoints report busy readers without blocking forever and
    // shrink a successfully checkpointed WAL to zero bytes.
    // https://sqlite.org/pragma.html#pragma_wal_checkpoint
    const checkpoint = await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      .first<{ busy: number; checkpointed: number; log: number }>();
    if (checkpoint?.busy !== 0) {
      throw new Error('Floway One protected-storage cleanup is pending because SQLite readers prevented WAL truncation');
    }
    // VACUUM rebuilds the database into a minimal file, removing free pages
    // that could retain the adopted plaintext after the secure-delete pass.
    // https://sqlite.org/lang_vacuum.html
    await db.exec('VACUUM');
    const finalCheckpoint = await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      .first<{ busy: number; checkpointed: number; log: number }>();
    if (finalCheckpoint?.busy !== 0) {
      throw new Error('Floway One protected-storage cleanup is pending because SQLite readers prevented its final WAL truncation');
    }
    await db.exec('DELETE FROM _protected_storage_cleanup WHERE id = 1');
  }
};
