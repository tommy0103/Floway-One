import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { FsFileStore } from '../src/fs-file-store.ts';
import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';
import { initializePersonalStorage } from '../src/personal-storage.ts';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const withTempPaths = async (operation: (paths: ReturnType<typeof resolvePersonalRuntimePaths>) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-personal-storage-'));
  const paths = resolvePersonalRuntimePaths({
    dataDir: join(root, 'data'),
    stableUserHome: root,
  });
  try {
    await operation(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('personal storage recursively hardens existing directories, SQLite files, logs, and file-store contents', () => withTempPaths(async paths => {
  await mkdir(join(paths.filesDir, 'existing'), { recursive: true, mode: 0o755 });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o755 });
  await Promise.all([
    writeFile(join(paths.filesDir, 'existing', 'body.bin'), 'secret', { mode: 0o644 }),
    writeFile(join(paths.logsDir, 'floway.log'), 'log', { mode: 0o644 }),
    writeFile(paths.databasePath, '', { mode: 0o644 }),
    writeFile(`${paths.databasePath}-wal`, '', { mode: 0o644 }),
    writeFile(`${paths.databasePath}-shm`, '', { mode: 0o644 }),
  ]);
  if (process.platform !== 'win32') {
    await Promise.all([
      chmod(paths.dataDir, 0o755),
      chmod(paths.filesDir, 0o755),
      chmod(paths.logsDir, 0o755),
    ]);
  }

  const hardener = initializePersonalStorage(paths);
  const store = new FsFileStore(paths.filesDir, hardener);
  await store.put('new/nested/body.bin', new TextEncoder().encode('new-secret'));
  const database = createNodeSqliteDatabase(paths.databasePath, { permissions: hardener });
  if (process.platform !== 'win32') await chmod(`${paths.databasePath}-wal`, 0o644);
  await database.exec('SELECT 1');

  assertEquals(new TextDecoder().decode(await readFile(join(paths.filesDir, 'new/nested/body.bin'))), 'new-secret');
  if (process.platform !== 'win32') {
    for (const directory of [paths.dataDir, paths.filesDir, paths.logsDir, join(paths.filesDir, 'existing'), join(paths.filesDir, 'new'), join(paths.filesDir, 'new/nested')]) {
      assertEquals(await mode(directory), 0o700);
      assertEquals((await stat(directory)).uid, userInfo().uid);
    }
    for (const file of [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`, join(paths.filesDir, 'existing/body.bin'), join(paths.filesDir, 'new/nested/body.bin'), join(paths.logsDir, 'floway.log')]) {
      assertEquals(await mode(file), 0o600);
      assertEquals((await stat(file)).uid, userInfo().uid);
    }
  }
}));

test('personal storage preserves the original hardening failure as its cause', () => withTempPaths(async paths => {
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(paths.filesDir, 'occupied');

  const error = await assertRejects(
    async () => initializePersonalStorage(paths),
    Error,
    `Floway could not enforce current-user-only access on directory ${paths.filesDir}`,
  );
  assert(error.cause instanceof Error);
  assertEquals((error.cause as NodeJS.ErrnoException).code, 'EEXIST');
}));

test('Windows hardening caches an unchanged SQLite file identity and re-hardens each replacement once', () => withTempPaths(async paths => {
  const calls: Array<{ kind: 'directory' | 'file' | 'tree'; path: string }> = [];
  const hardener = initializePersonalStorage(paths, {
    platform: 'win32',
    applyWindowsAcl: (path, kind) => calls.push({ kind, path }),
  });
  const store = new FsFileStore(paths.filesDir, hardener);
  await store.put('nested/body.bin', new Uint8Array([1]));
  const auxiliaries = ['-journal', '-wal', '-shm'].map(suffix => `${paths.databasePath}${suffix}`);
  await Promise.all([writeFile(paths.databasePath, ''), ...auxiliaries.map(path => writeFile(path, 'first'))]);
  hardener.hardenSqliteFiles(paths.databasePath);
  const firstCounts = new Map(
    [paths.databasePath, ...auxiliaries].map(path => [path, calls.filter(call => call.path === path).length]),
  );
  hardener.hardenSqliteFiles(paths.databasePath);
  for (const path of [paths.databasePath, ...auxiliaries]) {
    assertEquals(calls.filter(call => call.path === path).length, firstCounts.get(path));
  }
  await Promise.all(auxiliaries.map(path => rm(path)));
  await Promise.all(auxiliaries.map(path => writeFile(path, 'recreated')));
  const replacementCallStart = calls.length;
  hardener.hardenSqliteFiles(paths.databasePath);

  assert(calls.some(call => call.kind === 'tree' && call.path === paths.dataDir));
  assert(calls.some(call => call.kind === 'directory' && call.path.endsWith('nested')));
  assert(calls.some(call => call.kind === 'file' && call.path.endsWith('body.bin')));
  for (const path of auxiliaries) {
    assertEquals(calls.filter(call => call.path === path).length, (firstCounts.get(path) ?? 0) + 1);
  }
  assertEquals(calls.slice(replacementCallStart), auxiliaries.map(path => ({ kind: 'file', path })));
}));
