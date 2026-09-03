import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { assertPackagedRuntime, prepareDesktopBundle } from '../src/bundle.ts';
import { compilePackagedRuntime } from '../src/packaged-runtime.ts';

const roots = new Set<string>();
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'floway-desktop-bundle-'));
  roots.add(root);
  return root;
};

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { force: true, recursive: true })));
  roots.clear();
});

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
    [
      'apps/platform-node/node_modules/@floway-dev/gateway/migrations/0001_initial.sql',
      'CREATE TABLE packaged_probe (value INTEGER);',
    ],
    ['apps/web/dist/client/index.html', '<!doctype html>'],
    ['apps/web/dist/client/dashboard-routes.json', '["/"]'],
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
    };
    expect(config.bundle.externalBin).toEqual(['binaries/floway-node']);
    expect(config.bundle.resources).toEqual({ 'resources/runtime/': 'runtime/' });
  });

  test('packages the exact compatible Node executable with the complete generated runtime', async () => {
    const root = await temporaryRoot();
    const nodeExecutable = process.execPath;
    const sourceManifest = resolve(root, 'workspace-gateway-package.json');
    const sourceManifestValue = JSON.stringify({
      name: '@floway-dev/gateway',
      type: 'module',
      exports: { '.': { import: './src/index.ts', types: './src/index.ts' } },
    });
    await writeFile(sourceManifest, sourceManifestValue);
    const targetTriple = {
      darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
      linux: { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' },
      win32: { arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' },
    }[process.platform as 'darwin' | 'linux' | 'win32'][process.arch as 'arm64' | 'x64'];
    const generateRuntime = vi.fn(async (runtimeRoot: string) => {
      expect((await stat(resolve(runtimeRoot, '..'))).isDirectory()).toBe(true);
      expect(runtimeRoot.startsWith(resolve(root, 'src-tauri/resources'))).toBe(false);
      await generateFixtureRuntime(runtimeRoot);
      const deployedManifest = resolve(
        runtimeRoot,
        'apps/platform-node/node_modules/@floway-dev/gateway/package.json',
      );
      await rm(deployedManifest);
      await link(sourceManifest, deployedManifest);
    });

    const prepared = await prepareDesktopBundle({
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: process.arch,
      nodeExecutable,
      nodePlatform: process.platform,
      nodeVersion: '24.19.0',
      targetTriple,
    });

    expect(prepared.nodeSidecar).toBe(resolve(
      root,
      `src-tauri/binaries/floway-node-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`,
    ));
    expect((await stat(prepared.nodeSidecar)).size).toBe((await stat(nodeExecutable)).size);
    if (process.platform !== 'win32') {
      expect((await stat(prepared.nodeSidecar)).mode & 0o777).toBe(0o755);
    }
    expect(generateRuntime).toHaveBeenCalledOnce();
    expect(await readFile(sourceManifest, 'utf8')).toBe(sourceManifestValue);
    await expect(assertPackagedRuntime(prepared.runtimeRoot)).resolves.toBeUndefined();
  });

  test('rejects a target that cannot use the build-host Node executable before generation', async () => {
    const root = await temporaryRoot();
    const generateRuntime = vi.fn(generateFixtureRuntime);

    await expect(prepareDesktopBundle({
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: 'arm64',
      nodeExecutable: resolve(root, 'node'),
      nodePlatform: 'darwin',
      nodeVersion: '24.19.0',
      targetTriple: 'x86_64-apple-darwin',
    })).rejects.toThrow('incompatible with the build host darwin/arm64');
    expect(generateRuntime).not.toHaveBeenCalled();
  });

  test('rejects an incompatible Node runtime before generation', async () => {
    const root = await temporaryRoot();
    const generateRuntime = vi.fn(generateFixtureRuntime);

    await expect(prepareDesktopBundle({
      desktopRoot: root,
      generateRuntime,
      nodeArchitecture: 'arm64',
      nodeExecutable: resolve(root, 'node'),
      nodePlatform: 'darwin',
      nodeVersion: '24.18.0',
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
