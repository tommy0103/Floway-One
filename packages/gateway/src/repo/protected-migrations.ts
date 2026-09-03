import {
  PROTECTED_STORED_SECRET_FIELDS,
  type ProtectedStoredSecretField,
  type StoredSecretSqlLocation,
  WEB_SEARCH_STORED_SECRET_FIELDS,
} from './stored-secret-fields.ts';
import { sha256Hex, type SqlDatabase } from '@floway-dev/platform';

export const PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION = '0084_protected_search_secret_columns.sql';
export const LEGACY_PLAINTEXT_SCHEMA_MIGRATION = '0083_canonical_protocol_names.sql';

export interface ProtectedStorageFieldLocation {
  readonly field: ProtectedStoredSecretField;
  readonly location: StoredSecretSqlLocation;
}

export interface ProtectedMigrationFieldPlan {
  readonly field: ProtectedStoredSecretField;
  readonly before: StoredSecretSqlLocation;
  readonly after: StoredSecretSqlLocation;
  transform(plaintext: string, identity: string | number): string | Promise<string>;
}

export interface ProtectedMigrationPlan {
  readonly name: string;
  readonly fields: readonly ProtectedMigrationFieldPlan[];
  readonly inputMode: 'ciphertext' | 'legacy-plaintext';
  readonly sourceSha256: string;
  structuralSql(source: string, runtime: 'personal' | 'server'): string;
}

const LEGACY_SEARCH_SECRET_COLUMNS = {
  tavily: 'tavily_api_key',
  'microsoft-web-iq': 'microsoft_web_iq_api_key',
  jina: 'jina_api_key',
} as const;

const identityTransform = (plaintext: string): string => plaintext;
const PERSONAL_OMIT_BEGIN = '-- floway-personal-omit-begin';
const PERSONAL_OMIT_END = '-- floway-personal-omit-end';
const canonicalMigrationSource = (source: string): string => source.replaceAll('\r\n', '\n');

// The checked migration file owns the complete server schema and remains
// directly executable by D1. Personal mode compiles the same source while
// omitting only the marked plaintext-copy expressions, then restores sealed
// values through the field plan. The source digest rejects drift before SQL.
const compileProtectedStructuralSql = (source: string, runtime: 'personal' | 'server'): string => {
  const output: string[] = [];
  let omitting = false;
  let blocks = 0;
  for (const line of canonicalMigrationSource(source).split('\n')) {
    const marker = line.trim();
    if (marker === PERSONAL_OMIT_BEGIN) {
      if (omitting) throw new Error('Nested personal-omit blocks in protected migration content');
      omitting = true;
      blocks++;
      continue;
    }
    if (marker === PERSONAL_OMIT_END) {
      if (!omitting) throw new Error('Unmatched personal-omit end marker in protected migration content');
      omitting = false;
      continue;
    }
    if (!omitting || runtime === 'server') output.push(line);
  }
  if (omitting || blocks !== 2) throw new Error('Protected migration content must contain two complete personal-omit blocks');
  return output.join('\n');
};

export const PROTECTED_MIGRATION_PLANS: readonly ProtectedMigrationPlan[] = Object.freeze([
  Object.freeze({
    name: PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION,
    inputMode: 'legacy-plaintext',
    sourceSha256: 'bf86256c15bf76f24d6c059a7bca16b61690254b00e732fc494cee091f15e193',
    structuralSql: compileProtectedStructuralSql,
    fields: Object.freeze(PROTECTED_STORED_SECRET_FIELDS.map(field => Object.freeze({
      field,
      before: WEB_SEARCH_STORED_SECRET_FIELDS.includes(field as (typeof WEB_SEARCH_STORED_SECRET_FIELDS)[number])
        ? Object.freeze({
            ...field.location,
            column: LEGACY_SEARCH_SECRET_COLUMNS[(field as (typeof WEB_SEARCH_STORED_SECRET_FIELDS)[number]).provider],
          })
        : field.location,
      after: field.location,
      transform: identityTransform,
    }))),
  }),
]);

const checkedPlans = (): ReadonlyMap<string, ProtectedMigrationPlan> => {
  const plans = new Map<string, ProtectedMigrationPlan>();
  for (const plan of PROTECTED_MIGRATION_PLANS) {
    if (plans.has(plan.name)) throw new Error(`Ambiguous protected migration plan for ${plan.name}`);
    const fields = new Set<ProtectedStoredSecretField>();
    for (const transition of plan.fields) {
      if (!PROTECTED_STORED_SECRET_FIELDS.includes(transition.field)) {
        throw new Error(`Protected migration plan ${plan.name} names unknown field ${transition.field.id}`);
      }
      if (fields.has(transition.field)) {
        throw new Error(`Protected migration plan ${plan.name} repeats field ${transition.field.id}`);
      }
      fields.add(transition.field);
    }
    plans.set(plan.name, plan);
  }
  return plans;
};

const migrationPlans = checkedPlans();

export const hasProtectedMigrationPlan = (file: string): boolean => migrationPlans.has(file);

export const protectedStorageLayout = (
  appliedMigrations: ReadonlySet<string>,
): readonly ProtectedStorageFieldLocation[] => {
  const locations = new Map(PROTECTED_STORED_SECRET_FIELDS.map(field => [field, field.location]));
  let foundUnappliedPlan = false;
  for (const plan of PROTECTED_MIGRATION_PLANS) {
    if (!appliedMigrations.has(plan.name)) {
      foundUnappliedPlan = true;
    } else if (foundUnappliedPlan) {
      throw new Error(`Ambiguous protected migration history: ${plan.name} is applied after an unapplied protected migration`);
    }
  }
  for (const plan of PROTECTED_MIGRATION_PLANS.toReversed()) {
    if (!appliedMigrations.has(plan.name)) {
      for (const transition of plan.fields) locations.set(transition.field, transition.before);
    }
  }
  return PROTECTED_STORED_SECRET_FIELDS.map(field => ({ field, location: locations.get(field)! }));
};

const escapedIdentifierPattern = (identifier: string): string =>
  identifier.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const touchesProtectedStorage = (
  sql: string,
  layout: readonly ProtectedStorageFieldLocation[],
): boolean => layout.some(({ location }) => [location.table, location.column].some(identifier =>
  new RegExp(`\\b${escapedIdentifierPattern(identifier)}\\b`, 'iu').test(sql)));

export const planProtectedMigration = async (
  file: string,
  sql: string,
  appliedMigrations: ReadonlySet<string>,
): Promise<ProtectedMigrationPlan | null> => {
  const layout = protectedStorageLayout(appliedMigrations);
  const plan = migrationPlans.get(file) ?? null;
  if (plan === null && touchesProtectedStorage(sql, layout)) {
    throw new Error(`Missing checked-in protected migration plan for ${file}`);
  }
  if (plan !== null) {
    const sourceSha256 = await sha256Hex(new TextEncoder().encode(canonicalMigrationSource(sql)));
    if (sourceSha256 !== plan.sourceSha256) {
      throw new Error(`Protected migration ${file} does not match its checked content`);
    }
    for (const transition of plan.fields) {
      const current = layout.find(entry => entry.field === transition.field)?.location;
      if (current === undefined
        || current.table !== transition.before.table
        || current.identityColumn !== transition.before.identityColumn
        || current.column !== transition.before.column) {
        throw new Error(`Protected migration plan ${file} does not match the current location of ${transition.field.id}`);
      }
    }
  }
  return plan;
};

export const databaseHasProtectedValues = async (db: SqlDatabase): Promise<boolean> => {
  const applied = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  let layout: readonly ProtectedStorageFieldLocation[];
  try {
    layout = protectedStorageLayout(new Set(applied.results.map(row => row.name)));
  } catch (cause) {
    throw new Error('Floway could not resolve its protected migration history', { cause });
  }
  for (const { field, location } of layout) {
    const nonEmpty = field.plaintextEmpty ? ` AND ${location.column} <> ''` : '';
    try {
      const row = await db.prepare(
        `SELECT ${location.identityColumn} AS identity FROM ${location.table} WHERE ${location.column} IS NOT NULL${nonEmpty} LIMIT 1`,
      ).first<{ identity: string | number }>();
      if (row !== null) return true;
    } catch (cause) {
      throw new Error(
        `Floway could not inspect protected field ${field.id} at ${location.table}.${location.column}`,
        { cause },
      );
    }
  }
  return false;
};

export interface ProtectedStorageStatus {
  readonly hasProtectedValues: boolean;
  readonly inputMode: ProtectedMigrationPlan['inputMode'];
}

export const inspectProtectedStorage = async (db: SqlDatabase): Promise<ProtectedStorageStatus> => {
  const applied = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const names = new Set(applied.results.map(row => row.name));
  if (!names.has(PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION)) {
    if (!names.has(LEGACY_PLAINTEXT_SCHEMA_MIGRATION)) {
      throw new Error(
        `Floway cannot adopt protected storage before ${LEGACY_PLAINTEXT_SCHEMA_MIGRATION}`,
      );
    }
    return { hasProtectedValues: true, inputMode: 'legacy-plaintext' };
  }
  return {
    hasProtectedValues: await databaseHasProtectedValues(db),
    inputMode: 'ciphertext',
  };
};
