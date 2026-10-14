import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { z } from 'zod';
import { type Scope } from './scopes.js';

/**
 * Token issuing and verification (§1 Auth: "Own service — JWT (short) +
 * rotating refresh").
 *
 * Access tokens are short-lived, signed HS256, and carry the caller's scopes so
 * every service can authorise locally without a round trip to svc-identity.
 * Refresh tokens are opaque, stored hashed, and rotate on every use — the
 * rotation is what makes theft detectable.
 */

export const accessClaimsSchema = z.object({
  sub: z.string().uuid(),
  scopes: z.array(z.string()),
  /** Present when the caller is a sub-account (§4.1 sub_accounts). */
  sub_account: z.string().uuid().optional(),
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
  /** True once the session has passed 2FA. Gates INTERACTIVE_ONLY_SCOPES. */
  mfa: z.boolean().default(false),
  /**
   * Unix seconds when the password (and second factor, if any) were last actually
   * verified. A refresh carries it forward unchanged, so it measures how long ago
   * the person really signed in, not when the token was minted. Absent on tokens
   * minted before it existed and on API-key tokens; treat absent as "unknown", never
   * as recent. Lets a step-up gate require recency.
   */
  auth_time: z.number().int().nonnegative().optional(),
  sid: z.string().uuid(),
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export interface TokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
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
 *   scope.denied       this credential may never do this — nothing the user
 *                      does to their own account changes it
 *   tier.insufficient  this credential MAY do this, once verification catches
 *                      up — an action the user can take, today
 *   ownership.denied   the credential is fine and the thing belongs to someone
 *                      else — never a prompt, always a bug or an attempt
 *
 * Collapsing them meant the terminal could only say "scope, verification tier
 * or jurisdiction", which sends a verifiable user to support instead of to KYC.
 */
export type AuthErrorCode =
  'token.expired' | 'token.invalid' | 'token.malformed' | 'scope.denied' | 'tier.insufficient' | 'ownership.denied' | 'mfa.required';

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

export interface IssueAccessInput {
  userId: string;
  sessionId: string;
  scopes: readonly Scope[] | readonly string[];
  tier?: AccessClaims['tier'];
  mfa?: boolean;
  /** Unix seconds of the last real password / second-factor verification. Omit when unknown. */
  authTime?: number;
  subAccountId?: string;
  apiKeyId?: string;
  /** Only for tokens minted from an API key (ADR pay.public-api §2.5). */
  keyEnv?: 'live' | 'sandbox';
}

export async function issueAccessToken(input: IssueAccessInput, config: TokenConfig): Promise<{ token: string; expiresAt: Date }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.accessTtlSeconds;

  const token = await new SignJWT({
    scopes: [...input.scopes],
    tier: input.tier ?? 'none',
    mfa: input.mfa ?? false,
    ...(input.authTime !== undefined ? { auth_time: Math.floor(input.authTime) } : {}),
    sid: input.sessionId,
    ...(input.subAccountId ? { sub_account: input.subAccountId } : {}),
    ...(input.apiKeyId ? { kid: input.apiKeyId } : {}),
    ...(input.keyEnv ? { key_env: input.keyEnv } : {}),
  } satisfies JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
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
    const result = await jwtVerify(token, key(config.secret), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['HS256'],
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
    });
    payload = result.payload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new AuthError('Access token expired', 'token.expired');
    if (err instanceof joseErrors.JWTClaimValidationFailed) throw new AuthError('Token claims rejected', 'token.invalid');
    throw new AuthError('Access token could not be verified', 'token.invalid');
  }

  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success) throw new AuthError('Access token payload is malformed', 'token.malformed');

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
