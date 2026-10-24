import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A secret for one share link. Not an idempotency key and never stored. */
export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ABSENT = Buffer.from(shareTokenHash('quant.share.absent'), 'hex');

/** Compares two sha256 hex digests. A missing stored hash still compares, against a fixed stand-in. */
export function shareHashEquals(storedHex: string | null, presentedHex: string): boolean {
  const presented = Buffer.from(presentedHex, 'hex');
  const stored = storedHex === null ? ABSENT : Buffer.from(storedHex, 'hex');
  const sameLength = stored.length === presented.length;
  const left = sameLength ? stored : Buffer.alloc(presented.length);
  const equal = timingSafeEqual(left, presented);
  return storedHex !== null && sameLength && equal;
}
