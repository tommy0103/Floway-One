let disableInteraction: Promise<(allowed: number) => number> | undefined;

// keyring-node uses the traditional file-based Keychain. The interaction flag
// belongs to the caller process, so setting it in Tauri cannot protect Node.
// https://github.com/Brooooooklyn/keyring-node/blob/v2.0.0/src/entry.rs
// https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed(_:)
export const requireNoninteractiveMacOSKeychain = async (): Promise<() => void> => {
  disableInteraction ??= import('koffi').then(({ default: koffi }) => {
    const security = koffi.load('/System/Library/Frameworks/Security.framework/Security');
    // OSStatus is signed 32-bit; Apple's Boolean is an unsigned byte.
    // https://github.com/apple-oss-distributions/Security/blob/main/keychain/headers/SecKeychain.h
    return security.func('int32_t SecKeychainSetUserInteractionAllowed(uint8_t allowed)') as (allowed: number) => number;
  });
  const setInteraction = await disableInteraction;
  const requirePolicy = () => {
    const status = setInteraction(0);
    if (status !== 0) {
      throw Object.assign(new Error(`Floway could not disable macOS Keychain interaction (OSStatus ${status})`), {
        code: status,
      });
    }
  };
  requirePolicy();
  return requirePolicy;
};
