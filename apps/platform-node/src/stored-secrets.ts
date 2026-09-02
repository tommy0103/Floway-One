import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from './device-master-key.ts';
import {
  createAes256GcmStoredSecretCodec,
  plaintextStoredSecretCodec,
  type RuntimeProfileMode,
  type SqlDatabase,
  type StoredSecretCodec,
} from '@floway-dev/platform';

const SEARCH_CONFIG_WITH_CREDENTIAL_SQL = "SELECT id FROM search_config WHERE tavily_api_key <> '' OR microsoft_web_iq_api_key <> '' OR jina_api_key <> '' LIMIT 1";

export const createNodeStoredSecretCodec = async (
  profile: RuntimeProfileMode,
  db: SqlDatabase,
  credential?: DeviceMasterKeyCredential,
): Promise<StoredSecretCodec> => {
  if (profile === 'server') return plaintextStoredSecretCodec;

  const [existingUpstream, existingSearchCredential] = await Promise.all([
    db.prepare('SELECT id FROM upstreams LIMIT 1').first<{ id: string }>(),
    db.prepare(SEARCH_CONFIG_WITH_CREDENTIAL_SQL).first<{ id: number }>(),
  ]);
  const databaseHasProtectedValues = existingUpstream !== null || existingSearchCredential !== null;
  const masterKey = await loadDeviceMasterKey(!databaseHasProtectedValues, credential);
  return createAes256GcmStoredSecretCodec(masterKey);
};
