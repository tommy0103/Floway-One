import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import type { DeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
import { createOperatingSystemCredential, type DeviceMasterKeyCredential } from '../src/device-master-key.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { createNodeStoredSecretCodec } from '../src/stored-secrets.ts';
import { MemoryDeviceMasterKeyCredential } from './support/memory-device-master-key-credential.ts';
import { createAes256GcmStoredSecretCodec, type SqlDatabase, type StoredSecretContext } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const databaseWithStoredState = (hasUpstreams: boolean, hasSearchCredentials = false): SqlDatabase => ({
  prepare: query => ({
    bind() { return this; },
    first: <T>() => {
      if (query === 'SELECT id FROM upstreams LIMIT 1') {
        return Promise.resolve((hasUpstreams ? { id: 'up_existing' } : null) as T | null);
      }
      if (query.includes('FROM search_config')) {
        return Promise.resolve((hasSearchCredentials ? { id: 1 } : null) as T | null);
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    all: <T>() => {
      if (query === 'SELECT id, config_json, state_json FROM upstreams'
        || query === 'SELECT tavily_api_key, microsoft_web_iq_api_key, jina_api_key FROM search_config') {
        return Promise.resolve({ results: [] as T[], success: true, meta: {} });
      }
      return Promise.reject(new Error(`Unexpected all() query: ${query}`));
    },
    run: () => Promise.reject(new Error('Unexpected run() call')),
  }),
  exec: () => Promise.reject(new Error('Unexpected exec() call')),
});

const creationLock: DeviceMasterKeyCreationLock = { run: operation => operation() };
const testContext = (value: string): StoredSecretContext => value as StoredSecretContext;

const withSqliteStoredValues = async (
  values: {
    additionalConfigJson?: string;
    configJson?: string;
    jinaApiKey?: string;
    microsoftWebIqApiKey?: string;
    stateJson?: string | null;
    tavilyApiKey?: string;
  },
  operation: (database: SqlDatabase) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'floway-stored-secret-startup-'));
  const databasePath = join(directory, 'floway.db');
  const setup = new DatabaseSync(databasePath);
  try {
    setup.exec(`
      CREATE TABLE upstreams (id TEXT PRIMARY KEY, config_json TEXT NOT NULL, state_json TEXT);
      CREATE TABLE search_config (
        id INTEGER PRIMARY KEY,
        tavily_api_key TEXT NOT NULL,
        microsoft_web_iq_api_key TEXT NOT NULL,
        jina_api_key TEXT NOT NULL
      );
    `);
    setup.prepare('INSERT INTO search_config VALUES (1, ?, ?, ?)').run(
      values.tavilyApiKey ?? '',
      values.microsoftWebIqApiKey ?? '',
      values.jinaApiKey ?? '',
    );
    if (values.configJson !== undefined) {
      setup.prepare('INSERT INTO upstreams VALUES (?, ?, ?)').run(
        'up_startup',
        values.configJson,
        values.stateJson ?? null,
      );
    }
    if (values.additionalConfigJson !== undefined) {
      setup.prepare('INSERT INTO upstreams VALUES (?, ?, ?)').run(
        'up_startup_second',
        values.additionalConfigJson,
        null,
      );
    }
  } finally {
    setup.close();
  }
  try {
    await operation(createNodeSqliteDatabase(databasePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('server profile keeps stored provider secrets byte-compatible and never opens the credential store', async () => {
  const credential: DeviceMasterKeyCredential = {
    getSecret: () => { throw new Error('server profile touched credential store'); },
    setSecret: () => { throw new Error('server profile touched credential store'); },
  };
  const codec = await createNodeStoredSecretCodec('server', databaseWithStoredState(true, true), creationLock, credential);

  assertEquals(await codec.seal('{"apiKey":"plaintext-server-value"}', testContext('upstream:one:config')), '{"apiKey":"plaintext-server-value"}');
});

test('personal profile creates an OS-held master key only when no protected provider data exists', async () => {
  const credential = new MemoryDeviceMasterKeyCredential(null);
  const codec = await createNodeStoredSecretCodec('personal', databaseWithStoredState(false), creationLock, credential);
  const stored = await codec.seal('{"apiKey":"provider-secret"}', testContext('upstream:one:config'));

  assertEquals(credential.writes.length, 1);
  assertEquals(credential.writes[0]?.byteLength, 32);
  assertEquals(stored.includes('provider-secret'), false);
});

test('personal profile reports a lost OS-held key for existing upstream or web search credentials', async () => {
  await assertRejects(
    () => createNodeStoredSecretCodec('personal', databaseWithStoredState(true), creationLock, new MemoryDeviceMasterKeyCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
  await assertRejects(
    () => createNodeStoredSecretCodec('personal', databaseWithStoredState(false, true), creationLock, new MemoryDeviceMasterKeyCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
});

test('personal startup rejects a successful Linux keyutils fallback mutation with the Secret Service verification chain', async () => {
  let fallbackMutationSucceeded = false;
  const credential = await createOperatingSystemCredential('Floway test', 'fallback-startup', 'linux', {
    Entry: class {
      getSecret = () => null;
      setSecret = () => undefined;
      setPassword = () => { fallbackMutationSucceeded = true; };
      deleteCredential = () => false;
    },
    findCredentials: () => [],
  });

  const error = await assertRejects(
    () => createNodeStoredSecretCodec('personal', databaseWithStoredState(false), creationLock, credential),
    Error,
    'Failed to save the Floway One device master key in the operating system credential store',
  );
  assertEquals(fallbackMutationSucceeded, true);
  assertEquals(
    (error.cause as Error).message,
    'Failed to verify the Floway One device master key in Linux Secret Service',
  );
});

test('personal startup rejects a plaintext upstream configuration before serving', () => withSqliteStoredValues(
  { configJson: '{"apiKey":"plaintext"}' },
  async database => {
    await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(new Uint8Array(32).fill(1)),
      ),
      Error,
      'Invalid encrypted stored secret format for upstream:up_startup:config',
    );
  },
));

test('personal startup rejects upstream state encrypted with the wrong device key', async () => {
  const storedWithWrongKey = createAes256GcmStoredSecretCodec(new Uint8Array(32).fill(2));
  const activeKey = new Uint8Array(32).fill(1);
  const activeCodec = createAes256GcmStoredSecretCodec(activeKey);
  await withSqliteStoredValues({
    configJson: await activeCodec.seal('{"apiKey":"valid"}', testContext('upstream:up_startup:config')),
    stateJson: await storedWithWrongKey.seal('{"refreshToken":"wrong-key"}', testContext('upstream:up_startup:state')),
  }, async database => {
    const error = await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(activeKey),
      ),
      Error,
      'Failed to decrypt stored secret for upstream:up_startup:state',
    );
    assert(error.cause instanceof Error);
  });
});

test('personal startup rejects a tampered web search credential', async () => {
  const key = new Uint8Array(32).fill(3);
  const codec = createAes256GcmStoredSecretCodec(key);
  const envelope = JSON.parse(await codec.seal('tavily-secret', testContext('web-search:tavily:api-key'))) as {
    $flowayEncrypted: { ciphertext: string };
  };
  const first = envelope.$flowayEncrypted.ciphertext[0] ?? 'A';
  envelope.$flowayEncrypted.ciphertext = `${first === 'A' ? 'B' : 'A'}${envelope.$flowayEncrypted.ciphertext.slice(1)}`;
  await withSqliteStoredValues({ tavilyApiKey: JSON.stringify(envelope) }, async database => {
    const error = await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(key),
      ),
      Error,
      'Failed to decrypt stored secret for web-search:tavily:api-key',
    );
    assert(error.cause instanceof Error);
  });
});

test('personal startup preserves malformed web search envelope causes', () => withSqliteStoredValues(
  { microsoftWebIqApiKey: '{' },
  async database => {
    const error = await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(new Uint8Array(32).fill(4)),
      ),
      Error,
      'Invalid encrypted stored secret format for web-search:microsoft-web-iq:api-key',
    );
    assert(error.cause instanceof SyntaxError);
  },
));

test('personal startup rejects unsupported upstream envelope versions', () => withSqliteStoredValues(
  {
    configJson: JSON.stringify({
      $flowayEncrypted: { version: 2, algorithm: 'AES-256-GCM', nonce: '', ciphertext: '' },
    }),
  },
  async database => {
    await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(new Uint8Array(32).fill(5)),
      ),
      Error,
      'Unsupported encrypted stored secret version 2 for upstream:up_startup:config',
    );
  },
));

test('personal startup validates every upstream row rather than only the first', async () => {
  const key = new Uint8Array(32).fill(7);
  const codec = createAes256GcmStoredSecretCodec(key);
  await withSqliteStoredValues({
    configJson: await codec.seal('{"apiKey":"valid"}', testContext('upstream:up_startup:config')),
    additionalConfigJson: '{',
  }, async database => {
    const error = await assertRejects(
      () => createNodeStoredSecretCodec(
        'personal',
        database,
        creationLock,
        new MemoryDeviceMasterKeyCredential(key),
      ),
      Error,
      'Invalid encrypted stored secret format for upstream:up_startup_second:config',
    );
    assert(error.cause instanceof SyntaxError);
  });
});

test('personal startup validates every upstream and web search protected field', async () => {
  const key = new Uint8Array(32).fill(6);
  const codec = createAes256GcmStoredSecretCodec(key);
  await withSqliteStoredValues({
    configJson: await codec.seal('{"apiKey":"valid"}', testContext('upstream:up_startup:config')),
    stateJson: await codec.seal('{"refreshToken":"valid"}', testContext('upstream:up_startup:state')),
    tavilyApiKey: await codec.seal('tavily', testContext('web-search:tavily:api-key')),
    microsoftWebIqApiKey: await codec.seal('microsoft', testContext('web-search:microsoft-web-iq:api-key')),
    jinaApiKey: await codec.seal('jina', testContext('web-search:jina:api-key')),
  }, async database => {
    await createNodeStoredSecretCodec(
      'personal',
      database,
      creationLock,
      new MemoryDeviceMasterKeyCredential(key),
    );
  });
});
