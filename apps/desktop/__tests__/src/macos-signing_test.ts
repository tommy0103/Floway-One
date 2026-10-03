import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

import { signPackagedMachOResources } from '../../src/macos-signing.ts';

const execute = promisify(execFile);

test.runIf(process.platform === 'darwin')('Floway signs extensionless tools and native resources without changing plain data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-native-signing-'));
  try {
    const nested = join(root, 'node_modules/native');
    await mkdir(nested, { recursive: true });
    const files = ['tool', 'binding.node', 'library.dylib'];
    for (const name of files) await copyFile(process.execPath, join(nested, name));
    await writeFile(join(nested, 'data.js'), 'export const value = 42;');
    await signPackagedMachOResources(root, '-');
    for (const name of files) {
      const { stderr } = await execute('codesign', ['--display', '--verbose=4', join(nested, name)]);
      expect(stderr).toContain('Signature=adhoc');
      expect(stderr).toMatch(/flags=.*\bruntime\b/u);
      await execute('codesign', ['--verify', '--strict', join(nested, name)]);
    }
    expect(await readFile(join(nested, 'data.js'), 'utf8')).toBe('export const value = 42;');
    await expect(signPackagedMachOResources(root, 'Floway Missing Signing Identity')).rejects.toThrow('Floway could not sign packaged native code');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test.runIf(process.platform === 'darwin')('Floway configured hardened runtime entitlements let its re-signed Node execute V8 code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'floway-hardened-node-'));
  try {
    const node = join(root, 'node');
    await copyFile(process.execPath, node);
    const config = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { bundle: { macOS: { entitlements: string } } };
    const entitlements = new URL(`../../src-tauri/${config.bundle.macOS.entitlements}`, import.meta.url).pathname;
    await execute('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, node]);
    const { stdout } = await execute(node, ['-e', 'let result=0; for(let i=0;i<100000;i++){result+=Math.sqrt(i)}; console.log(Number.isFinite(result))']);
    expect(stdout.trim()).toBe('true');
    const { stdout: plist } = await execute('codesign', ['--display', '--entitlements', '-', '--xml', node]);
    expect(plist).not.toContain('com.apple.security.get-task-allow');
    expect(plist).not.toContain('com.apple.security.cs.disable-library-validation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
