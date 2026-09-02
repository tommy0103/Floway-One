import { test } from 'vitest';

import { createAes256GcmStoredSecretCodec } from '../src/stored-secret-codec.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const masterKey = Uint8Array.from({ length: 32 }, (_, index) => index);

test('AES-256-GCM stored secrets round-trip without exposing plaintext and use fresh nonces', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const plaintext = JSON.stringify({ apiKey: 'provider-secret-value' });

  const first = await codec.seal(plaintext, 'upstream:one:config');
  const second = await codec.seal(plaintext, 'upstream:one:config');

  assertEquals(first.includes('provider-secret-value'), false);
  assertEquals(second.includes('provider-secret-value'), false);
  assertEquals(first === second, false);
  assertEquals(await codec.open(first, 'upstream:one:config'), plaintext);
  assertEquals(await codec.open(second, 'upstream:one:config'), plaintext);
});

test('stored secret authentication binds ciphertext to its field context', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const stored = await codec.seal('{"token":"secret"}', 'upstream:one:state');

  const error = await assertRejects(
    () => codec.open(stored, 'upstream:two:state'),
    Error,
    'Failed to decrypt stored secret for upstream:two:state',
  );
  assert(error.cause !== undefined);
});

test('stored secret authentication rejects tampering without including plaintext in the error', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const plaintext = '{"refreshToken":"never-log-this"}';
  const stored = await codec.seal(plaintext, 'upstream:one:state');
  const parsed = JSON.parse(stored) as { $flowayEncrypted: { ciphertext: string } };
  const ciphertext = parsed.$flowayEncrypted.ciphertext;
  parsed.$flowayEncrypted.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;

  const error = await assertRejects(
    () => codec.open(JSON.stringify(parsed), 'upstream:one:state'),
    Error,
    'Failed to decrypt stored secret for upstream:one:state',
  );
  assert(error.cause !== undefined);
  assertEquals(error.message.includes('never-log-this'), false);
});

test('stored secret codec rejects missing keys, unsupported versions, and plaintext rows visibly', async () => {
  const missingKeyCodec = createAes256GcmStoredSecretCodec(null);
  await assertRejects(
    () => missingKeyCodec.seal('{}', 'upstream:one:config'),
    Error,
    'Device master key is unavailable',
  );

  const codec = createAes256GcmStoredSecretCodec(masterKey);
  await assertRejects(
    () => codec.open('{"$flowayEncrypted":{"version":2,"algorithm":"AES-256-GCM","nonce":"","ciphertext":""}}', 'upstream:one:config'),
    Error,
    'Unsupported encrypted stored secret version 2 for upstream:one:config',
  );
  const plaintextError = await assertRejects(
    () => codec.open('{"apiKey":"plaintext"}', 'upstream:one:config'),
    Error,
    'Invalid encrypted stored secret format for upstream:one:config',
  );
  assertEquals(plaintextError.message.includes('plaintext'), false);
});
