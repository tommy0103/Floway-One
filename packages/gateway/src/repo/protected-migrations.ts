import {
  PROTECTED_STORED_SECRET_FIELDS,
  type ProtectedStoredSecretField,
  type StoredSecretSqlLocation,
  WEB_SEARCH_STORED_SECRET_FIELDS,
} from './stored-secret-fields.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export const PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION = '0084_protected_search_secret_columns.sql';

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
}

const LEGACY_SEARCH_SECRET_COLUMNS = {
  tavily: 'tavily_api_key',
  'microsoft-web-iq': 'microsoft_web_iq_api_key',
  jina: 'jina_api_key',
} as const;

const identityTransform = (plaintext: string): string => plaintext;

export const PROTECTED_MIGRATION_PLANS: readonly ProtectedMigrationPlan[] = Object.freeze([
  Object.freeze({
    name: PROTECTED_SEARCH_SECRET_COLUMNS_MIGRATION,
    fields: Object.freeze(WEB_SEARCH_STORED_SECRET_FIELDS.map(field => Object.freeze({
      field,
      before: Object.freeze({
        ...field.location,
        column: LEGACY_SEARCH_SECRET_COLUMNS[field.provider],
      }),
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

export const planProtectedMigration = (
  file: string,
  sql: string,
  appliedMigrations: ReadonlySet<string>,
): ProtectedMigrationPlan | null => {
  const layout = protectedStorageLayout(appliedMigrations);
  const plan = migrationPlans.get(file) ?? null;
  if (plan === null && touchesProtectedStorage(sql, layout)) {
    throw new Error(`Missing checked-in protected migration plan for ${file}`);
  }
  if (plan !== null) {
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
    throw new Error('Floway One could not resolve its protected migration history', { cause });
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
        `Floway One could not inspect protected field ${field.id} at ${location.table}.${location.column}`,
        { cause },
      );
    }
  }
  return false;
};
