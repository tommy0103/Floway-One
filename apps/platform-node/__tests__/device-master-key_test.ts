import { test } from 'vitest';

import type { DeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
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

const creationLock: DeviceMasterKeyCreationLock = { run: operation => operation() };

test('device master key reads the existing 256-bit value without rewriting it', async () => {
  const existing = Uint8Array.from({ length: 32 }, (_, index) => index);
  const credential = new MemoryCredential(existing);

  const loaded = await loadDeviceMasterKey(creationLock, false, credential);

  assertEquals(loaded, existing);
  assertEquals(credential.reads, 1);
  assertEquals(credential.writes, []);
  loaded[0] = 255;
  assertEquals((await loadDeviceMasterKey(creationLock, false, credential))[0], 0);
});

test('device master key creates, reads back, and returns the persisted value only for an empty personal database', async () => {
  const credential = new MemoryCredential(null);
  const generated = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

  const loaded = await loadDeviceMasterKey(creationLock, true, credential, size => {
    assertEquals(size, 32);
    return generated;
  });

  assertEquals(loaded, generated);
  assertEquals(credential.writes, [generated]);
  assertEquals(credential.reads, 2);
});

test('device master key reports missing and malformed credential-store values without exposing bytes', async () => {
  await assertRejects(
    () => loadDeviceMasterKey(creationLock, false, new MemoryCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
  const error = await assertRejects(
    () => loadDeviceMasterKey(creationLock, false, new MemoryCredential([1, 2, 3])),
    Error,
    'Floway One device master key must contain exactly 32 bytes',
  );
  assertEquals(error.message.includes('1,2,3'), false);
});

test('device master key preserves credential-store failures as error causes', async () => {
  const readFailure = new Error('credential store locked');
  const readError = await assertRejects(
    () => loadDeviceMasterKey(creationLock, false, {
      getSecret: () => { throw readFailure; },
      setSecret: () => { throw new Error('unexpected write'); },
    }),
    Error,
    'Failed to read the Floway One device master key from the operating system credential store',
  );
  assert(readError.cause === readFailure);

  const writeFailure = new Error('credential store unavailable');
  const writeError = await assertRejects(
    () => loadDeviceMasterKey(creationLock, true, {
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

test('Linux rejects a successful vendor keyutils fallback mutation when Secret Service readback has no value', async () => {
  let fallbackPassword: string | null = null;
  let secretServiceReads = 0;
  const credential = createOperatingSystemCredential('Floway test', 'fallback', 'linux', {
    Entry: class {
      getSecret = () => null;
      setSecret = () => undefined;
      setPassword = (password: string) => { fallbackPassword = password; };
      deleteCredential = () => false;
    },
    findCredentials: () => {
      secretServiceReads++;
      return [];
    },
  });

  const error = await assertRejects(
    () => loadDeviceMasterKey(creationLock, true, credential, () => new Uint8Array(32).fill(7)),
    Error,
    'Failed to save the Floway One device master key in the operating system credential store',
  );
  assert(fallbackPassword !== null, 'the vendor fallback mutation must report success before rejection');
  assertEquals(secretServiceReads, 3);
  assert(error.cause instanceof Error);
  assertEquals(error.cause.message, 'Failed to verify the Floway One device master key in Linux Secret Service');
});
