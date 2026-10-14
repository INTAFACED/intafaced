/**
 * Refresh policy: how long a refresh may keep carrying the `mfa` claim, and how long
 * a just-retired refresh token is answered with its successor instead of treated as theft.
 *
 * THE TWO HOLES THIS CLOSES (security review of the stay-signed-in PRs #4733 / #4759).
 *
 *   1. `auth.refresh` copied `mfa` onto every new access token and slid the session
 *      30 days on every rotation. One second-factor check then lasted as long as the
 *      person kept the tab open, and reached founder controls, action approvals and
 *      factor changes. The session now records `auth_time` (when the password and
 *      second factor were last really verified); refresh carries it forward unchanged
 *      and drops `mfa` once `now - auth_time` exceeds the max age below. Founders and
 *      anyone holding an `admin:*` scope get a shorter one.
 *
 *   2. If a refresh response was lost after identity rotated, the browser kept the
 *      retired token and its next refresh looked exactly like theft: every session of
 *      the person was revoked, mobile included. A retired token presented within the
 *      grace window, once, in the same session family, is answered with the SAME
 *      successor pair. Anything else keeps revoke-all.
 *
 * NO NUMBER IS INVENTED HERE. The three values come from the environment and a blank
 * or malformed one refuses boot (`resolveRefreshPolicy`). A service built without a
 * policy fails closed: refresh drops `mfa` and grants no grace.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface RefreshPolicy {
  /** A refresh keeps `mfa` only while `now - auth_time` is at most this many seconds. */
  readonly mfaMaxAgeSeconds: number;
  /** Same, for founders and `admin:*` principals. Never longer than `mfaMaxAgeSeconds`. */
  readonly privilegedMfaMaxAgeSeconds: number;
  /** A retired token is answered with its successor for this many seconds. 0 turns the grace off. */
  readonly graceSeconds: number;
  /** The founder pair (see `factorActor`); `admin:*` scopes are recognised separately. */
  readonly privilegedUserIds: readonly string[];
}

export class RefreshPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshPolicyError';
  }
}

export interface RefreshPolicyEnv {
  readonly IDENTITY_MFA_MAX_AGE_SECONDS?: number | undefined;
  readonly IDENTITY_PRIVILEGED_MFA_MAX_AGE_SECONDS?: number | undefined;
  readonly IDENTITY_REFRESH_GRACE_SECONDS?: number | undefined;
}

/** Sanity bounds on an owner-published value; they are not defaults. */
export const MFA_MAX_AGE_BOUNDS = { min: 60, max: 30 * 24 * 60 * 60 } as const;
export const REFRESH_GRACE_BOUNDS = { min: 0, max: 300 } as const;

function required(name: string, value: number | undefined, bounds: { min: number; max: number }): number {
  if (value === undefined) {
    throw new RefreshPolicyError(`${name} is unset — owner must publish it (seconds, ${bounds.min} to ${bounds.max}); svc-identity will not boot without it`);
  }
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new RefreshPolicyError(`${name} must be a whole number of seconds from ${bounds.min} to ${bounds.max}, got ${value}`);
  }
  return value;
}

/** Read the three owner-published values. Throws (so boot fails) on a blank, malformed or contradictory one. */
export function resolveRefreshPolicy(env: RefreshPolicyEnv, privilegedUserIds: readonly string[]): RefreshPolicy {
  const mfaMaxAgeSeconds = required('IDENTITY_MFA_MAX_AGE_SECONDS', env.IDENTITY_MFA_MAX_AGE_SECONDS, MFA_MAX_AGE_BOUNDS);
  const privilegedMfaMaxAgeSeconds = required(
    'IDENTITY_PRIVILEGED_MFA_MAX_AGE_SECONDS',
    env.IDENTITY_PRIVILEGED_MFA_MAX_AGE_SECONDS,
    MFA_MAX_AGE_BOUNDS,
  );
  if (privilegedMfaMaxAgeSeconds > mfaMaxAgeSeconds) {
    throw new RefreshPolicyError(
      `IDENTITY_PRIVILEGED_MFA_MAX_AGE_SECONDS (${privilegedMfaMaxAgeSeconds}) must not exceed IDENTITY_MFA_MAX_AGE_SECONDS (${mfaMaxAgeSeconds}): founders and admins are held to the shorter age`,
    );
  }
  const graceSeconds = required('IDENTITY_REFRESH_GRACE_SECONDS', env.IDENTITY_REFRESH_GRACE_SECONDS, REFRESH_GRACE_BOUNDS);
  return { mfaMaxAgeSeconds, privilegedMfaMaxAgeSeconds, graceSeconds, privilegedUserIds };
}

/**
 * Does a refresh still carry `mfa`? Fails closed: no policy, no `mfa` on the session, or
 * an `auth_time` in the future (clock damage) all answer no.
 */
export function mfaSurvivesRefresh(
  policy: RefreshPolicy | undefined,
  input: { mfa: boolean; authTime: Date; privileged: boolean; now?: Date },
): boolean {
  if (!policy || !input.mfa) return false;
  const now = (input.now ?? new Date()).getTime();
  const ageMs = now - input.authTime.getTime();
  if (ageMs < 0) return false;
  const maxSeconds = input.privileged ? policy.privilegedMfaMaxAgeSeconds : policy.mfaMaxAgeSeconds;
  return ageMs <= maxSeconds * 1000;
}

// ── Sealed successor ─────────────────────────────────────────────────────────

/** What a lost refresh response needs to be answered again. */
export interface GracePayload {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO 8601 */
  readonly expiresAt: string;
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * The key is derived from the RETIRED refresh token (which only its holder has) and the
 * service signing secret (which only the service has). The database stores the hash of the
 * retired token and the sealed bytes: a database read gets neither half of the key.
 * HKDF info separates this key from every other use of those two inputs.
 */
function graceKey(retiredToken: string, serviceSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(retiredToken, 'utf8'), Buffer.from(serviceSecret, 'utf8'), 'identity.refresh-grace.v1', 32));
}

/** AES-256-GCM, `base64url(iv | tag | ciphertext)`, bound to the retired hash as associated data. */
export function sealGracePayload(retiredToken: string, retiredHash: string, serviceSecret: string, payload: GracePayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', graceKey(retiredToken, serviceSecret), iv);
  cipher.setAAD(Buffer.from(retiredHash, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The payload, or null for anything that does not authenticate (wrong token, wrong row, tampering). */
export function openGracePayload(retiredToken: string, retiredHash: string, serviceSecret: string, sealed: string): GracePayload | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv('aes-256-gcm', graceKey(retiredToken, serviceSecret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(retiredHash, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json) as Partial<GracePayload>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.userId !== 'string'
    ) {
      return null;
    }
    return parsed as GracePayload;
  } catch {
    return null;
  }
}
