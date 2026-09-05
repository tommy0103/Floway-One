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
    'apps/desktop/src-tauri/src/runtime_controller.rs',
    'apps/desktop/src-tauri/src/runtime_status.rs',
    'apps/desktop/src-tauri/src/sidecar_log.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const [_app, _bundle, _library, _navigation, runtimeController, _runtimeStatus, _sidecarLog, supervisor] = desktopSources;
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
  expect(runtimeController).not.toContain('.env("ADMIN_KEY"');
  expect(runtimeController).not.toContain('.env("PORT"');
  expect(runtimeController).toContain('.env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())');
  expect(runtimeController).toContain('.navigate(dashboard_url)');
  expect(runtimeController).toContain('ready_dashboard_origin(&runtime_stdout)');
  expect(runtimeController).toContain('.on_navigation(move |candidate|');
  expect(runtimeController).toContain('.on_new_window(move |candidate, _features|');
  expect(runtimeController).toContain('NewWindowResponse::Deny');
  const ownerSetup = runtimeController.indexOf('supervisor: PackageProcessSupervisor::new(),');
  const preflight = runtimeController.indexOf('let runtime = resolve_runtime_bundle(&resource_dir)?;');
  const registeredSpawn = runtimeController.indexOf('let events = controller.supervisor.spawn_registered(||');
  expect(ownerSetup).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(-1);
  expect(registeredSpawn).toBeGreaterThan(preflight);
  expect(supervisor).toContain('Registration shares one lock with stop/termination bookkeeping');
});

test('issue 16 recovery adds no issue 17 general lifetime policy', async () => {
  const sources = await Promise.all([
    'apps/desktop/src-tauri/src/app.rs',
    'apps/desktop/src-tauri/src/runtime_controller.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
    'apps/desktop/src-tauri/Cargo.toml',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const combined = sources.join('\n');
  for (const deferredPolicy of [
    'signal_hook',
    'SIGTERM',
    'GRACEFUL_SHUTDOWN',
    'SingleInstance',
    'Autostart',
    'CloseRequested',
    '.hide()',
    'GRACEFUL_QUIT',
  ]) {
    expect(combined).not.toContain(deferredPolicy);
  }
  expect(combined).toContain('failure-only restart transition');
  expect(combined).toContain('automatic restart,');
  expect(combined).toContain('TrayIconBuilder');
  expect(combined).toContain('restart_failed_runtime');
  expect(combined).toContain('RunEvent::ExitRequested');
  expect(combined).toContain('ProcessState::StopRequested');
  expect(combined).toContain('ProcessState::Terminated');
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
    if (path === 'apps/desktop/src-tauri/src/runtime_controller.rs') return line.includes('.join(');
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
