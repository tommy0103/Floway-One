import { test } from 'vitest';

import { loadDeviceMasterKey, type DeviceMasterKeyCredential } from '../src/device-master-key.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

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

test('device master key reads the existing 256-bit value without rewriting it', () => {
  const existing = Uint8Array.from({ length: 32 }, (_, index) => index);
  const credential = new MemoryCredential(existing);

  const loaded = loadDeviceMasterKey(false, credential);

  assertEquals(loaded, existing);
  assertEquals(credential.reads, 1);
  assertEquals(credential.writes, []);
  loaded[0] = 255;
  assertEquals(loadDeviceMasterKey(false, credential)[0], 0);
});

test('device master key creates and persists a fresh value only for an empty personal database', () => {
  const credential = new MemoryCredential(null);
  const generated = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

  const loaded = loadDeviceMasterKey(true, credential, size => {
    assertEquals(size, 32);
    return generated;
  });

  assertEquals(loaded, generated);
  assertEquals(credential.writes, [generated]);
});

test('device master key reports missing and malformed credential-store values without exposing bytes', () => {
  assertThrows(
    () => loadDeviceMasterKey(false, new MemoryCredential(null)),
    Error,
    'Floway One device master key is missing from the operating system credential store',
  );
  const error = assertThrows(
    () => loadDeviceMasterKey(false, new MemoryCredential([1, 2, 3])),
    Error,
    'Floway One device master key must contain exactly 32 bytes',
  );
  assertEquals(error.message.includes('1,2,3'), false);
});

test('device master key preserves credential-store failures as error causes', () => {
  const readFailure = new Error('credential store locked');
  const readError = assertThrows(
    () => loadDeviceMasterKey(false, {
      getSecret: () => { throw readFailure; },
      setSecret: () => { throw new Error('unexpected write'); },
    }),
    Error,
    'Failed to read the Floway One device master key from the operating system credential store',
  );
  assert(readError.cause === readFailure);

  const writeFailure = new Error('credential store unavailable');
  const writeError = assertThrows(
    () => loadDeviceMasterKey(true, {
      getSecret: () => null,
      setSecret: () => { throw writeFailure; },
    }),
    Error,
    'Failed to save the Floway One device master key in the operating system credential store',
  );
  assert(writeError.cause === writeFailure);
});
