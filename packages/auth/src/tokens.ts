import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { z } from 'zod';
import { type Scope } from './scopes.js';
import { STAFF_AREA_VERBS, STAFF_ENVS, isStaffAreaVerb, type StaffAreaVerb } from './staff-permissions.js';

/**
 * Token issuing and verification (§1 Auth: "Own service — JWT (short) +
 * rotating refresh").
 *
 * Access tokens are short-lived, signed HS256, and carry the caller's scopes so
 * every service can authorise locally without a round trip to svc-identity.
 * Refresh tokens are opaque, stored hashed, and rotate on every use — the
 * rotation is what makes theft detectable.
 */

/**
 * The staff permissions claim: `<area>:<verb>` entries for the one environment named in `staffEnv`, each once, at most
 * 11 × 8 = 88. A token carrying a malformed or repeated entry is malformed, not trimmed.
 */
const staffPermissionsClaimSchema = z
  .array(z.custom<StaffAreaVerb>((value) => isStaffAreaVerb(value), { message: 'not a staff <area>:<verb>' }))
  .max(STAFF_AREA_VERBS.length)
  .refine((list) => new Set(list).size === list.length, 'a staff permission is listed twice');

export const accessClaimsSchema = z.object({
  sub: z.string().guid(),
  scopes: z.array(z.string()),
  /** Present when the caller is a sub-account (§4.1 sub_accounts). */
  sub_account: z.string().guid().optional(),
  /** Present when an API key issued this token, so a leak can be traced to a key. */
  kid: z.string().optional(),
  /**
   * API-key environment (pay.public-api step 4 / ADR §2.5).
   *
   * Set only when the token was minted from a long-lived `ifc_…` key.
   * Interactive sessions omit it. `sandbox` routes merchant REST to the
   * sandbox rail; `live` may not name a sandbox rail. Absence is treated as
   * live at money surfaces that care — never as a silent sandbox upgrade.
   */
  key_env: z.enum(['live', 'sandbox']).optional(),
  /** Verification tier at issue time; jurisdiction checks read it. */
  tier: z.enum(['none', 'basic', 'full', 'institutional']).default('none'),
  /** True once the session has passed 2FA. Gates SESSION_MFA_SCOPES. */
  mfa: z.boolean().default(false),
  sid: z.string().guid(),
  /**
   * The session family: one per sign-in, the same on every refresh of it (`sid` changes on each refresh, because a
   * refresh opens a successor session). Interactive sessions carry it; API-key tokens and tokens minted before it
   * existed do not, so a reader treats absence as unknown, never as a match.
   *
   * `fam` and `dev` say which sign-in and which device a call came from, as of minting. They prove nothing about the
   * device still being trusted: a device removed since keeps its id on tokens already issued until they expire, so a
   * reader that needs "still trusted" asks identity.
   */
  fam: z.string().guid().optional(),
  /**
   * The trusted device (I-signin-sessions-07) the session is bound to, the same across refreshes. Absent when the
   * session is bound to none (an API key, a passkey sign-in, a token minted before it existed).
   */
  dev: z.string().guid().optional(),
  /**
   * Pay scopes minted by `auth.stepUpPay`. Absent on a normal session and on
   * every refresh. An API key may copy `pay:refund` / `pay:payout` only when
   * this claim lists them.
   */
  stp: z.array(z.string()).optional(),
  /**
   * Staff permissions (OPS-admin-access-03), a SNAPSHOT of `resolveStaffPermissions` at minting, as `<area>:<verb>`
   * entries for the one environment in `staffEnv` (`staffPermissionsForEnv`). Absent means none. `staffEnv` is present
   * exactly when this is, and neither is ever on a token with `kid` or `sub_account`; `verifyAccessToken` refuses any
   * other combination as `token.malformed`.
   *
   * A service compares `staffEnv` with its own configured environment (`parseStaffEnv`) and treats a mismatch as no
   * permissions (`staffPermissionsFromClaim`): a token minted for staging grants nothing in production.
   *
   * identity mints it only on an interactive session (never an API key or a sub-account token) of a staff member who
   * was invited and approved. The console may gate reads and which screens it shows on it. It is never authority for a
   * change: every privileged write, approve or apply is re-checked live in identity against the stored roles, so a
   * grant revoked since minting stops there at once. Founders do not rely on it; they keep the `admin:*` scopes and the
   * live founder entitlement.
   */
  staffPermissions: staffPermissionsClaimSchema.optional(),
  /** The environment `staffPermissions` was minted for. Present exactly when `staffPermissions` is. */
  staffEnv: z.enum(STAFF_ENVS).optional(),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export interface TokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  /**
   * Signing-key rotation (I-signin-sessions-31). `keyId` names `secret` in the JWT
   * header (`kid`, which is not the API-key `kid` claim). `verifyOnly` keys stay valid
   * for verification during the overlap and never sign. Absent: one secret, no header id.
   */
  keyId?: string;
  verifyOnly?: readonly { keyId: string; secret: string }[];
}

export interface Principal extends AccessClaims {
  readonly userId: string;
  readonly expiresAt: Date;
}

/**
 * Why a call was refused, as a code a client can branch on.
 *
 * `scope.denied`, `tier.insufficient` and `ownership.denied` were one value
 * until an audit asked what a UI could say when a screen went dark. All three
 * arrive as HTTP 403 and mean completely different things to the person
 * reading the screen:
 *
 *   scope.denied            this credential may never do this — nothing the user
 *                           does to their own account changes it
 *   scope.interactive_only  the scope is on the token, but the credential is an
 *                           API key. The scope stays on an interactive session.
 *                           Stepping up the key does not unlock it.
 *   tier.insufficient       this credential MAY do this, once verification catches
 *                           up — an action the user can take, today
 *   ownership.denied        the credential is fine and the thing belongs to someone
 *                           else — never a prompt, always a bug or an attempt
 *
 * Collapsing them meant the terminal could only say "scope, verification tier
 * or jurisdiction", which sends a verifiable user to support instead of to KYC.
 */
export type AuthErrorCode =
  | 'token.expired'
  | 'token.invalid'
  | 'token.malformed'
  | 'scope.denied'
  | 'scope.interactive_only'
  | 'tier.insufficient'
  | 'ownership.denied'
  | 'mfa.required';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: AuthErrorCode,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function key(secret: string): Uint8Array {
  if (secret.length < 32) throw new AuthError('Signing secret must be at least 32 characters', 'token.invalid');
  return new TextEncoder().encode(secret);
}

/**
 * Keys a token may be checked against. A token naming an id uses only that key (an id
 * that is not in the ring, such as a removed key, matches nothing). A token with no id
 * predates rotation, so every key is tried: the signing key, then the verify-only ones.
 */
function candidateKeys(token: string, config: TokenConfig): Uint8Array[] {
  const ring = [{ keyId: config.keyId, secret: config.secret }, ...(config.verifyOnly ?? [])];
  let kid: unknown;
  try {
    kid = (JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as { kid?: unknown }).kid;
  } catch {
    throw new AuthError('Access token could not be verified', 'token.invalid');
  }
  if (kid === undefined) return ring.map((k) => key(k.secret));
  return ring.filter((k) => k.keyId === kid).map((k) => key(k.secret));
}

export interface IssueAccessInput {
  userId: string;
  sessionId: string;
  scopes: readonly Scope[] | readonly string[];
  tier?: AccessClaims['tier'];
  mfa?: boolean;
  subAccountId?: string;
  apiKeyId?: string;
  /** Only for tokens minted from an API key (ADR pay.public-api §2.5). */
  keyEnv?: 'live' | 'sandbox';
  /** Pay scopes this step-up mint is allowed to delegate onto a key. */
  stepUpScopes?: readonly string[];
  /** The session's family (`fam`), stable across refreshes. */
  familyId?: string | null;
  /** The trusted device the session is bound to (`dev`). */
  trustedDeviceId?: string | null;
  /**
   * Staff permissions snapshot (`staffPermissions`, `<area>:<verb>` from `staffPermissionsForEnv`) and the environment
   * it is for (`staffEnv`, required with a non-empty list). Interactive sessions only. An empty or absent list mints
   * neither claim.
   */
  staffPermissions?: readonly string[];
  staffEnv?: string;
}

const SESSION_CLAIM_ID = z.string().guid();

export async function issueAccessToken(input: IssueAccessInput, config: TokenConfig): Promise<{ token: string; expiresAt: Date }> {
  // Refuse at minting what every verifier would refuse later, and keep API-key tokens free of sign-in claims.
  for (const [name, value] of [
    ['familyId', input.familyId],
    ['trustedDeviceId', input.trustedDeviceId],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (!SESSION_CLAIM_ID.safeParse(value).success) throw new AuthError(`${name} must be a UUID`, 'token.invalid');
    if (input.apiKeyId) throw new AuthError(`${name} is a sign-in claim and never goes on an API-key token`, 'token.invalid');
  }
  const staffPermissions = input.staffPermissions ?? [];
  if (staffPermissions.length > 0) {
    if (input.apiKeyId || input.subAccountId) {
      throw new AuthError(
        'staffPermissions is an interactive staff claim and never goes on an API-key or sub-account token',
        'token.invalid',
      );
    }
    if (!staffPermissionsClaimSchema.safeParse(staffPermissions).success) {
      throw new AuthError('staffPermissions must be distinct <area>:<verb> entries', 'token.invalid');
    }
    if (!z.enum(STAFF_ENVS).safeParse(input.staffEnv).success) {
      throw new AuthError('staffPermissions needs the staffEnv it was resolved for', 'token.invalid');
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.accessTtlSeconds;

  const token = await new SignJWT({
    scopes: [...input.scopes],
    tier: input.tier ?? 'none',
    mfa: input.mfa ?? false,
    sid: input.sessionId,
    ...(input.familyId ? { fam: input.familyId } : {}),
    ...(input.trustedDeviceId ? { dev: input.trustedDeviceId } : {}),
    ...(input.subAccountId ? { sub_account: input.subAccountId } : {}),
    ...(input.apiKeyId ? { kid: input.apiKeyId } : {}),
    ...(input.keyEnv ? { key_env: input.keyEnv } : {}),
    ...(input.stepUpScopes && input.stepUpScopes.length > 0 ? { stp: [...input.stepUpScopes] } : {}),
    ...(staffPermissions.length > 0 ? { staffPermissions: [...staffPermissions], staffEnv: input.staffEnv } : {}),
  } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', ...(config.keyId ? { kid: config.keyId } : {}) })
    .setSubject(input.userId)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(key(config.secret));

  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyAccessToken(token: string, config: TokenConfig): Promise<Principal> {
  let payload: JWTPayload;
  try {
    const options = {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['HS256'] as string[],
      /**
       * `exp` is REQUIRED, not merely checked when present.
       *
       * jose validates an expiry only if the claim is there — `if (payload.exp
       * !== undefined)`. Without this line a validly-signed token carrying no
       * `exp` verified, and verified forever. "Access tokens are short-lived"
       * is the first promise this file makes.
       *
       * It mattered unevenly. A token arriving through the edge is re-checked
       * against `expiresAt` in `packages/contracts/src/edge.ts`, so an absent
       * expiry failed closed there. The two surfaces that call this function
       * DIRECTLY do not re-check it — `svc-ledger`'s operator HTTP (freeze,
       * unfreeze, reconcile) and `svc-edge`'s admin API (kill-switch, treasury)
       * — which are the two highest-value doors in the platform.
       */
      requiredClaims: ['exp'],
    };
    let verified: JWTPayload | undefined;
    let failure: unknown = new AuthError('Access token key is not accepted', 'token.invalid');
    for (const candidate of candidateKeys(token, config)) {
      try {
        verified = (await jwtVerify(token, candidate, options)).payload;
        break;
      } catch (err) {
        // A claim failure (expired, wrong issuer) means the signature matched this key: report it, stop.
        if (err instanceof joseErrors.JWTExpired || err instanceof joseErrors.JWTClaimValidationFailed) throw err;
        failure = err;
      }
    }
    if (!verified) throw failure;
    payload = verified;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new AuthError('Access token expired', 'token.expired');
    if (err instanceof joseErrors.JWTClaimValidationFailed) throw new AuthError('Token claims rejected', 'token.invalid');
    throw new AuthError('Access token could not be verified', 'token.invalid');
  }

  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success) throw new AuthError('Access token payload is malformed', 'token.malformed');
  // Checked here, not as a refinement on the schema, because svc-edge's principal header `.extend`s it.
  const staff = claims.data.staffPermissions !== undefined;
  if (
    staff !== (claims.data.staffEnv !== undefined) ||
    (staff && (claims.data.kid !== undefined || claims.data.sub_account !== undefined))
  ) {
    throw new AuthError('Access token payload is malformed', 'token.malformed');
  }

  // No `?? 0`. `requiredClaims` above means the claim is present or we never
  // reached this line — and the fallback was the tell: it manufactured a 1970
  // expiry for a token it had just accepted, rather than refusing one.
  return {
    ...claims.data,
    userId: claims.data.sub,
    expiresAt: new Date(payload.exp! * 1000),
  };
}

// ── Refresh tokens ───────────────────────────────────────────────────────────

/**
 * Refresh tokens are opaque random strings. Only their hash is stored, so a
 * database read never yields a usable credential.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  // sha256 is correct here because the input is already 48 bytes of entropy —
  // this is a lookup key, not a password. Passwords use argon2id (§9).
  return createHash('sha256').update(token).digest('hex');
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
