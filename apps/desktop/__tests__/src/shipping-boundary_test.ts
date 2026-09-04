import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');

test('shipping desktop and Node sources contain no verification modes or environment hooks', async () => {
  const sources = await Promise.all([
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/platform-node/src/device-master-key.ts',
    'apps/platform-node/src/run-node-entry.ts',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));

  for (const source of sources) {
    expect(source).not.toContain('--verify-package');
    expect(source).not.toContain('--verify-personal-runtime');
    expect(source).not.toContain('FLOWAY_PERSONAL_VERIFICATION');
  }
  expect(sources[0]).not.toContain('.env("ADMIN_KEY"');
  expect(sources[0]).toContain('.env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token)');
  expect(sources[0]).toContain('WebviewUrl::External(url)');
  expect(sources[0]).toContain('runtime_stdout.contains(&ready_marker)');
});
