import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Sealed successor refresh token, kept only so a second tab inside the grace
 * window can be handed the token the first tab already rotated to.
 * Keyed from the access-token secret this process already holds. A wrong key
 * fails closed (the presenter is treated as reuse).
 */
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

function graceKey(secret: string): Buffer {
  return createHash('sha256').update(`ifc-refresh-grace\0${secret}`).digest();
}

export function sealRefreshToken(secret: string, token: string): string {
  const key = graceKey(secret);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([nonce, encrypted, tag]).toString('base64url')}`;
}

export function openRefreshToken(secret: string, sealed: string): string | null {
  try {
    if (!sealed.startsWith(PREFIX)) return null;
    const packed = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
    if (packed.length < NONCE_LEN + 1 + TAG_LEN) return null;
    const nonce = packed.subarray(0, NONCE_LEN);
    const tag = packed.subarray(packed.length - TAG_LEN);
    const data = packed.subarray(NONCE_LEN, packed.length - TAG_LEN);
    const decipher = createDecipheriv(ALGO, graceKey(secret), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
