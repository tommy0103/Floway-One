import { test } from 'vitest';

import { parseStoredJson } from '../../src/repo/stored-json.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

test('malformed protected JSON retains SyntaxError classification without exposing input', () => {
  const sentinel = 'LEAKME8';
  const error = assertThrows(
    () => parseStoredJson(`{"apiKey":${sentinel}}`, 'Malformed protected upstream configuration'),
    Error,
    'Malformed protected upstream configuration',
  );

  assert(error.cause instanceof SyntaxError);
  assertEquals(`${error.stack}\n${error.cause.stack}`.includes(sentinel), false);
});
