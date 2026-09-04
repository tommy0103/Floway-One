import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const execFileAsync = promisify(execFile);

test('shipping desktop and Node sources contain no verification modes or environment hooks', async () => {
  const desktopSources = await Promise.all([
    'apps/desktop/src-tauri/src/app.rs',
    'apps/desktop/src-tauri/src/bundle_contract.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/src/navigation.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const [app, _bundle, _library, _navigation, supervisor] = desktopSources;
  const nodeSources = await Promise.all([
    'apps/platform-node/src/device-master-key.ts',
    'apps/platform-node/src/run-node-entry.ts',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const sources = [
    ...desktopSources,
    ...nodeSources,
  ];

  for (const source of sources) {
    expect(source).not.toContain('--verify-package');
    expect(source).not.toContain('--verify-personal-runtime');
    expect(source).not.toContain('FLOWAY_PERSONAL_VERIFICATION');
  }
  expect(app).not.toContain('.env("ADMIN_KEY"');
  expect(app).not.toContain('.env("PORT"');
  expect(app).toContain('.env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())');
  expect(app).toContain('WebviewUrl::External(url)');
  expect(app).toContain('ready_dashboard_origin(&runtime_stdout)');
  expect(app).toContain('.on_navigation(move |candidate|');
  expect(app).toContain('.on_new_window(move |candidate, _features|');
  expect(app).toContain('NewWindowResponse::Deny');
  const ownerSetup = app.indexOf('let supervisor = PackageProcessSupervisor::new();');
  const preflight = app.indexOf('let runtime = resolve_runtime_bundle(&resource_dir)?;');
  const registeredSpawn = app.indexOf('let events = supervisor.spawn_registered(||');
  expect(ownerSetup).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(ownerSetup);
  expect(registeredSpawn).toBeGreaterThan(preflight);
  expect(supervisor).toContain('Registration shares one lock with stop/termination bookkeeping');
});

test('issue 15 process safety introduces no issue 17 window or owner-lifetime policy', async () => {
  const sources = await Promise.all([
    'apps/desktop/src-tauri/src/app.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
    'apps/desktop/src-tauri/Cargo.toml',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const combined = sources.join('\n');
  for (const deferredPolicy of [
    'signal_hook',
    'SIGTERM',
    'GRACEFUL_SHUTDOWN',
    'TrayIcon',
    'SingleInstance',
    'Autostart',
    'CloseRequested',
    '.hide()',
    'restart_sidecar',
  ]) {
    expect(combined).not.toContain(deferredPolicy);
  }
  expect(combined).toContain('Window, tray, singleton, restart,');
  expect(combined).toContain('RunEvent::ExitRequested');
  expect(combined).toContain('std::process::exit(1)');
});

test('root desktop verification delegates every acquired output to failure-chain aggregation', async () => {
  const source = await readFile(resolve(repositoryRoot, 'apps/desktop/src/test-desktop.ts'), 'utf8');
  expect(source).not.toContain('finally {');
  expect(source).toContain('withFailureSafeCleanup(async cleanup =>');
  expect(source).toContain('withFailureSafeCleanup(async targetCleanup =>');
  expect(source).toContain('deferDisposableDesktopPaths(cleanup, generatedDesktopOutputs)');
  expect(source).toContain('deferDisposableDesktopPaths(targetCleanup, [');
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
      return line.includes('Application Support')
        || line.includes('%APPDATA%')
        || line.trim() === `${productIdentifier}/`;
    }
    return false;
  });

  expect(occurrences.length).toBeGreaterThan(0);
  expect(allowed).toEqual(occurrences);
});
