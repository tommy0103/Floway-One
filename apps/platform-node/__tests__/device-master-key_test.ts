import { test } from 'vitest';

import type { DeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
import {
  loadDeviceMasterKey,
} from '../src/device-master-key.ts';
import { desktopFailureEvent } from '../src/startup-failure.ts';
import { MemoryDeviceMasterKeyCredential } from './support/memory-device-master-key-credential.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const creationLock: DeviceMasterKeyCreationLock = { run: operation => operation() };

test('device master key reads the existing 256-bit value without rewriting it', async () => {
  const existing = Uint8Array.from({ length: 32 }, (_, index) => index);
  const credential = new MemoryDeviceMasterKeyCredential(existing);

  const loaded = await loadDeviceMasterKey(creationLock, false, credential);

  assertEquals(loaded, existing);
  assertEquals(credential.reads, 1);
  assertEquals(credential.writes, []);
  loaded[0] = 255;
  assertEquals((await loadDeviceMasterKey(creationLock, false, credential))[0], 0);
});

test('device master key creates, reads back, and returns the persisted value only for an empty personal database', async () => {
  const credential = new MemoryDeviceMasterKeyCredential(null);
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
    () => loadDeviceMasterKey(creationLock, false, new MemoryDeviceMasterKeyCredential(null)),
    Error,
    'Floway local device master key is missing; existing encrypted data requires migration',
  );
  const error = await assertRejects(
    () => loadDeviceMasterKey(creationLock, false, new MemoryDeviceMasterKeyCredential([1, 2, 3])),
    Error,
    'Floway device master key must contain exactly 32 bytes',
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
    'Failed to read the Floway device master key from the local key store',
  );
  assert(readError.cause === readFailure);

  const writeFailure = new Error('credential store unavailable');
  const writeError = await assertRejects(
    () => loadDeviceMasterKey(creationLock, true, {
      getSecret: () => null,
      setSecret: () => { throw writeFailure; },
    }),
    Error,
    'Failed to save the Floway device master key in the local key store',
  );
  assert(writeError.cause === writeFailure);
});

test('Floway reports denied credential access without creating or replacing a key', async () => {
  const denied = Object.assign(new Error('User interaction is not allowed'), { code: -25308 });
  let writes = 0;
  let generations = 0;
  for (const createIfMissing of [true, false]) {
    const failure = await assertRejects(() => loadDeviceMasterKey(creationLock, createIfMissing, {
      getSecret: () => { throw denied; },
      setSecret: () => { writes++; },
    }, () => { generations++; return new Uint8Array(32); }));
    const report = desktopFailureEvent(failure);
    assertEquals(report.kind, 'credential');
    assertEquals(failure.cause, denied);
    assert(report.chain.some(entry => entry.includes('User interaction is not allowed')));
  }
  assertEquals(writes, 0);
  assertEquals(generations, 0);
});
