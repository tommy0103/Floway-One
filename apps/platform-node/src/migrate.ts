import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { upstreamConfigSecretContext, upstreamStateSecretContext } from '@floway-dev/gateway';
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
const rewriteProtectedUpstreamDocuments = async (
  db: SqlDatabase,
  storedSecrets: StoredSecretCodec,
  operation: 'open' | 'seal',
): Promise<void> => {
  const rows = await db.prepare('SELECT id, config_json, state_json FROM upstreams')
    .all<{ id: string; config_json: string; state_json: string | null }>();
  for (const row of rows.results) {
    const configJson = await storedSecrets[operation](row.config_json, upstreamConfigSecretContext(row.id));
    const stateJson = row.state_json === null
      ? null
      : await storedSecrets[operation](row.state_json, upstreamStateSecretContext(row.id));
    await db.prepare('UPDATE upstreams SET config_json = ?, state_json = ? WHERE id = ?')
      .bind(configJson, stateJson, row.id)
      .run();
  }
};

export const applyMigrations = async (
  db: SqlDatabase,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  storedSecrets?: StoredSecretCodec,
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
      if (storedSecrets !== undefined) await rewriteProtectedUpstreamDocuments(db, storedSecrets, 'open');
      await db.exec(sql);
      if (storedSecrets !== undefined) await rewriteProtectedUpstreamDocuments(db, storedSecrets, 'seal');
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
