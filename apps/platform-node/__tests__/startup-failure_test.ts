import { expect, test, vi } from 'vitest';

import {
  classifyDesktopStartupFailure,
  desktopFailureEvent,
  reportDesktopStartupFailure,
  startupFailure,
} from '../src/startup-failure.ts';

test('keeps an explicit startup category and the complete original error chain', () => {
  const sqlite = Object.assign(new Error('database is read only'), { code: 'SQLITE_READONLY' });
  const migration = new Error('migration 0042 failed', { cause: sqlite });
  const failure = startupFailure('migration', 'Floway could not apply its local database migrations', migration);

  const event = desktopFailureEvent(failure);

  expect(event.kind).toBe('migration');
  expect(event.chain).toHaveLength(3);
  expect(event.chain[0]).toContain('Floway could not apply its local database migrations');
  expect(event.chain[1]).toContain('migration 0042 failed');
  expect(event.chain[2]).toContain('database is read only');
  expect(failure.cause).toBe(migration);
  expect(migration.cause).toBe(sqlite);
});

test.each([
  ['EADDRINUSE', 'port'],
  ['ERR_DLOPEN_FAILED', 'native-dependency'],
  ['MODULE_NOT_FOUND', 'native-dependency'],
  ['EACCES', 'storage'],
  ['EDQUOT', 'storage'],
  ['ENOSPC', 'storage'],
  ['EPERM', 'storage'],
  ['EROFS', 'storage'],
] as const)('classifies %s without replacing the source error', (code, expected) => {
  const cause = Object.assign(new Error('operating system detail'), { code });
  const failure = new Error('outer context', { cause });
  expect(classifyDesktopStartupFailure(failure)).toBe(expected);
  expect(failure.cause).toBe(cause);
});

test('emits structured diagnostics only for a packaged desktop launch', () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previous = process.env.FLOWAY_DESKTOP_CONTRACT;
  try {
    delete process.env.FLOWAY_DESKTOP_CONTRACT;
    expect(reportDesktopStartupFailure(new Error('server failure'))).toBe(false);
    expect(write).not.toHaveBeenCalled();

    process.env.FLOWAY_DESKTOP_CONTRACT = '/desktop-contract.json';
    expect(reportDesktopStartupFailure(new Error('native load failed'), 'native-dependency')).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('"kind":"native-dependency"');
    expect(String(write.mock.calls[0]?.[0])).toContain('native load failed');
  } finally {
    if (previous === undefined) delete process.env.FLOWAY_DESKTOP_CONTRACT;
    else process.env.FLOWAY_DESKTOP_CONTRACT = previous;
    write.mockRestore();
  }
});
