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
    'apps/desktop/src-tauri/src/rendered_snapshot.rs',
    'apps/desktop/src-tauri/src/runtime_controller.rs',
    'apps/desktop/src-tauri/src/runtime_status.rs',
    'apps/desktop/src-tauri/src/shell_autostart.rs',
    'apps/desktop/src-tauri/src/shell_singleton.rs',
    'apps/desktop/src-tauri/src/sidecar_log.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
    'apps/desktop/src-tauri/src/update_channel.rs',
    'apps/desktop/src-tauri/src/update_controller.rs',
    'apps/desktop/src-tauri/src/update_state.rs',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const [
    _app,
    _bundle,
    _library,
    _navigation,
    _renderedSnapshot,
    runtimeController,
    _runtimeStatus,
    _shellAutostart,
    _shellSingleton,
    _sidecarLog,
    supervisor,
    _updateChannel,
    updateController,
    _updateState,
  ] = desktopSources;
  const nodeSources = await Promise.all([
    'apps/platform-node/src/desktop-sidecar-lifecycle.ts',
    'apps/platform-node/src/device-master-key.ts',
    'apps/platform-node/src/run-node-entry.ts',
    'apps/platform-node/src/update-recovery-point.ts',
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
  expect(runtimeController).not.toContain('FLOWAY_DESKTOP_LOGS_DIR');
  expect(runtimeController).toContain('DesktopPaths::from_args(platform_data_dir, std::env::args_os())');
  expect(runtimeController).toContain('.env(PERSONAL_DASHBOARD_BOOTSTRAP_ENV, bootstrap_token.clone())');
  expect(runtimeController).toContain('.navigate(dashboard_url)');
  expect(runtimeController).toContain('ready_dashboard_origin(&runtime_stdout)');
  expect(runtimeController).toContain('.on_navigation(move |candidate|');
  expect(runtimeController).toContain('.on_new_window(move |candidate, _features|');
  expect(runtimeController).toContain('NewWindowResponse::Deny');
  expect(updateController).toContain('tauri_plugin_updater::Error::Minisign');
  const recoveryPoint = updateController.indexOf('self.create_recovery_point(bundle)');
  const installSwap = updateController.indexOf('update.install(&bytes)');
  expect(recoveryPoint).toBeGreaterThan(-1);
  expect(installSwap).toBeGreaterThan(recoveryPoint);
  const ownerSetup = runtimeController.indexOf('supervisor: PackageProcessSupervisor::new(),');
  const preflight = runtimeController.indexOf('let runtime = resolve_runtime_bundle(&resource_dir).map_err');
  const registeredSpawn = runtimeController.indexOf('.spawn_registered(||');
  expect(ownerSetup).toBeGreaterThan(-1);
  expect(preflight).toBeGreaterThan(-1);
  expect(registeredSpawn).toBeGreaterThan(preflight);
  expect(supervisor).toContain('Registration shares one lock with stop/termination bookkeeping');
});

test('the Node entry does not relabel every untyped startup failure as a native dependency', async () => {
  const entry = await readFile(resolve(repositoryRoot, 'apps/platform-node/entry.ts'), 'utf8');
  expect(entry).toContain('reportDesktopStartupFailure(failure);');
  expect(entry).not.toContain("reportDesktopStartupFailure(failure, 'native-dependency')");
});

test('desktop lifetime policy lives in its owning modules without plugins or signal crates', async () => {
  const [app, controller, shellAutostart, shellSingleton, supervisor, cargoManifest] = await Promise.all([
    'apps/desktop/src-tauri/src/app.rs',
    'apps/desktop/src-tauri/src/runtime_controller.rs',
    'apps/desktop/src-tauri/src/shell_autostart.rs',
    'apps/desktop/src-tauri/src/shell_singleton.rs',
    'apps/desktop/src-tauri/src/sidecar_supervisor.rs',
    'apps/desktop/src-tauri/Cargo.toml',
  ].map(async path => await readFile(resolve(repositoryRoot, path), 'utf8')));
  const combined = [app, controller, shellAutostart, shellSingleton, supervisor, cargoManifest].join('\n');
  // The supervisor owns only packaged-process stop policy.
  expect(supervisor).toContain('libc::SIGTERM');
  expect(supervisor).toContain('stop_gracefully');
  expect(supervisor).not.toContain('CloseRequested');
  expect(supervisor).not.toContain('.hide()');
  // Window, tray, singleton, and quit policy stay in the runtime controller.
  // The CloseRequested→prevent_close→hide chain itself is proven dynamically
  // by the packaged gate driving window.close() through the control channel,
  // so no static close-path assertion belongs here; only the production
  // routing of the control verb stays pinned.
  expect(controller).toContain('fn close_main_window(');
  expect(controller).toContain('ShellCommand::CloseWindow => close_main_window(app)');
  expect(controller).toContain('establish_shell_role(');
  expect(controller).toContain('RunEvent::Reopen');
  expect(controller).toContain('stop_gracefully(GRACEFUL_STOP_SIGNAL_TIMEOUT)');
  // Singleton ownership and the login item have their own modules.
  expect(shellSingleton).toContain('claim_shell_ownership');
  expect(shellAutostart).toContain('launchctl');
  for (const deferredPolicy of [
    'signal_hook',
    'GRACEFUL_SHUTDOWN',
    'GRACEFUL_QUIT',
    'tauri-plugin-single-instance',
    'tauri-plugin-autostart',
    'SingleInstance',
  ]) {
    expect(combined).not.toContain(deferredPolicy);
  }
  expect(combined).toContain('Owns only packaged child registration, termination, and teardown settlement.');
  expect(combined).toContain('TrayIconBuilder');
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
    if (path === 'apps/desktop/src-tauri/src/desktop_paths.rs') return line.includes('.join(');
    if (path === 'apps/desktop/src-tauri/__tests__/src/desktop_paths_test.rs') return line.includes('PathBuf::from(');
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
