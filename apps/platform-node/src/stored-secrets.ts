import type { DeviceMasterKeyCreationLock } from './device-master-key-creation-lock.ts';
import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import { validateStoredSecrets, WEB_SEARCH_STORED_SECRET_FIELDS } from '@floway-dev/gateway';
import {
  createAes256GcmStoredSecretCodec,
  plaintextStoredSecretCodec,
  type RuntimeProfileMode,
  type SqlDatabase,
  type StoredSecretCodec,
} from '@floway-dev/platform';

export const createNodeStoredSecretCodec = async (
  profile: RuntimeProfileMode,
  db: SqlDatabase,
  creationLock?: DeviceMasterKeyCreationLock,
  credential?: DeviceMasterKeyCredential,
  options: { readonly validate?: boolean } = {},
): Promise<StoredSecretCodec> => {
  if (profile === 'server') return plaintextStoredSecretCodec;
  if (creationLock === undefined) throw new Error('Personal profile requires a device master key creation lock');

  const [existingUpstream, searchColumns] = await Promise.all([
    db.prepare('SELECT id FROM upstreams LIMIT 1').first<{ id: string }>(),
    db.prepare('PRAGMA table_info(search_config)').all<{ name: string }>(),
  ]);
  const existingSearchFields = WEB_SEARCH_STORED_SECRET_FIELDS
    .filter(field => searchColumns.results.some(column => column.name === field.column));
  const existingSearchCredential = existingSearchFields.length === 0
    ? null
    : await db.prepare(`SELECT id FROM search_config WHERE ${existingSearchFields
        .map(field => `${field.column} <> ''`)
        .join(' OR ')} LIMIT 1`).first<{ id: number }>();
  const databaseHasProtectedValues = existingUpstream !== null || existingSearchCredential !== null;
  const masterKey = await loadDeviceMasterKey(creationLock, !databaseHasProtectedValues, credential);
  const storedSecrets = createAes256GcmStoredSecretCodec(masterKey);
  if (options.validate !== false) await validateStoredSecrets(db, storedSecrets);
  return storedSecrets;
};
