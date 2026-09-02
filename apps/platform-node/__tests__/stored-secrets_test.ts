import { test } from 'vitest';

import type { DeviceMasterKeyCredential } from '../src/device-master-key.ts';
import { createNodeStoredSecretCodec } from '../src/stored-secrets.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

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
    all: () => Promise.reject(new Error('Unexpected all() call')),
    run: () => Promise.reject(new Error('Unexpected run() call')),
  }),
  exec: () => Promise.reject(new Error('Unexpected exec() call')),
});

class MemoryCredential implements DeviceMasterKeyCredential {
  writes: Uint8Array[] = [];

  constructor(private secret: ArrayLike<number> | null) {}

  getSecret(): ArrayLike<number> | null {
    return this.secret;
  }

  setSecret(secret: Uint8Array): void {
    this.secret = [...secret];
    this.writes.push(new Uint8Array(secret));
  }
}

test('server profile keeps stored provider secrets byte-compatible and never opens the credential store', async () => {
  const credential: DeviceMasterKeyCredential = {
    getSecret: () => { throw new Error('server profile touched credential store'); },
    setSecret: () => { throw new Error('server profile touched credential store'); },
  };
  const codec = await createNodeStoredSecretCodec('server', databaseWithStoredState(true, true), credential);

  assertEquals(await codec.seal('{"apiKey":"plaintext-server-value"}', 'upstream:one:config'), '{"apiKey":"plaintext-server-value"}');
});

test('personal profile creates an OS-held master key only when no protected provider data exists', async () => {
  const credential = new MemoryCredential(null);
  const codec = await createNodeStoredSecretCodec('personal', databaseWithStoredState(false), credential);
  const stored = await codec.seal('{"apiKey":"provider-secret"}', 'upstream:one:config');

  assertEquals(credential.writes.length, 1);
  assertEquals(credential.writes[0]?.byteLength, 32);
  assertEquals(stored.includes('provider-secret'), false);
});

test('personal profile reports a lost OS-held key for existing upstream or web search credentials', async () => {
  await assertRejects(
    () => createNodeStoredSecretCodec('personal', databaseWithStoredState(true), new MemoryCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
  await assertRejects(
    () => createNodeStoredSecretCodec('personal', databaseWithStoredState(false, true), new MemoryCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
});
