import { expect, test } from 'vitest';

import { sqliteNoCaseUsernameIdentity } from '../../src/repo/user-identities.ts';

test('username storage identity matches SQLite ASCII NOCASE semantics', () => {
  expect(sqliteNoCaseUsernameIdentity('Admin')).toBe('admin');
  expect(sqliteNoCaseUsernameIdentity('ADMIN_01-Test.User')).toBe('admin_01-test.user');
  expect(sqliteNoCaseUsernameIdentity('Ä')).toBe('Ä');
});
