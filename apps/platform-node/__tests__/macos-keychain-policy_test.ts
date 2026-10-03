import { expect, test } from 'vitest';

import { createOperatingSystemCredential } from '../src/device-master-key.ts';

test.skipIf(process.platform !== 'darwin')('Floway disables macOS password dialogs before every credential operation', async () => {
  const { default: koffi } = await import('koffi');
  const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
  const get = security.func('int32_t SecKeychainGetUserInteractionAllowed(_Out_ uint8_t *allowed)');
  const set = security.func('int32_t SecKeychainSetUserInteractionAllowed(uint8_t allowed)');
  const allowed = [0];
  expect(get(allowed)).toBe(0);
  const original = allowed[0];
  const observe = () => {
    expect(get(allowed)).toBe(0);
    expect(allowed[0], 'credential operations must not be allowed to request an OS password').toBe(0);
  };
  try {
    expect(set(1)).toBe(0);
    const credential = await createOperatingSystemCredential({ service: 'Floway policy test', account: 'no-secret' }, 'darwin', {
      Entry: class {
        constructor() { observe(); }
        getSecret() { observe(); return null; }
        setSecret() { observe(); }
        setPassword() { throw new Error('unexpected password operation'); }
        deleteCredential() { observe(); return false; }
      },
      findCredentials: () => [],
    });
    for (const operation of [
      () => credential.getSecret(),
      () => credential.setSecret(new Uint8Array(32)),
      () => credential.deleteSecret!(),
    ]) {
      // A different library may re-enable interaction after construction.
      expect(set(1)).toBe(0);
      await operation();
    }
  } finally {
    expect(set(original)).toBe(0);
  }
});

test.skipIf(process.platform !== 'darwin')('a locked disposable macOS keychain returns an error without waiting for a password', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { default: koffi } = await import('koffi');
  const { requireNoninteractiveMacOSKeychain } = await import('../src/macos-keychain-policy.ts');
  const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
  const core = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  // File-based APIs match the backend used by keyring-node. All calls target
  // this disposable keychain explicitly, never the user's login keychain.
  // https://github.com/apple-oss-distributions/Security/blob/main/keychain/headers/SecKeychain.h
  const create = security.func('int32_t SecKeychainCreate(str path, uint32_t length, void *password, uint8_t prompt, void *access, _Out_ void **keychain)');
  const add = security.func('int32_t SecKeychainAddGenericPassword(void *keychain, uint32_t serviceLength, str service, uint32_t accountLength, str account, uint32_t secretLength, void *secret, void *item)');
  const lock = security.func('int32_t SecKeychainLock(void *keychain)');
  const find = security.func('int32_t SecKeychainFindGenericPassword(void *keychain, uint32_t serviceLength, str service, uint32_t accountLength, str account, _Out_ uint32_t *length, _Out_ void **secret, void *item)');
  const getStatus = security.func('int32_t SecKeychainGetStatus(void *keychain, _Out_ uint32_t *status)');
  const free = security.func('int32_t SecKeychainItemFreeContent(void *attributes, void *data)');
  const remove = security.func('int32_t SecKeychainDelete(void *keychain)');
  const release = core.func('void CFRelease(void *object)');
  const getInteraction = security.func('int32_t SecKeychainGetUserInteractionAllowed(_Out_ uint8_t *allowed)');
  const setInteraction = security.func('int32_t SecKeychainSetUserInteractionAllowed(uint8_t allowed)');
  const interaction = [0];
  expect(getInteraction(interaction)).toBe(0);
  const original = interaction[0];
  const root = await mkdtemp(join(tmpdir(), 'floway-noninteractive-keychain-'));
  const keychain = [null];
  let created = false;
  try {
    const requirePolicy = await requireNoninteractiveMacOSKeychain();
    requirePolicy();
    expect(getInteraction(interaction)).toBe(0);
    expect(interaction[0]).toBe(0);
    const password = randomBytes(32).toString('hex');
    expect(create(join(root, 'fixture.keychain-db'), password.length, Buffer.from(password), 0, null, keychain)).toBe(0);
    created = true;
    expect(add(keychain[0], 6, 'Floway', 7, 'fixture', 32, randomBytes(32), null)).toBe(0);
    const length = [0];
    const secret = [null];
    expect(find(keychain[0], 6, 'Floway', 7, 'fixture', length, secret, null)).toBe(0);
    expect(length[0]).toBe(32);
    expect(secret[0]).not.toBeNull();
    expect(free(null, secret[0])).toBe(0);
    expect(lock(keychain[0])).toBe(0);
    const state = [0];
    expect(getStatus(keychain[0], state)).toBe(0);
    expect(state[0]! & 1).toBe(0); // kSecUnlockStateStatus; SecKeychain.h
    const started = performance.now();
    // Request secret bytes, not just metadata, to force the locked-store path.
    const status = find(keychain[0], 6, 'Floway', 7, 'fixture', [0], [null], null);
    // File-based Keychain versions report either the denied interaction or
    // authentication failure. Both codes are defined in Apple's SecBase.h.
    // https://github.com/apple-oss-distributions/Security/blob/main/base/SecBase.h
    expect([-25308, -25293]).toContain(status);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    if (created) expect(remove(keychain[0])).toBe(0);
    if (keychain[0] !== null) release(keychain[0]);
    await rm(root, { recursive: true, force: true });
    expect(setInteraction(original)).toBe(0);
  }
});
