import { beforeEach, expect, test } from 'vitest';

import {
  personalDashboardBootstrapFragmentKey,
  takePersonalDashboardBootstrapToken,
} from '../../src/auth/session.ts';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

test('takes the desktop bootstrap token and clears it from the URL before returning', () => {
  const token = 'ab'.repeat(32);
  window.history.replaceState(
    null,
    '',
    `/welcome?source=desktop#theme=dark&${personalDashboardBootstrapFragmentKey}=${token}&panel=overview`,
  );

  expect(takePersonalDashboardBootstrapToken()).toBe(token);
  expect(window.location.pathname).toBe('/welcome');
  expect(window.location.search).toBe('?source=desktop');
  expect(window.location.hash).toBe('#theme=dark&panel=overview');
  expect(window.location.href).not.toContain(token);
});

test('leaves the URL untouched when no desktop bootstrap token exists', () => {
  window.history.replaceState(null, '', '/#theme=dark');

  expect(takePersonalDashboardBootstrapToken()).toBeNull();
  expect(window.location.hash).toBe('#theme=dark');
});
