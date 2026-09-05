import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from 'vitest';

import { createInstalledAppVerificationContext } from './support/installed-app.ts';
import { withFailureSafeCleanup } from '../../src/failure-chain.ts';

test('installed app context derives one coherent owned path set', async () => {
  await withFailureSafeCleanup(async cleanup => {
    const root = await mkdtemp(join(tmpdir(), 'floway-installed-context-'));
    cleanup.defer('installed context fixture', async () => await rm(root, { force: true, recursive: true }));
    const app = resolve(root, 'Floway.app');
    const files = [
      'Contents/MacOS/floway-one',
      'Contents/MacOS/floway-node',
      'Contents/Resources/desktop-bundle-contract.json',
      'Contents/Resources/runtime/apps/platform-node/entry.js',
      'Contents/Resources/runtime/apps/platform-node/node_modules/@napi-rs/keyring/keyring.node',
    ];
    await Promise.all(files.map(async relative => {
      const path = resolve(app, relative);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, relative);
    }));
    await mkdir(
      resolve(app, 'Contents/Resources/runtime/apps/platform-node/node_modules/@floway-dev/gateway/migrations'),
      { recursive: true },
    );

    const context = await createInstalledAppVerificationContext(
      app,
      'Contents/Resources/runtime/apps/platform-node/node_modules/@napi-rs/keyring/keyring.node',
      ['0001.sql'],
    );
    expect(context.appRoot).toBe(app);
    expect(context.entry).toContain('/Contents/Resources/runtime/apps/platform-node/entry.js');
    expect(context.migrationNames).toEqual(['0001.sql']);
  });
});

test('installed app context rejects a mismatched path combination before probing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-installed-context-'));
  try {
    await expect(createInstalledAppVerificationContext(
      resolve(root, 'Floway.app'),
      '../../outside-keyring.node',
      ['0001.sql'],
    )).rejects.toThrow('escapes its owning application');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
