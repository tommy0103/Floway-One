import { expect, test } from 'vitest';

import { nextUpdateVerificationVersion } from './update-fixtures.ts';

test.each([
  ['0.1.0', '0.2.0'], ['0.2.0', '0.3.0'], ['1.9.7', '1.10.0'], ['10.20.30', '10.21.0'],
])('Floway packaged upgrade verification advances the current release %s to %s', (current, expected) => {
  expect(nextUpdateVerificationVersion(current)).toBe(expected);
});
