import { test } from 'vitest';

import {
  createOperatingSystemCredential,
  loadDeviceMasterKey,
  type DeviceMasterKeyCredential,
} from '../src/device-master-key.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

class MemoryCredential implements DeviceMasterKeyCredential {
  reads = 0;
  writes: Uint8Array[] = [];

  constructor(private secret: ArrayLike<number> | null) {}

  getSecret(): ArrayLike<number> | null {
    this.reads++;
    return this.secret;
  }

  setSecret(secret: Uint8Array): void {
    this.secret = [...secret];
    this.writes.push(new Uint8Array(secret));
  }
}

test('device master key reads the existing 256-bit value without rewriting it', async () => {
  const existing = Uint8Array.from({ length: 32 }, (_, index) => index);
  const credential = new MemoryCredential(existing);

  const loaded = await loadDeviceMasterKey(false, credential);

  assertEquals(loaded, existing);
  assertEquals(credential.reads, 1);
  assertEquals(credential.writes, []);
  loaded[0] = 255;
  assertEquals((await loadDeviceMasterKey(false, credential))[0], 0);
});

test('device master key creates, reads back, and returns the persisted value only for an empty personal database', async () => {
  const credential = new MemoryCredential(null);
  const generated = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

  const loaded = await loadDeviceMasterKey(true, credential, size => {
    assertEquals(size, 32);
    return generated;
  });

  assertEquals(loaded, generated);
  assertEquals(credential.writes, [generated]);
  assertEquals(credential.reads, 2);
});

test('device master key serializes concurrent first creation and returns the authoritative persisted winner', async () => {
  let persisted: Uint8Array | null = null;
  let writes = 0;
  let releaseFirstWrite!: () => void;
  const firstWriteReached = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
  let continueFirstWrite!: () => void;
  const firstWriteMayContinue = new Promise<void>(resolve => { continueFirstWrite = resolve; });
  const credential: DeviceMasterKeyCredential = {
    getSecret: () => persisted,
    setSecret: async secret => {
      writes++;
      releaseFirstWrite();
      await firstWriteMayContinue;
      persisted = new Uint8Array(secret);
    },
  };
  const firstGenerated = Uint8Array.from({ length: 32 }, (_, index) => index);
  const secondGenerated = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

  const first = loadDeviceMasterKey(true, credential, () => firstGenerated);
  await firstWriteReached;
  const second = loadDeviceMasterKey(true, credential, () => secondGenerated);
  continueFirstWrite();

  const [firstLoaded, secondLoaded] = await Promise.all([first, second]);
  assertEquals(firstLoaded, firstGenerated);
  assertEquals(secondLoaded, firstGenerated);
  assertEquals(writes, 1);
});

test('device master key reports missing and malformed credential-store values without exposing bytes', async () => {
  await assertRejects(
    () => loadDeviceMasterKey(false, new MemoryCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
  const error = await assertRejects(
    () => loadDeviceMasterKey(false, new MemoryCredential([1, 2, 3])),
    Error,
    'Floway One device master key must contain exactly 32 bytes',
  );
  assertEquals(error.message.includes('1,2,3'), false);
});

test('device master key preserves credential-store failures as error causes', async () => {
  const readFailure = new Error('credential store locked');
  const readError = await assertRejects(
    () => loadDeviceMasterKey(false, {
      getSecret: () => { throw readFailure; },
      setSecret: () => { throw new Error('unexpected write'); },
    }),
    Error,
    'Failed to read the Floway One device master key from the operating system credential store',
  );
  assert(readError.cause === readFailure);

  const writeFailure = new Error('credential store unavailable');
  const writeError = await assertRejects(
    () => loadDeviceMasterKey(true, {
      getSecret: () => null,
      setSecret: () => { throw writeFailure; },
    }),
    Error,
    'Failed to save the Floway One device master key in the operating system credential store',
  );
  assert(writeError.cause === writeFailure);
});

test('Linux requires Secret Service and preserves its unavailable error as the original cause', async () => {
  const unavailable = new Error('No D-Bus session bus');
  const credentialError = await assertRejects(
    async () => createOperatingSystemCredential('Floway test', 'unavailable', 'linux', {
      Entry: class {
        getSecret = () => null;
        setSecret = () => undefined;
        setPassword = () => undefined;
        deleteCredential = () => false;
      },
      findCredentials: () => { throw unavailable; },
    }),
    Error,
    'Linux Secret Service is unavailable for the Floway One device master key',
  );
  assert(credentialError.cause === unavailable);
});
