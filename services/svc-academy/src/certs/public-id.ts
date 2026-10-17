/**
 * 128-bit public certificate id from the platform CSPRNG.
 *
 * `node:crypto` `randomBytes` is OpenSSL's CSPRNG. The id is not derived
 * from the account id or from `cert:<account>:<certificate>`.
 */

import { randomBytes } from 'node:crypto';

export const PUBLIC_ID_BYTES = 16;

export function randomPublicId(bytes: (size: number) => Buffer = randomBytes): string {
  return bytes(PUBLIC_ID_BYTES).toString('hex');
}

/** 32 lowercase hex characters. Anything else is malformed and must look unknown. */
export function isPublicId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
