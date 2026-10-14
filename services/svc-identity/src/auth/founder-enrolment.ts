import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * FOUNDER ENROLMENT INVITES.
 *
 * `auth.registerFounder` lets the two founders create their own accounts while
 * public registration stays closed. The door is a single-use invite code:
 *
 *   · The OPERATOR generates two codes locally (`pnpm … founder:invites`) and
 *     configures only their SHA-256 hashes (`IDENTITY_FOUNDER_INVITE_HASHES`) and
 *     an expiry (`IDENTITY_FOUNDER_INVITE_EXPIRES_AT`). The codes never reach the
 *     server's configuration, so a leaked environment cannot enrol anyone.
 *   · A code is 160 bits of CSPRNG output as 32 base32 characters, shown in
 *     groups of four. 160 bits cannot be guessed online, which is what makes it
 *     acceptable for the distinct `invite_invalid` / `invite_used` /
 *     `invite_expired` answers.
 *   · The hash is over the CANONICAL form: upper case, letters A-Z and digits
 *     2-7, no spaces or dashes. Anyone can check one by hand:
 *     `printf %s ABCD…32-chars | shasum -a 256`.
 *
 * This file is pure (no database, no environment) so the generator script and
 * the env schema can import it without booting the service.
 */

export const INVITE_BYTES = 20;
export const INVITE_CANONICAL_LENGTH = 32;
export const INVITE_GROUP_SIZE = 4;
/** Hours between generating the codes and their expiry. */
export const INVITE_TTL_HOURS = 72;
/** How many invites exist: one per founder. */
export const FOUNDER_INVITE_COUNT = 2;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CANONICAL = new RegExp(`^[A-Z2-7]{${INVITE_CANONICAL_LENGTH}}$`);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface FounderEnrolmentConfig {
  /** Lowercase SHA-256 hex of each valid canonical invite. Exactly two, distinct. */
  readonly hashes: readonly string[];
  /** Instant after which no invite is accepted. */
  readonly expiresAt: Date;
}

/** RFC 4648 base32 (no padding) of `bytes`. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Upper-case, strip spaces and dashes. Typing-friendly; the hash is over this form. */
export function canonicalInvite(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function isCanonicalInvite(canonical: string): boolean {
  return CANONICAL.test(canonical);
}

/** `ABCD-EFGH-…` for typing. */
export function groupInvite(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += INVITE_GROUP_SIZE) groups.push(canonical.slice(i, i + INVITE_GROUP_SIZE));
  return groups.join('-');
}

export function hashInvite(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The configured hash this code matches, or null. Every configured hash is
 * compared in constant time with no early exit, so response time does not
 * reveal how much of a guess was right or which slot it hit.
 */
export function matchInvite(code: string, hashes: readonly string[]): string | null {
  const canonical = canonicalInvite(code);
  // A malformed code is not worth a database round trip, and it cannot match: say so.
  if (!isCanonicalInvite(canonical)) return null;
  const candidate = Buffer.from(hashInvite(canonical), 'hex');
  let matched: string | null = null;
  for (const hash of hashes) {
    const equal = timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
    matched = equal ? hash : matched;
  }
  return matched;
}

/**
 * Parse IDENTITY_FOUNDER_INVITE_HASHES. Blank / unset → undefined (enrolment
 * closed, never an invented default). Anything else must be exactly two
 * different lowercase SHA-256 hex values or this throws, so a typo fails boot
 * instead of silently closing (or worse, half-opening) the door.
 */
export function parseInviteHashes(raw: string | undefined | null): readonly string[] | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length !== FOUNDER_INVITE_COUNT || !parts.every((p) => SHA256_HEX.test(p)) || new Set(parts).size !== parts.length) {
    throw new Error(
      `IDENTITY_FOUNDER_INVITE_HASHES must be exactly ${FOUNDER_INVITE_COUNT} different lowercase sha256 hex values, comma-separated`,
    );
  }
  return parts;
}

/** Parse IDENTITY_FOUNDER_INVITE_EXPIRES_AT (ISO 8601 with a zone). Blank / unset → undefined; malformed throws. */
export function parseInviteExpiry(raw: string | undefined | null): Date | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const text = raw.trim();
  const at = new Date(text);
  if (!ISO_8601.test(text) || Number.isNaN(at.getTime())) {
    throw new Error('IDENTITY_FOUNDER_INVITE_EXPIRES_AT must be an ISO 8601 timestamp with a zone, e.g. 2026-10-17T08:00:00Z');
  }
  return at;
}

/** Both values or nothing. One without the other is a closed door, not a guess. */
export function founderEnrolmentConfig(
  hashes: string | undefined | null,
  expiresAt: string | undefined | null,
): FounderEnrolmentConfig | undefined {
  const h = parseInviteHashes(hashes);
  const e = parseInviteExpiry(expiresAt);
  return h && e ? { hashes: h, expiresAt: e } : undefined;
}

export interface GeneratedFounderInvites {
  /** The codes, grouped for typing. Shown once, to the operator only. */
  readonly codes: readonly string[];
  readonly hashes: readonly string[];
  readonly expiresAt: string;
  /** The two environment lines to configure. Hashes and expiry only; never the codes. */
  readonly envLines: readonly string[];
}

/** Generate the founder invites. Local only: CSPRNG in, strings out. No network, no disk. */
export function generateFounderInvites(now: Date = new Date()): GeneratedFounderInvites {
  const canonicals = Array.from({ length: FOUNDER_INVITE_COUNT }, () => base32(randomBytes(INVITE_BYTES)));
  const hashes = canonicals.map(hashInvite);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_HOURS * 3_600_000).toISOString();
  return {
    codes: canonicals.map(groupInvite),
    hashes,
    expiresAt,
    envLines: [`IDENTITY_FOUNDER_INVITE_HASHES=${hashes.join(',')}`, `IDENTITY_FOUNDER_INVITE_EXPIRES_AT=${expiresAt}`],
  };
}
