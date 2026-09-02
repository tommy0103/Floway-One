const AES_256_KEY_BYTES = 32;
// A 96-bit IV is the interoperable GCM default and lets Web Crypto use the
// construction specified in NIST SP 800-38D without IV preprocessing.
// https://csrc.nist.gov/pubs/sp/800/38/d/final
const AES_GCM_NONCE_BYTES = 12;
const STORED_SECRET_VERSION = 1;
const STORED_SECRET_ALGORITHM = 'AES-256-GCM';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface StoredSecretCodec {
  seal(plaintext: string, context: string): Promise<string>;
  open(stored: string, context: string): Promise<string>;
}

export const plaintextStoredSecretCodec: StoredSecretCodec = Object.freeze({
  seal: (plaintext: string) => Promise.resolve(plaintext),
  open: (stored: string) => Promise.resolve(stored),
});

interface StoredSecretEnvelope {
  $flowayEncrypted: {
    version: number;
    algorithm: string;
    nonce: string;
    ciphertext: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const decodeBase64Url = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return encodeBase64Url(bytes) === value ? bytes : null;
};

const invalidEnvelope = (context: string, cause?: unknown): Error => cause === undefined
  ? new Error(`Invalid encrypted stored secret format for ${context}`)
  : new Error(`Invalid encrypted stored secret format for ${context}`, { cause });

const parseEnvelope = (stored: string, context: string): StoredSecretEnvelope['$flowayEncrypted'] => {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch (cause) {
    throw invalidEnvelope(context, cause);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.$flowayEncrypted)) {
    throw invalidEnvelope(context);
  }
  const envelope = value.$flowayEncrypted;
  const keys = Object.keys(envelope).toSorted();
  if (keys.join(',') !== 'algorithm,ciphertext,nonce,version') throw invalidEnvelope(context);
  if (envelope.version !== STORED_SECRET_VERSION) {
    throw new Error(`Unsupported encrypted stored secret version ${String(envelope.version)} for ${context}`);
  }
  if (envelope.algorithm !== STORED_SECRET_ALGORITHM) {
    throw new Error(`Unsupported encrypted stored secret algorithm for ${context}`);
  }
  if (typeof envelope.nonce !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw invalidEnvelope(context);
  }
  return envelope as unknown as StoredSecretEnvelope['$flowayEncrypted'];
};

export const createAes256GcmStoredSecretCodec = (masterKey: Uint8Array | null): StoredSecretCodec => {
  const keyBytes = masterKey === null ? null : new Uint8Array(masterKey);
  if (keyBytes !== null && keyBytes.byteLength !== AES_256_KEY_BYTES) {
    throw new Error(`Device master key must contain exactly ${AES_256_KEY_BYTES} bytes`);
  }

  let importedKey: Promise<CryptoKey> | null = null;
  const requireKey = (): Promise<CryptoKey> => {
    if (keyBytes === null) throw new Error('Device master key is unavailable');
    importedKey ??= crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return importedKey;
  };

  return Object.freeze({
    async seal(plaintext: string, context: string): Promise<string> {
      const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(context) },
        await requireKey(),
        encoder.encode(plaintext),
      );
      const envelope: StoredSecretEnvelope = {
        $flowayEncrypted: {
          version: STORED_SECRET_VERSION,
          algorithm: STORED_SECRET_ALGORITHM,
          nonce: encodeBase64Url(nonce),
          ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        },
      };
      return JSON.stringify(envelope);
    },

    async open(stored: string, context: string): Promise<string> {
      const envelope = parseEnvelope(stored, context);
      let nonce: Uint8Array | null;
      let ciphertext: Uint8Array | null;
      try {
        nonce = decodeBase64Url(envelope.nonce);
        ciphertext = decodeBase64Url(envelope.ciphertext);
      } catch (cause) {
        throw invalidEnvelope(context, cause);
      }
      if (nonce?.byteLength !== AES_GCM_NONCE_BYTES || ciphertext === null) {
        throw invalidEnvelope(context);
      }
      const key = await requireKey();
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: encoder.encode(context) },
          key,
          new Uint8Array(ciphertext),
        );
        return decoder.decode(plaintext);
      } catch (cause) {
        throw new Error(`Failed to decrypt stored secret for ${context}`, { cause });
      }
    },
  });
};
