import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { createDeviceMasterKeyCreationLock } from '../src/device-master-key-creation-lock.ts';
import { loadDeviceMasterKey } from '../src/device-master-key.ts';
import { createLocalDeviceMasterKeyCredential, localDeviceMasterKeyPath } from '../src/local-device-master-key.ts';
import { resolvePersonalRuntimePaths } from '../src/personal-runtime.ts';

vi.mock('@napi-rs/keyring', () => { throw new Error('Floway must start without a system credential store'); });
vi.mock('koffi', () => { throw new Error('Floway must start without native Keychain interaction'); });

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'floway-local-key-'));
  roots.push(root);
  const paths = resolvePersonalRuntimePaths({ dataDir: root, stableUserHome: root });
  return {
    paths, credential: createLocalDeviceMasterKeyCredential(paths),
    lock: createDeviceMasterKeyCreationLock({ lockDatabasePath: join(root, 'key.lock.db') }),
  };
};

test('Floway persists and reloads its local master key without loading Keychain bindings', async () => {
  const { paths, credential, lock } = fixture();
  const key = await loadDeviceMasterKey(lock, true, credential);
  expect(key.length).toBe(32);
  const restarted = createLocalDeviceMasterKeyCredential(paths);
  expect(await loadDeviceMasterKey(lock, false, restarted)).toEqual(key);
  expect(readFileSync(localDeviceMasterKeyPath(paths))).toEqual(Buffer.from(key));
  if (process.platform !== 'win32') {
    expect(statSync(localDeviceMasterKeyPath(paths)).mode & 0o777).toBe(0o600);
    expect(statSync(join(paths.dataDir, 'credentials')).mode & 0o777).toBe(0o700);
  }
});

test('Floway never creates a replacement key for an existing encrypted database', async () => {
  const { credential, lock } = fixture();
  await expect(loadDeviceMasterKey(lock, false, credential)).rejects.toThrow('missing');
  expect(await credential.getSecret()).toBeNull();
});

test('Floway concurrent startup converges on one persisted local key', async () => {
  const { paths, lock } = fixture();
  const keys = await Promise.all(Array.from({ length: 8 }, () =>
    loadDeviceMasterKey(lock, true, createLocalDeviceMasterKeyCredential(paths))));
  for (const key of keys) expect(key).toEqual(keys[0]);
});

test('Floway rejects a malformed local key without replacing its bytes', async () => {
  const { paths, credential, lock } = fixture();
  writeFileSync(localDeviceMasterKeyPath(paths), 'invalid');
  await expect(loadDeviceMasterKey(lock, true, credential)).rejects.toThrow('read');
  expect(readFileSync(localDeviceMasterKeyPath(paths), 'utf8')).toBe('invalid');
});

test.skipIf(process.platform === 'win32')('Floway refuses a symlink to a key outside its private directory', async () => {
  const { paths, credential, lock } = fixture();
  const external = join(paths.dataDir, 'external');
  writeFileSync(external, Buffer.alloc(32, 9));
  symlinkSync(external, localDeviceMasterKeyPath(paths));
  await expect(loadDeviceMasterKey(lock, true, credential)).rejects.toThrow('read');
  expect(readFileSync(external)).toEqual(Buffer.alloc(32, 9));
});

test('Floway cannot overwrite an existing local master key', async () => {
  const { credential, lock } = fixture();
  const key = await loadDeviceMasterKey(lock, true, credential);
  await expect(Promise.resolve().then(() => credential.setSecret(Buffer.alloc(32, 2)))).rejects.toThrow();
  expect(await credential.getSecret()).toEqual(key);
});
