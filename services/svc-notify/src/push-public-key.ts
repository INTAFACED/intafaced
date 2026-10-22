/**
 * Push gateway PUBLIC application key (HM-notifications-02). Published on the
 * signed-out channels policy read, so a mis-set value must stop the boot: an
 * uncompressed P-256 public key is unpadded base64url that decodes to exactly
 * 65 bytes starting 0x04. A VAPID private key (32 bytes, 43 characters), a
 * compressed key, a padded or `+/` value, a token or PEM text all refuse.
 */

export const PUSH_PUBLIC_KEY_INVALID = 'notify.push_public_key_invalid' as const;

export class PushPublicKeyError extends Error {
  readonly code = PUSH_PUBLIC_KEY_INVALID;
  constructor() {
    super(PUSH_PUBLIC_KEY_INVALID);
    this.name = 'PushPublicKeyError';
  }
}

const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/;
/** 65 bytes in unpadded base64url is 87 characters. */
const P256_UNCOMPRESSED_CHARS = 87;
const P256_UNCOMPRESSED_BYTES = 65;

/** True only for an unpadded base64url uncompressed P-256 public key. */
export function isPushPublicKey(value: string): boolean {
  if (value.length !== P256_UNCOMPRESSED_CHARS || !BASE64URL_UNPADDED.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === P256_UNCOMPRESSED_BYTES && bytes[0] === 0x04 && bytes.toString('base64url') === value;
}

/** Returns the key, or throws the typed refusal. Blank is handled by the caller as "not configured". */
export function parsePushPublicKey(value: string): string {
  if (!isPushPublicKey(value)) throw new PushPublicKeyError();
  return value;
}
