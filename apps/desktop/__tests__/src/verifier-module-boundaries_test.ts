import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const desktopRoot = resolve(import.meta.dirname, '../..');

test('packaged verifier orchestrates cohesive test-support modules', async () => {
  const source = await readFile(resolve(desktopRoot, '__tests__/src/packaged-desktop-verifier.ts'), 'utf8');
  expect(source.split('\n').length).toBeLessThan(350);
  for (const module of ['installed-app', 'package-contract', 'personal-runtime', 'process-lifecycle']) {
    expect(source).toContain(`./support/${module}.ts`);
  }
  for (const lowLevelBoundary of ['node:sqlite', 'node:net', 'ChildProcessByStdio', 'parseDependencyAssociations']) {
    expect(source).not.toContain(lowLevelBoundary);
  }
});

test('verifier-only output cleanup support lives outside production src', async () => {
  const entry = await readFile(resolve(desktopRoot, 'src/test-desktop.ts'), 'utf8');
  expect(entry).toContain('../__tests__/src/desktop-verification.ts');
  await expect(readFile(resolve(desktopRoot, 'src/desktop-verification.ts'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
});
