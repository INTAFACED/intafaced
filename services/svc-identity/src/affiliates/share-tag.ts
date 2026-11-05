/**
 * Signed share tags (RC-campaigns-06, J-campaigns-05 #2).
 *
 * A tag is `<token>.<surface>.<signature>`: the referrer's live share token, the surface the link was shared from, and an
 * HMAC-SHA256 of the first two under the service's own key (`IDENTITY_SHARE_TAG_KEY`). The surface travels inside the
 * signature, so nobody can move visits from one surface to another by editing the link. The signature is compared in
 * constant time and the key is never shown. A blank key refuses making a tag (`share.key_unset`) and refuses reading one,
 * since an unsigned tag proves nothing.
 *
 * The public door that counts a tag's visit is limited per IP by an owner value (`IDENTITY_SHARE_TAG_HITS_PER_IP_MINUTE`);
 * a blank one keeps that door shut (`share.rate_unset`). The window is process-local: a per-instance bound, not a quota.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Where a link can be shared from. A closed list, so a count always names a real place. */
export const SHARE_SURFACES = ['promotion', 'card', 'token', 'strategy', 'receipt'] as const;
export type ShareSurface = (typeof SHARE_SURFACES)[number];

/** A browser session's own random key: one visit per session per surface. */
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_MIN_LENGTH = 32;
const RATE_MAX = 100_000;

export function isShareSurface(value: string): value is ShareSurface {
  return (SHARE_SURFACES as readonly string[]).includes(value);
}

/** The signing key, parsed at start. Blank stays undefined (tags refuse by name); one shorter than 32 stops the service. */
export function parseShareTagKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.length < KEY_MIN_LENGTH) throw new Error(`IDENTITY_SHARE_TAG_KEY must be at least ${KEY_MIN_LENGTH} characters`);
  return value;
}

/** The owner's per-IP visit limit for the public tag door, per minute. Blank stays undefined; malformed stops the service. */
export function parseShareTagHitsPerIpMinute(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > RATE_MAX) {
    throw new Error(`IDENTITY_SHARE_TAG_HITS_PER_IP_MINUTE must be a whole number from 1 to ${RATE_MAX}`);
  }
  return Number(value);
}

function signature(key: string, token: string, surface: ShareSurface): string {
  return createHmac('sha256', key).update(`share-tag:v1:${token}.${surface}`).digest('base64url');
}

export function signShareTag(key: string, token: string, surface: ShareSurface): string {
  return `${token}.${surface}.${signature(key, token, surface)}`;
}

/**
 * The token and surface of a well-formed tag whose signature holds under `key`, or null for anything else: a wrong shape,
 * an unknown surface, an edited token or surface, or another key's signature. Callers refuse null as `share.tag_invalid`.
 */
export function verifyShareTag(key: string, tag: string): { token: string; surface: ShareSurface } | null {
  const parts = tag.split('.');
  if (parts.length !== 3) return null;
  const [token, surface, given] = parts as [string, string, string];
  if (!TOKEN_PATTERN.test(token) || !isShareSurface(surface) || !SIGNATURE_PATTERN.test(given)) return null;
  const expected = Buffer.from(signature(key, token, surface), 'base64url');
  const presented = Buffer.from(given, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return { token, surface };
}

/** Most distinct addresses one window tracks; a new address past it is refused until the next minute. */
export const WINDOW_MAX_ADDRESSES = 50_000;

/**
 * A fixed one-minute window per IP. `take` answers whether this visit is inside the owner's limit. The whole map is
 * dropped when the minute turns, and it never holds more than WINDOW_MAX_ADDRESSES, so a flood of addresses costs
 * bounded memory and constant time per visit.
 */
export class IpMinuteWindow {
  private minute = Number.NaN;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(ip: string): boolean {
    const minute = Math.floor(this.now() / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.counts.clear();
    }
    const seen = this.counts.get(ip);
    if (seen === undefined && this.counts.size >= WINDOW_MAX_ADDRESSES) return false;
    const count = (seen ?? 0) + 1;
    this.counts.set(ip, count);
    return count <= this.limit;
  }
}
