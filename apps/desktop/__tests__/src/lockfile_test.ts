import { expect, test } from 'vitest';

import { exactPackageVersion, parseDependencyAssociations } from './lockfile.ts';

test('associates each exact version with its owning importer dependency', () => {
  const associations = parseDependencyAssociations(`
importers:
  apps/platform-node:
    dependencies:
      alpha:
        specifier: ^1
        version: 1.2.3(peer@4.5.6)
      beta:
        specifier: ^4
        version: 4.5.6
`, 'apps/platform-node', 'fixture lockfile');

  expect(associations).toEqual(new Map([
    ['alpha', '1.2.3(peer@4.5.6)'],
    ['beta', '4.5.6'],
  ]));
  expect(exactPackageVersion(associations.get('alpha')!, 'alpha')).toBe('1.2.3');
});

test('cannot false-pass when the expected version belongs to another package', () => {
  const associations = parseDependencyAssociations(`
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1
        version: 4.5.6
      beta:
        specifier: ^4
        version: 1.2.3
`, '.', 'swapped lockfile');

  expect(associations.get('alpha')).not.toBe('1.2.3');
  expect(associations.get('beta')).not.toBe('4.5.6');
});

test('rejects a dependency without an exact version association', () => {
  expect(() => parseDependencyAssociations(`
importers:
  .:
    dependencies:
      alpha:
        specifier: ^1
`, '.', 'broken lockfile')).toThrow('broken lockfile dependency alpha has no exact lockfile association');
});
