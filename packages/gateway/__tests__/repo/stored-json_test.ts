import { formatWithOptions } from 'node:util';

import { test } from 'vitest';

import { parseStoredJson } from '../../src/repo/stored-json.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

test('malformed protected JSON retains SyntaxError classification without exposing input', () => {
  const sentinel = 'LEAKME8';
  const error = assertThrows(
    () => parseStoredJson(`{"apiKey":"${sentinel}" trailing}`, 'Malformed protected upstream configuration'),
    Error,
    'Malformed protected upstream configuration',
  );

  assert(error.cause instanceof SyntaxError);
  const causeChain = [error, error.cause]
    .map(cause => `${cause.name}: ${cause.message}\n${cause.stack ?? ''}`)
    .join('\ncaused by: ');
  const logged = formatWithOptions({ colors: false, depth: null }, '%o', error);
  assert(error.cause.stack?.includes('at JSON.parse'));
  assert(error.cause.stack?.includes('stored-json.ts'));
  assertEquals(error.cause.message, 'Protected stored value contains malformed JSON');
  assertEquals(Reflect.get(error.cause, 'position'), 20);
  assertEquals(causeChain.includes(sentinel), false);
  assertEquals(logged.includes(sentinel), false);
});
