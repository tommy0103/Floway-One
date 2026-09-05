import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { exchangeDirectoriesAtomically } from '../../src/atomic-directory.ts';
import { assertPackagedRuntime, prepareDesktopBundle } from '../../src/bundle.ts';
import { compilePackagedRuntime } from '../../src/packaged-runtime.ts';
import { targetTripleForHost } from '../../src/release-contract.ts';

const roots = new Set<string>();
const desktopRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureMigrations: ReadonlyArray<readonly [string, string]> = [
  ['0001_initial.sql', 'CREATE TABLE packaged_probe (value INTEGER);'],
  ['0002_independent.sql', 'ALTER TABLE packaged_probe ADD COLUMN independent INTEGER;'],
];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-desktop-bundle-'));
  roots.add(root);
  return root;
};

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { force: true, recursive: true })));
  roots.clear();
});

const writeCanonicalMigrations = async (root: string): Promise<string> => {
  const migrationsRoot = resolve(root, 'canonical-migrations');
  await mkdir(migrationsRoot, { recursive: true });
  await Promise.all(fixtureMigrations.map(async ([name, source]) => await writeFile(resolve(migrationsRoot, name), source)));
  return migrationsRoot;
};

const generateFixtureRuntime = async (runtimeRoot: string): Promise<void> => {
  const files: Array<[string, string]> = [
    [
      'apps/platform-node/entry.ts',
      "import { packagedValue } from '@floway-dev/gateway'; if (packagedValue !== 42) throw new Error('gateway import failed');",
    ],
    ['apps/platform-node/src/runtime.ts', 'export const profile: string = \'personal\';'],
    [
      'apps/platform-node/node_modules/@floway-dev/gateway/package.json',
      JSON.stringify({
        name: '@floway-dev/gateway',
        type: 'module',
        exports: { '.': { import: './src/index.ts', types: './src/index.ts' } },
      }),
    ],
    [
      'apps/platform-node/node_modules/@floway-dev/gateway/src/index.ts',
      'export const packagedValue: number = 42;',
    ],
    ...fixtureMigrations.map(([name, source]) => [
      `apps/platform-node/node_modules/@floway-dev/gateway/migrations/${name}`,
      source,
    ] as [string, string]),
    ['apps/web/dist/client/index.html', '<!doctype html>'],
    ['apps/web/dist/client/dashboard-routes.json', '["/"]'],
    ['apps/web/dist/client/assets/lazy-dashboard.js', 'export const lazyDashboard = true;'],
  ];
  await Promise.all(files.map(async ([file, content]) => {
    const path = resolve(runtimeRoot, file);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, content);
  }));
};

describe('desktop bundle preparation', () => {
  test('maps the validated runtime and Node sidecar to the installed paths Rust resolves', async () => {
    const config = JSON.parse(
      await readFile(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as {
      bundle: { externalBin: string[]; resources: Record<string, string> };
      productName: string;
      version: string;
    };
    const [desktopManifest, sidecarManifest, dashboardManifest, cargoManifest] = await Promise.all([
      readFile(resolve(desktopRoot, 'package.json'), 'utf8').then(JSON.parse) as Promise<{ version: string }>,
      readFile(resolve(desktopRoot, '../platform-node/package.json'), 'utf8').then(JSON.parse) as Promise<{ version: string }>,
      readFile(resolve(desktopRoot, '../web/package.json'), 'utf8').then(JSON.parse) as Promise<{ version: string }>,
      readFile(resolve(desktopRoot, 'src-tauri/Cargo.toml'), 'utf8'),
    ]);
    expect(config.productName).toBe('Floway');
    expect(config.version).toBe(desktopManifest.version);
    expect(sidecarManifest.version).toBe(desktopManifest.version);
    expect(dashboardManifest.version).toBe(desktopManifest.version);
    expect(cargoManifest).toMatch(new RegExp(`^version = "${desktopManifest.version.replaceAll('.', '\\.')}"$`, 'mu'));
    expect(config.bundle.externalBin).toEqual(['bundle-inputs/binaries/floway-node']);
    expect(config.bundle.resources).toEqual({
      'bundle-inputs/desktop-bundle-contract.json': 'desktop-bundle-contract.json',
      'bundle-inputs/runtime/': 'runtime/',
    });
  });

  test('packages the exact compatible Node executable with the complete generated runtime', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), '24.19.0\n');
    const nodeExecutable = process.execPath;
    const sourceManifest = resolve(root, 'workspace-gateway-package.json');
    const sourceManifestValue = JSON.stringify({
      name: '@floway-dev/gateway',
      type: 'module',
      exports: { '.': { import: './src/index.ts', types: './src/index.ts' } },
    });
    await writeFile(sourceManifest, sourceManifestValue);
    const targetTriple = targetTripleForHost(process.platform, process.arch);
    const generateRuntime = vi.fn(async (runtimeRoot: string) => {
      expect((await stat(resolve(runtimeRoot, '..'))).isDirectory()).toBe(true);
      expect(runtimeRoot.startsWith(resolve(root, 'src-tauri/bundle-inputs'))).toBe(false);
      await generateFixtureRuntime(runtimeRoot);
      const commandShim = resolve(runtimeRoot, 'apps/platform-node/node_modules/.bin/runtime-tool');
      await mkdir(resolve(commandShim, '..'), { recursive: true });
      await writeFile(commandShim, 'unused command shim');
      const deployedManifest = resolve(
        runtimeRoot,
        'apps/platform-node/node_modules/@floway-dev/gateway/package.json',
      );
      await rm(deployedManifest);
      await link(sourceManifest, deployedManifest);
    });

    const prepared = await prepareDesktopBundle({
      canonicalMigrationsRoot: await writeCanonicalMigrations(root),
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: process.arch,
      nodeExecutable,
      nodePlatform: process.platform,
      nodeVersion: '24.19.0',
      releaseVersion: '0.1.0',
      targetTriple,
    });

    expect(prepared.nodeSidecar).toBe(resolve(
      root,
      `src-tauri/bundle-inputs/binaries/floway-node-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`,
    ));
    expect(prepared.contractPath).toBe(resolve(root, 'src-tauri/bundle-inputs/desktop-bundle-contract.json'));
    const contract = JSON.parse(await readFile(prepared.contractPath, 'utf8')) as {
      compatibility?: { protocolVersion?: unknown; releaseVersion?: unknown };
      dashboard?: { assets?: Array<{ path?: unknown; sha256?: unknown }> };
      migrations?: { files?: Array<{ path?: unknown; sha256?: unknown }> };
    };
    expect(contract.compatibility).toEqual({
      protocolVersion: 1,
      releaseVersion: '0.1.0',
    });
    expect(contract.dashboard?.assets?.map(asset => asset.path)).toEqual([
      'assets/lazy-dashboard.js',
      'dashboard-routes.json',
      'index.html',
    ]);
    expect(contract.dashboard?.assets?.every(asset => /^[\da-f]{64}$/.test(String(asset.sha256)))).toBe(true);
    expect(contract.migrations?.files?.map(file => file.path)).toEqual([
      '0001_initial.sql',
      '0002_independent.sql',
    ]);
    expect(contract.migrations?.files?.every(file => /^[\da-f]{64}$/.test(String(file.sha256)))).toBe(true);
    expect((await stat(prepared.nodeSidecar)).size).toBe((await stat(nodeExecutable)).size);
    if (process.platform !== 'win32') {
      expect((await stat(prepared.nodeSidecar)).mode & 0o777).toBe(0o755);
    }
    expect(generateRuntime).toHaveBeenCalledOnce();
    expect(await readFile(sourceManifest, 'utf8')).toBe(sourceManifestValue);
    await expect(stat(resolve(
      prepared.runtimeRoot,
      'apps/platform-node/node_modules/.bin',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(assertPackagedRuntime(prepared.runtimeRoot)).resolves.toBeUndefined();
  });

  test('rejects an assembly omission against canonical migrations before publishing a contract', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const canonicalMigrationsRoot = await writeCanonicalMigrations(root);
    await expect(prepareDesktopBundle({
      canonicalMigrationsRoot,
      desktopRoot: root,
      generateRuntime: async runtimeRoot => {
        await generateFixtureRuntime(runtimeRoot);
        await rm(resolve(runtimeRoot, 'apps/platform-node/node_modules/@floway-dev/gateway/migrations/0002_independent.sql'));
      },
      nodeArchitecture: process.arch,
      nodeExecutable: process.execPath,
      nodePlatform: process.platform,
      nodeVersion: process.versions.node,
      releaseVersion: '0.1.0',
      targetTriple: targetTripleForHost(process.platform, process.arch),
      executeNode: false,
      validateSidecar: async () => undefined,
    })).rejects.toThrow('differs from canonical source');
    await expect(stat(resolve(root, 'src-tauri/bundle-inputs/desktop-bundle-contract.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects assembly migration tampering against canonical digests before publishing', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const canonicalMigrationsRoot = await writeCanonicalMigrations(root);
    await expect(prepareDesktopBundle({
      canonicalMigrationsRoot,
      desktopRoot: root,
      generateRuntime: async runtimeRoot => {
        await generateFixtureRuntime(runtimeRoot);
        await writeFile(
          resolve(runtimeRoot, 'apps/platform-node/node_modules/@floway-dev/gateway/migrations/0001_initial.sql'),
          'tampered before contract generation',
        );
      },
      nodeArchitecture: process.arch,
      nodeExecutable: process.execPath,
      nodePlatform: process.platform,
      nodeVersion: process.versions.node,
      releaseVersion: '0.1.0',
      targetTriple: targetTripleForHost(process.platform, process.arch),
      executeNode: false,
      validateSidecar: async () => undefined,
    })).rejects.toThrow('differs from canonical source');
    await expect(stat(resolve(root, 'src-tauri/bundle-inputs/desktop-bundle-contract.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('keeps the previous complete inputs when staged sidecar validation fails', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const targetTriple = targetTripleForHost(process.platform, process.arch);
    const options = {
      canonicalMigrationsRoot: await writeCanonicalMigrations(root),
      desktopRoot: root,
      generateRuntime: generateFixtureRuntime,
      nodeArchitecture: process.arch,
      nodeExecutable: process.execPath,
      nodePlatform: process.platform,
      nodeVersion: process.versions.node,
      releaseVersion: '0.1.0',
      targetTriple,
    } as const;
    const published = await prepareDesktopBundle(options);
    const priorEntry = await readFile(resolve(published.runtimeRoot, 'apps/platform-node/entry.js'), 'utf8');
    const priorContract = await readFile(published.contractPath, 'utf8');
    const priorSidecar = await stat(published.nodeSidecar);
    const validateSidecar = vi.fn(async (path: string) => {
      expect(path.startsWith(resolve(root, 'src-tauri/.bundle-staging'))).toBe(true);
      throw new Error('forced staged sidecar validation failure');
    });

    await expect(prepareDesktopBundle({ ...options, validateSidecar })).rejects.toThrow(
      'forced staged sidecar validation failure',
    );

    expect(validateSidecar).toHaveBeenCalledOnce();
    expect(await readFile(resolve(published.runtimeRoot, 'apps/platform-node/entry.js'), 'utf8')).toBe(priorEntry);
    expect(await readFile(published.contractPath, 'utf8')).toBe(priorContract);
    expect((await stat(published.nodeSidecar)).size).toBe(priorSidecar.size);
    await expect(stat(resolve(root, 'src-tauri/.bundle-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('publishes a replacement complete input tree with one directory exchange', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const targetTriple = targetTripleForHost(process.platform, process.arch);
    let generation = 0;
    const generateRuntime = async (runtimeRoot: string): Promise<void> => {
      await generateFixtureRuntime(runtimeRoot);
      await writeFile(resolve(runtimeRoot, 'apps/platform-node/src/runtime.ts'), `export const generation = ${++generation};`);
    };
    const options = {
      canonicalMigrationsRoot: await writeCanonicalMigrations(root),
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: process.arch,
      nodeExecutable: process.execPath,
      nodePlatform: process.platform,
      nodeVersion: process.versions.node,
      releaseVersion: '0.1.0',
      targetTriple,
    } as const;
    const first = await prepareDesktopBundle(options);
    const firstRuntime = await readFile(resolve(first.runtimeRoot, 'apps/platform-node/src/runtime.js'), 'utf8');
    const exchangeDirectories = vi.fn(exchangeDirectoriesAtomically);

    const second = await prepareDesktopBundle({ ...options, exchangeDirectories });

    expect(exchangeDirectories).toHaveBeenCalledOnce();
    expect(await readFile(resolve(second.runtimeRoot, 'apps/platform-node/src/runtime.js'), 'utf8')).not.toBe(firstRuntime);
    await expect(stat(resolve(root, 'src-tauri/.bundle-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  test('keeps the prior complete tree when its single atomic publish operation fails', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const targetTriple = targetTripleForHost(process.platform, process.arch);
    const options = {
      canonicalMigrationsRoot: await writeCanonicalMigrations(root),
      desktopRoot: root,
      generateRuntime: generateFixtureRuntime,
      nodeArchitecture: process.arch,
      nodeExecutable: process.execPath,
      nodePlatform: process.platform,
      nodeVersion: process.versions.node,
      releaseVersion: '0.1.0',
      targetTriple,
    } as const;
    const published = await prepareDesktopBundle(options);
    const priorContract = await readFile(published.contractPath, 'utf8');
    const publishFailure = new Error('forced atomic publish failure');

    let error: Error | undefined;
    try {
      await prepareDesktopBundle({
        ...options,
        exchangeDirectories: async () => { throw publishFailure; },
      });
    } catch (value) {
      error = value as Error;
    }

    expect(error?.message).toBe('Failed to atomically publish the complete desktop bundle inputs');
    expect(error?.cause).toBe(publishFailure);
    expect(await readFile(published.contractPath, 'utf8')).toBe(priorContract);
    await expect(assertPackagedRuntime(published.runtimeRoot)).resolves.toBeUndefined();
  }, 20_000);

  test('aggregates staging rollback cleanup failure behind the original assembly cause', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), `${process.versions.node}\n`);
    const assemblyFailure = new Error('forced runtime assembly failure');
    const cleanupFailure = new Error('forced staging rollback cleanup failure');
    let error: AggregateError | undefined;
    try {
      await prepareDesktopBundle({
        canonicalMigrationsRoot: await writeCanonicalMigrations(root),
        desktopRoot: root,
        generateRuntime: async () => { throw assemblyFailure; },
        nodeArchitecture: process.arch,
        nodeExecutable: process.execPath,
        nodePlatform: process.platform,
        nodeVersion: process.versions.node,
        releaseVersion: '0.1.0',
        targetTriple: targetTripleForHost(process.platform, process.arch),
        cleanupStaging: async () => { throw cleanupFailure; },
      });
    } catch (value) {
      error = value as AggregateError;
    }

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.cause).toBe(assemblyFailure);
    expect(error?.errors[0]).toBe(assemblyFailure);
    expect((error?.errors[1] as Error).cause).toBe(cleanupFailure);
  });

  test('rejects a target that cannot use the build-host Node executable before generation', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), '24.19.0\n');
    const generateRuntime = vi.fn(generateFixtureRuntime);

    await expect(prepareDesktopBundle({
      canonicalMigrationsRoot: resolve(root, 'canonical-migrations'),
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: 'arm64',
      nodeExecutable: resolve(root, 'node'),
      nodePlatform: 'darwin',
      nodeVersion: '24.19.0',
      releaseVersion: '0.1.0',
      targetTriple: 'x86_64-apple-darwin',
    })).rejects.toThrow('incompatible with the build host darwin/arm64');
    expect(generateRuntime).not.toHaveBeenCalled();
  });

  test('rejects an incompatible Node runtime before generation', async () => {
    const root = await temporaryRoot();
    await writeFile(resolve(root, '.node-version'), '24.19.0\n');
    const generateRuntime = vi.fn(generateFixtureRuntime);

    await expect(prepareDesktopBundle({
      canonicalMigrationsRoot: resolve(root, 'canonical-migrations'),
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: 'arm64',
      nodeExecutable: resolve(root, 'node'),
      nodePlatform: 'darwin',
      nodeVersion: '24.18.0',
      releaseVersion: '0.1.0',
      targetTriple: 'aarch64-apple-darwin',
    })).rejects.toThrow('Desktop bundles require Node.js 24.19.0; received 24.18.0');
    expect(generateRuntime).not.toHaveBeenCalled();
  });

  test('fails when generated migrations are absent and retains the filesystem cause', async () => {
    const root = await temporaryRoot();
    const runtimeRoot = resolve(root, 'runtime');
    await generateFixtureRuntime(runtimeRoot);
    await compilePackagedRuntime(runtimeRoot);
    await rm(resolve(runtimeRoot, 'apps/platform-node/node_modules/@floway-dev/gateway/migrations'), {
      force: true,
      recursive: true,
    });

    let error: Error | undefined;
    try {
      await assertPackagedRuntime(runtimeRoot);
    } catch (value) {
      error = value as Error;
    }
    expect(error).toBeDefined();
    if (error === undefined) throw new Error('Expected missing migrations to fail');
    expect(error.message).toContain('Desktop bundle migrations are unavailable');
    expect(error.cause).toMatchObject({ code: 'ENOENT' });
  });

  test.skipIf(process.platform === 'win32')(
    'rejects dependency symlinks that Tauri would silently omit',
    async () => {
      const root = await temporaryRoot();
      const runtimeRoot = resolve(root, 'runtime');
      await generateFixtureRuntime(runtimeRoot);
      await compilePackagedRuntime(runtimeRoot);
      const dependency = resolve(runtimeRoot, 'apps/platform-node/node_modules/linked-runtime-package');
      await symlink(resolve(runtimeRoot, 'apps/platform-node'), dependency, 'dir');

      await expect(assertPackagedRuntime(runtimeRoot)).rejects.toThrow(
        `Desktop bundle dependency must be physical for Tauri resources: ${dependency}`,
      );
    },
  );
});
