import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { visitFileTree } from '../../src/filesystem-tree.ts';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { force: true, recursive: true })));
  roots.clear();
});

test('visits files recursively and lets an owning check prune a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-file-tree-'));
  roots.add(root);
  await mkdir(resolve(root, 'kept/nested'), { recursive: true });
  await mkdir(resolve(root, 'skipped/nested'), { recursive: true });
  await writeFile(resolve(root, 'kept/nested/value.txt'), 'kept');
  await writeFile(resolve(root, 'skipped/nested/value.txt'), 'skipped');

  const visited: string[] = [];
  await visitFileTree(root, ({ dirent, path }) => {
    visited.push(path.slice(root.length + 1));
    if (dirent.isDirectory() && dirent.name === 'skipped') return 'skip-directory';
  });

  expect(visited).toContain('kept/nested/value.txt');
  expect(visited).toContain('skipped');
  expect(visited).not.toContain('skipped/nested/value.txt');
});
