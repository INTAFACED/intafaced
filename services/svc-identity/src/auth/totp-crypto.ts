import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * TOTP secret encrypt-at-rest (W6 residual A2).
 *
 * Same envelope family as KYC document-crypto: AES-256-GCM, 12-byte nonce,
 * 16-byte auth tag. Column stays `users.totp_secret` text; ciphertext is
 * packed as `enc:v1:` + base64(nonce || ciphertext || tag).
 *
 * Dual-read: unprefixed values are treated as legacy plaintext for one release
 * so existing enrolments keep working. New enrol always writes encrypted.
 *
 * Key: IDENTITY_TOTP_SECRET_KEY — 32-byte AES key as base64 or 64-char hex.
 * Missing/invalid → null; enrol refuses (no improvised key). Prod boot refuses.
 */

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Versioned ciphertext prefix stored in users.totp_secret. */
export const TOTP_SECRET_ENC_PREFIX = 'enc:v1:';

/**
 * Decode a 32-byte AES key from env (base64 or 64-char hex).
 * Missing/invalid → null (enrol refuses; no improvised key).
 */
export function parseTotpSecretKey(raw: string | undefined | null): Buffer | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      const buf = Buffer.from(trimmed, 'hex');
      return buf.length === 32 ? buf : null;
    }
    const buf = Buffer.from(trimmed, 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/** Thrown when APP_ENV=prod and IDENTITY_TOTP_SECRET_KEY is missing/invalid. */
export const PROD_TOTP_KEY_REQUIRED = 'IDENTITY_TOTP_SECRET_KEY is required in prod (32-byte AES key as base64 or 64-char hex)';

/**
 * Prod boot: TOTP secrets must not sit base32-plaintext. Missing/invalid key
 * refuses. Non-prod (dev/test/staging) may boot without the key — enrol still
 * refuses. Does not tighten staging.
 */
export function assertProdTotpKey(env: { APP_ENV?: string; IDENTITY_TOTP_SECRET_KEY?: string | null }): void {
  if (env.APP_ENV !== 'prod') return;
  if (!parseTotpSecretKey(env.IDENTITY_TOTP_SECRET_KEY)) {
    throw new Error(PROD_TOTP_KEY_REQUIRED);
  }
}

export function isEncryptedTotpSecret(stored: string): boolean {
  return stored.startsWith(TOTP_SECRET_ENC_PREFIX);
}

/**
 * Seal a base32 TOTP secret for the totp_secret column.
 * Returns `enc:v1:` + base64(nonce || ciphertext || tag).
 */
export function encryptTotpSecret(key: Buffer, plaintextBase32: string): string {
  if (key.length !== 32) throw new Error('TOTP secret key must be 32 bytes');
  if (!plaintextBase32) throw new Error('TOTP secret plaintext empty');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintextBase32, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([nonce, encrypted, tag]);
  return `${TOTP_SECRET_ENC_PREFIX}${packed.toString('base64')}`;
}

/**
 * Open an `enc:v1:` column value back to the base32 secret.
 * Throws on wrong key, truncated payload, or garbage ciphertext.
 */
export function decryptTotpSecret(key: Buffer, sealed: string): string {
  if (key.length !== 32) throw new Error('TOTP secret key must be 32 bytes');
  if (!isEncryptedTotpSecret(sealed)) {
    throw new Error('TOTP secret is not enc:v1 ciphertext');
  }
  const b64 = sealed.slice(TOTP_SECRET_ENC_PREFIX.length);
  let packed: Buffer;
  try {
    packed = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('TOTP secret ciphertext is not valid base64');
  }
  // nonce(12) + at least 1 byte ciphertext + tag(16)
  if (packed.length < NONCE_LEN + 1 + TAG_LEN) {
    throw new Error('TOTP secret ciphertext too short');
  }
  const nonce = packed.subarray(0, NONCE_LEN);
  const tag = packed.subarray(packed.length - TAG_LEN);
  const data = packed.subarray(NONCE_LEN, packed.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Dual-read helper for login / step-up.
 * - `enc:v1:…` → decrypt (requires key)
 * - anything else → legacy plaintext base32 (one-release compatibility)
 *
 * Does not invent a key when material is missing.
 */
export function materializeTotpSecret(key: Buffer | null, stored: string): string {
  if (!isEncryptedTotpSecret(stored)) return stored;
  if (!key) {
    throw new Error('IDENTITY_TOTP_SECRET_KEY is required to read encrypted TOTP secrets');
  }
  return decryptTotpSecret(key, stored);
}

/**
 * Same enc:v1 AES-256-GCM envelope as TOTP, for api_keys.request_signing_secret.
 * Own key: API_KEY_SIGNING_ENC_KEY. Missing key refuses the write. Prod and
 * staging refuse to boot without it. Plaintext is never written and never logged.
 */
export function encryptAtRest(key: Buffer, plaintext: string): string {
  if (key.length !== 32) throw new Error('at-rest key must be 32 bytes');
  if (!plaintext) throw new Error('at-rest plaintext empty');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOTP_SECRET_ENC_PREFIX}${Buffer.concat([nonce, encrypted, tag]).toString('base64')}`;
}

export function decryptAtRest(key: Buffer, sealed: string): string {
  if (key.length !== 32) throw new Error('at-rest key must be 32 bytes');
  if (!sealed.startsWith(TOTP_SECRET_ENC_PREFIX)) throw new Error('at-rest value is not enc:v1 ciphertext');
  const packed = Buffer.from(sealed.slice(TOTP_SECRET_ENC_PREFIX.length), 'base64');
  if (packed.length < NONCE_LEN + 1 + TAG_LEN) throw new Error('at-rest ciphertext too short');
  const nonce = packed.subarray(0, NONCE_LEN);
  const tag = packed.subarray(packed.length - TAG_LEN);
  const data = packed.subarray(NONCE_LEN, packed.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const SIGNING_ENC_KEY_REQUIRED =
  'API_KEY_SIGNING_ENC_KEY is required in prod and staging (32-byte AES key as base64 or 64-char hex)';

/** Prod and staging boot: a signing secret must not sit plaintext. Dev and test may boot without the key; opt-in still refuses. */
export function assertSigningEncKey(env: { APP_ENV?: string; API_KEY_SIGNING_ENC_KEY?: string | null }): void {
  if (env.APP_ENV !== 'prod' && env.APP_ENV !== 'staging') return;
  if (!parseTotpSecretKey(env.API_KEY_SIGNING_ENC_KEY)) {
    throw new Error(SIGNING_ENC_KEY_REQUIRED);
  }
}
