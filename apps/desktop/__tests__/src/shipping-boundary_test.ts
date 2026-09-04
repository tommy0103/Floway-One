import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const execFileAsync = promisify(execFile);

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
  expect(sources[0]).not.toContain('.env("PORT"');
  expect(sources[0]).toContain('.env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())');
  expect(sources[0]).toContain('WebviewUrl::External(url)');
  expect(sources[0]).toContain('ready_dashboard_origin(&runtime_stdout)');
});

test('the legacy product identifier remains only in established bundle, app-data, credential, and path identifiers', async () => {
  const productIdentifier = ['Floway', 'One'].join(' ');
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const textExtensions = new Set(['.js', '.json', '.md', '.mjs', '.rs', '.sh', '.toml', '.ts', '.tsx', '.yaml', '.yml']);
  const occurrences: Array<{ line: string; path: string }> = [];
  for (const path of stdout.split('\0').filter(Boolean)) {
    if (!textExtensions.has(extname(path))) continue;
    let source: string;
    try {
      source = await readFile(resolve(repositoryRoot, path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of source.split('\n')) {
      if (line.includes(productIdentifier)) occurrences.push({ line, path });
    }
  }

  const allowed = occurrences.filter(({ line, path }) => {
    if (path === 'apps/desktop/src-tauri/tauri.conf.json') return line.includes('productName');
    if (path === 'apps/desktop/__tests__/src/packaged-desktop-verifier.ts') return line.includes('.app');
    if (path === 'apps/platform-node/src/device-master-key-credential-identity.ts') return line.includes('service:');
    if (path === 'apps/platform-node/src/personal-runtime.ts') {
      return line.includes('Application Support') || line.includes('win32.join');
    }
    if (path === 'apps/platform-node/__tests__/packaged-node-verifier.ts') return line.includes('join(');
    if (path === 'apps/platform-node/__tests__/personal-runtime_test.ts') {
      return line.includes('Application Support')
        || line.includes('Roaming')
        || line.includes('runtimePaths(join');
    }
    if (path === 'docs/floway-one-spec.zh-CN.md') {
      return line.includes('.app')
        || line.includes('Application Support')
        || line.includes('%APPDATA%')
        || line.trim() === `${productIdentifier}/`;
    }
    return false;
  });

  expect(occurrences.length).toBeGreaterThan(0);
  expect(allowed).toEqual(occurrences);
});
