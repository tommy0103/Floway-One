import { test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { createAes256GcmStoredSecretCodec, type SqlDatabase } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const masterKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const secretUpstream = (): UpstreamRecord => ({
  id: 'up_personal_secret',
  kind: 'custom',
  name: 'Personal secret upstream',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  config: {
    baseUrl: 'https://provider.example',
    authStyle: 'bearer',
    apiKey: 'provider-api-key-plaintext',
  },
  state: {
    refreshToken: 'provider-refresh-token-plaintext',
    accessToken: { token: 'provider-access-token-plaintext' },
  },
  modelsCache: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
});

const readStoredSecrets = async (db: SqlDatabase) => {
  const row = await db
    .prepare('SELECT config_json, state_json FROM upstreams WHERE id = ?')
    .bind('up_personal_secret')
    .first<{ config_json: string; state_json: string }>();
  if (row === null) throw new Error('Expected encrypted upstream row');
  return row;
};

test('personal upstream repository stores authenticated ciphertext and round-trips provider credentials', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(masterKey) });
  const upstream = secretUpstream();

  await repo.upstreams.save(upstream);
  const firstStored = await readStoredSecrets(db);

  assertEquals(firstStored.config_json.includes('provider-api-key-plaintext'), false);
  assertEquals(firstStored.state_json.includes('provider-refresh-token-plaintext'), false);
  assertEquals(firstStored.state_json.includes('provider-access-token-plaintext'), false);
  const configEnvelope = JSON.parse(firstStored.config_json) as { $flowayEncrypted: { version: number } };
  const stateEnvelope = JSON.parse(firstStored.state_json) as { $flowayEncrypted: { version: number } };
  assertEquals(configEnvelope.$flowayEncrypted.version, 1);
  assertEquals(stateEnvelope.$flowayEncrypted.version, 1);
  assertEquals(await repo.upstreams.getById(upstream.id), upstream);

  await repo.upstreams.save(upstream);
  const secondStored = await readStoredSecrets(db);
  assertEquals(secondStored.config_json === firstStored.config_json, false);
  assertEquals(secondStored.state_json === firstStored.state_json, false);
});

test('encrypted upstream storage preserves config generations and state compare-and-swap behavior', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(masterKey) });
  const upstream = secretUpstream();
  await repo.upstreams.save(upstream);

  const cacheSaved = await repo.upstreams.saveModelsCache(upstream.id, {
    updatedAt: upstream.updatedAt,
    config: upstream.config,
  }, {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_788_278_400_000,
    models: [],
  });
  assertEquals(cacheSaved, true);

  const beforeNoOp = await readStoredSecrets(db);
  await repo.upstreams.saveState(upstream.id, current => current);
  assertEquals((await readStoredSecrets(db)).state_json, beforeNoOp.state_json);

  await repo.upstreams.saveState(upstream.id, current => ({
    ...(current as Record<string, unknown>),
    refreshToken: 'rotated-provider-refresh-token',
  }));
  const afterRotation = await readStoredSecrets(db);
  assertEquals(afterRotation.state_json.includes('rotated-provider-refresh-token'), false);
  assertEquals((await repo.upstreams.getById(upstream.id))?.state, {
    refreshToken: 'rotated-provider-refresh-token',
    accessToken: { token: 'provider-access-token-plaintext' },
  });
});

test('personal upstream repository surfaces missing key material and ciphertext tampering with cause chains', async () => {
  const db = await createSqliteTestDb();
  const encryptedRepo = new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(masterKey) });
  await encryptedRepo.upstreams.save(secretUpstream());

  await assertRejects(
    () => new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(null) }).upstreams.list(),
    Error,
    'Device master key is unavailable',
  );

  const row = await readStoredSecrets(db);
  const envelope = JSON.parse(row.config_json) as { $flowayEncrypted: { ciphertext: string } };
  const ciphertext = envelope.$flowayEncrypted.ciphertext;
  envelope.$flowayEncrypted.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
  await db
    .prepare('UPDATE upstreams SET config_json = ? WHERE id = ?')
    .bind(JSON.stringify(envelope), 'up_personal_secret')
    .run();

  const error = await assertRejects(
    () => encryptedRepo.upstreams.getById('up_personal_secret'),
    Error,
    'Failed to decrypt stored secret for upstream:up_personal_secret:config',
  );
  assertEquals(error.cause === undefined, false);
  assertEquals(error.message.includes('provider-api-key-plaintext'), false);
});

test('personal repository encrypts every non-empty web search provider API key', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(masterKey) });
  const config = {
    provider: 'tavily' as const,
    tavily: { apiKey: 'tavily-provider-secret' },
    microsoftWebIq: { apiKey: 'microsoft-provider-secret' },
    jina: { apiKey: 'jina-provider-secret' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  };

  await repo.webSearchConfig.save(config);
  const row = await db
    .prepare('SELECT protected_tavily_api_key, protected_microsoft_web_iq_api_key, protected_jina_api_key FROM search_config WHERE id = 1')
    .first<{ protected_tavily_api_key: string; protected_microsoft_web_iq_api_key: string; protected_jina_api_key: string }>();
  if (row === null) throw new Error('Expected web search configuration row');

  assertEquals(row.protected_tavily_api_key.includes('tavily-provider-secret'), false);
  assertEquals(row.protected_microsoft_web_iq_api_key.includes('microsoft-provider-secret'), false);
  assertEquals(row.protected_jina_api_key.includes('jina-provider-secret'), false);
  const envelope = JSON.parse(row.protected_tavily_api_key) as { $flowayEncrypted: { version: number } };
  assertEquals(envelope.$flowayEncrypted.version, 1);
  assertEquals(await repo.webSearchConfig.get(), config);
});

test('personal repository preserves empty seeded web search provider keys without requiring migration', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db, { storedSecrets: createAes256GcmStoredSecretCodec(masterKey) });

  const config = await repo.webSearchConfig.get() as {
    tavily: { apiKey: string };
    microsoftWebIq: { apiKey: string };
    jina: { apiKey: string };
  };
  assertEquals(config.tavily.apiKey, '');
  assertEquals(config.microsoftWebIq.apiKey, '');
  assertEquals(config.jina.apiKey, '');
});

test('server upstream repository retains canonical plaintext compatibility', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const upstream = secretUpstream();

  await repo.upstreams.save(upstream);
  const stored = await readStoredSecrets(db);

  assertEquals(JSON.parse(stored.config_json), upstream.config);
  assertEquals(JSON.parse(stored.state_json), upstream.state);
  assertEquals(await repo.upstreams.getById(upstream.id), upstream);
});
