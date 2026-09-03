import { formatWithOptions } from 'node:util';

import { test, vi } from 'vitest';

import { createAes256GcmStoredSecretCodec, type StoredSecretContext } from '../src/stored-secret-codec.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const masterKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const testContext = (value: string): StoredSecretContext => value as StoredSecretContext;

test('AES-256-GCM stored secrets round-trip without exposing plaintext and use fresh nonces', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const plaintext = JSON.stringify({ apiKey: 'provider-secret-value' });

  const context = testContext('upstream:one:config');
  const first = await codec.seal(plaintext, context);
  const second = await codec.seal(plaintext, context);

  assertEquals(first.includes('provider-secret-value'), false);
  assertEquals(second.includes('provider-secret-value'), false);
  assertEquals(first === second, false);
  assertEquals(await codec.open(first, context), plaintext);
  assertEquals(await codec.open(second, context), plaintext);
});

test('stored secret authentication binds ciphertext to its field context', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const stored = await codec.seal('{"token":"secret"}', testContext('upstream:one:state'));

  const error = await assertRejects(
    () => codec.open(stored, testContext('upstream:two:state')),
    Error,
    'Failed to decrypt stored secret for upstream:two:state',
  );
  assert(error.cause !== undefined);
});

test('stored secret authentication rejects tampering without including plaintext in the error', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const plaintext = '{"refreshToken":"never-log-this"}';
  const context = testContext('upstream:one:state');
  const stored = await codec.seal(plaintext, context);
  const parsed = JSON.parse(stored) as { $flowayEncrypted: { ciphertext: string } };
  const ciphertext = parsed.$flowayEncrypted.ciphertext;
  parsed.$flowayEncrypted.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;

  const error = await assertRejects(
    () => codec.open(JSON.stringify(parsed), context),
    Error,
    'Failed to decrypt stored secret for upstream:one:state',
  );
  assert(error.cause !== undefined);
  assertEquals(error.message.includes('never-log-this'), false);
});

test('stored secret codec rejects missing keys, unsupported versions, and plaintext rows visibly', async () => {
  const missingKeyCodec = createAes256GcmStoredSecretCodec(null);
  await assertRejects(
    () => missingKeyCodec.seal('{}', testContext('upstream:one:config')),
    Error,
    'Device master key is unavailable',
  );

  const codec = createAes256GcmStoredSecretCodec(masterKey);
  await assertRejects(
    () => codec.open('{"$flowayEncrypted":{"version":2,"algorithm":"AES-256-GCM","nonce":"","ciphertext":""}}', testContext('upstream:one:config')),
    Error,
    'Unsupported encrypted stored secret version 2 for upstream:one:config',
  );
  const plaintextError = await assertRejects(
    () => codec.open('{"apiKey":"plaintext"}', testContext('upstream:one:config')),
    Error,
    'Invalid encrypted stored secret format for upstream:one:config',
  );
  assertEquals(plaintextError.message.includes('plaintext'), false);
});

test('stored secret codec rejects nonnumeric versions without exposing the value', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const sentinel = 'VERSIONLEAK13';
  const error = await assertRejects(
    () => codec.open(
      JSON.stringify({
        $flowayEncrypted: {
          version: sentinel,
          algorithm: 'AES-256-GCM',
          nonce: '',
          ciphertext: '',
        },
      }),
      testContext('upstream:one:config'),
    ),
    Error,
    'Invalid encrypted stored secret version for upstream:one:config',
  );

  assertEquals(`${error.stack}\n${String(error.cause)}`.includes(sentinel), false);
});

test('stored secret codec preserves malformed base64 decoding failures', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const decodingFailure = new Error('sentinel base64 decoder failure');
  const atob = vi.spyOn(globalThis, 'atob').mockImplementation(() => { throw decodingFailure; });
  try {
    const error = await assertRejects(
      () => codec.open('{"$flowayEncrypted":{"version":1,"algorithm":"AES-256-GCM","nonce":"A","ciphertext":"A"}}', testContext('upstream:one:config')),
      Error,
      'Invalid encrypted stored secret format for upstream:one:config',
    );
    assert(error.cause === decodingFailure);
  } finally {
    atob.mockRestore();
  }
});

test('malformed stored secret envelopes retain SyntaxError classification without exposing input', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const sentinel = 'LEAKME7';
  const error = await assertRejects(
    () => codec.open(
      `{"$flowayEncrypted":${sentinel}}`,
      testContext('upstream:one:config'),
    ),
    Error,
    'Invalid encrypted stored secret format for upstream:one:config',
  );

  assert(error.cause instanceof SyntaxError);
  assert(error.cause.stack?.includes('at JSON.parse'));
  assert(error.cause.stack?.includes('stored-secret-codec.ts'));
  assertEquals(`${error.stack}\n${error.cause.stack}`.includes(sentinel), false);
});

test('malformed stored secret envelopes retain safe parser codes without retaining protected diagnostics', async () => {
  const codec = createAes256GcmStoredSecretCodec(masterKey);
  const sentinel = 'PARSER_CODE_LEAK_SENTINEL';
  const parseFailure = new SyntaxError(`Unexpected token ${sentinel} in protected input at position 7`);
  Object.defineProperty(parseFailure, 'code', { value: 'ERR_JSON_TEST_PARSE' });
  parseFailure.stack = `${parseFailure.name}: ${parseFailure.message}\n    at JSON.parse (<anonymous>)\n    at syntheticParser (safe-parser.ts:7:11)`;
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw parseFailure; });
  try {
    const error = await assertRejects(
      () => codec.open(`{"$flowayEncrypted":${sentinel}}`, testContext('upstream:one:config')),
      Error,
      'Invalid encrypted stored secret format for upstream:one:config',
    );
    const cause = error.cause as SyntaxError & { readonly code?: string; readonly position?: number };
    assert(cause instanceof SyntaxError);
    assertEquals(cause.code, 'ERR_JSON_TEST_PARSE');
    assertEquals(cause.position, 7);
    assert(cause.stack?.includes('at JSON.parse'));
    assert(cause.stack?.includes('at syntheticParser'));

    const rendered = formatWithOptions({ colors: false, depth: null }, '%o', error);
    const logged: string[] = [];
    const log = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(formatWithOptions({ colors: false, depth: null }, '%o', ...args));
    });
    try {
      console.error(error);
    } finally {
      log.mockRestore();
    }
    for (const diagnostic of [error.message, error.stack, cause.message, cause.stack, rendered, ...logged]) {
      assertEquals(diagnostic?.includes(sentinel), false);
    }
  } finally {
    parse.mockRestore();
  }
});
