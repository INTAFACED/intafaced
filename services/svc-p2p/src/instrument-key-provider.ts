import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Local-test seal for payment-instrument details.
 *
 * AES-256-GCM, a fresh 12-byte nonce on every seal, and AAD that binds the
 * instrument id to the owner id. A blob moved onto another row does not open.
 * The sealed text always starts `local-test:v1:`. This is not owner KMS.
 */

export const LOCAL_TEST_SEAL_PREFIX = 'local-test:v1:' as const;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface InstrumentKeyProvider {
  readonly kind: 'local-test';
  readonly keyLabel: string;
  seal(plaintext: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

/** Boot refusal. A set local-test flag that fails a check names every reason. */
export class LocalTestKmsRefusedError extends Error {
  readonly code = 'p2p.local_test_kms_refused' as const;
  constructor(readonly reasons: string[]) {
    super(`p2p.local_test_kms_refused: ${reasons.join('; ')}`);
    this.name = 'LocalTestKmsRefusedError';
  }
}

/** Open/seal failed. The message is the code only: no plaintext, no blob. */
export class LocalTestSealError extends Error {
  readonly code = 'p2p.local_test_seal_failed' as const;
  constructor() {
    super('p2p.local_test_seal_failed');
    this.name = 'LocalTestSealError';
  }
}

/** AAD for one instrument row. Owner id and instrument id are both bound. */
export function instrumentDetailsAad(instrumentId: string, ownerId: string): string {
  return `v1\ninstrument:${instrumentId}\nowner:${ownerId}`;
}

export function isSealedInstrumentDetails(stored: unknown): stored is { readonly _sealed: string } {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 1 && keys[0] === '_sealed' && typeof record._sealed === 'string' && record._sealed.startsWith(LOCAL_TEST_SEAL_PREFIX)
  );
}

/**
 * Health fields. A local-test provider is not a configured KMS, so
 * `instrumentKmsConfigured` stays false.
 */
export function instrumentKeyHealth(kind: 'none' | 'local-test' | null | undefined): {
  instrumentKmsConfigured: false;
  instrumentKeyProvider: 'none' | 'local-test';
} {
  return {
    instrumentKmsConfigured: false,
    instrumentKeyProvider: kind === 'local-test' ? 'local-test' : 'none',
  };
}

export function createLocalTestInstrumentKeyProvider(key: Buffer, keyLabel: string): InstrumentKeyProvider {
  if (key.length !== KEY_BYTES) throw new LocalTestSealError();
  if (!/^TEST-[0-9a-f]{8}$/.test(keyLabel)) throw new LocalTestSealError();
  return {
    kind: 'local-test',
    keyLabel,
    seal(plaintext: string, aad: string): string {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return LOCAL_TEST_SEAL_PREFIX + Buffer.concat([nonce, body, tag]).toString('base64url');
    },
    open(sealed: string, aad: string): string {
      if (!sealed.startsWith(LOCAL_TEST_SEAL_PREFIX)) throw new LocalTestSealError();
      const packed = Buffer.from(sealed.slice(LOCAL_TEST_SEAL_PREFIX.length), 'base64url');
      if (packed.length < NONCE_BYTES + TAG_BYTES + 1) throw new LocalTestSealError();
      const nonce = packed.subarray(0, NONCE_BYTES);
      const tag = packed.subarray(packed.length - TAG_BYTES);
      const body = packed.subarray(NONCE_BYTES, packed.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw new LocalTestSealError();
      }
    },
  };
}

/** Plaintext JSON that was sealed. A bad blob throws with no partial text. */
export function parseOpenedInstrumentDetails(plain: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new LocalTestSealError();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LocalTestSealError();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new LocalTestSealError();
    out[key] = value;
  }
  return Object.freeze(out);
}
