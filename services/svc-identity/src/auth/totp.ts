import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_STEP_SECONDS } from '@intafaced/contracts/identity';

/**
 * TOTP — RFC 6238, implemented directly.
 *
 * Written rather than pulled in because it is ~60 lines of well-specified
 * arithmetic, and because implementing it lets the test suite run the RFC's own
 * published test vectors. A dependency here would be a dependency in the
 * authentication path that we could not verify against the spec.
 *
 * §9: TOTP + WebAuthn are both required. This is the TOTP half.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  /** Seconds per code. RFC default and universal in authenticator apps. */
  step?: number;
  digits?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

// The step is the contract's, so the customer's clock check measures against the codes this service issues.
const DEFAULTS: Required<TotpOptions> = { step: TOTP_STEP_SECONDS, digits: 6, algorithm: 'sha1' };

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character "${char}" in TOTP secret`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/** HOTP (RFC 4226) — the counter-based primitive TOTP is built on. */
export function hotp(secret: Buffer, counter: bigint, options: TotpOptions = {}): string {
  const { digits, algorithm } = { ...DEFAULTS, ...options };

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm, secret).update(counterBuffer).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretBase32: string, options: TotpOptions & { at?: Date } = {}): string {
  const { step } = { ...DEFAULTS, ...options };
  const seconds = Math.floor((options.at?.getTime() ?? Date.now()) / 1000);
  return hotp(base32Decode(secretBase32), BigInt(Math.floor(seconds / step)), options);
}

/**
 * Match a submitted code to the TOTP counter that produced it.
 *
 * `window` accepts codes from adjacent steps to tolerate clock skew. One step
 * either side (±30s) is the standard compromise: it covers realistic device
 * drift without widening the guessing window more than necessary.
 *
 * Comparison is constant-time. A timing side channel on a 6-digit code is not
 * theoretical — it reduces the search space one digit at a time.
 *
 * Returns the matching counter (not a boolean) so callers can refuse a step that
 * was already consumed — a captured code must not replay inside the validity
 * window (login + step-up; README historically named this a known gap).
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  options: TotpOptions & { at?: Date; window?: number } = {},
): bigint | null {
  const { step } = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;

  const submitted = code.replace(/\s/g, '');
  if (!/^\d+$/.test(submitted)) return null;

  const secret = base32Decode(secretBase32);
  const seconds = Math.floor((options.at?.getTime() ?? Date.now()) / 1000);
  const counter = BigInt(Math.floor(seconds / step));

  for (let drift = -window; drift <= window; drift++) {
    const candidateStep = counter + BigInt(drift);
    const candidate = hotp(secret, candidateStep, options);
    if (candidate.length === submitted.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(submitted))) {
      return candidateStep;
    }
  }

  return null;
}

/** Verify a submitted code (boolean wrapper over {@link matchTotpStep}). */
export function verifyTotp(secretBase32: string, code: string, options: TotpOptions & { at?: Date; window?: number } = {}): boolean {
  return matchTotpStep(secretBase32, code, options) !== null;
}

/** otpauth:// URI for an authenticator app QR code. */
export function totpUri(secretBase32: string, account: string, issuer = 'INTAFACED'): string {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString()}`;
}

/**
 * Single-use recovery codes, issued at enrolment.
 *
 * Stored hashed, exactly like passwords — a recovery code IS a credential, and
 * a leaked database of plaintext recovery codes bypasses 2FA entirely.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
