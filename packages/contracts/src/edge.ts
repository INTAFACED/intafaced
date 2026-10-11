import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { accessClaimsSchema, type Principal } from '@intafaced/auth';
import type { Context } from './trpc.js';
import { rawBodyOf } from './raw-body.js';
import { DEFAULT_SERVICE_BODY_BIND_MODE, verifyServiceHeaders, type ServiceBodyBindMode } from './service-auth.js';

/**
 * THE EDGE TRUST BOUNDARY (§9).
 *
 * Every authorisation decision in the OS reads `ctx.principal` — scope, tier,
 * MFA, jurisdiction. None of them re-derive it. So whatever puts a principal on
 * the context is, in effect, the entire authorisation model.
 *
 * A mounted service does not parse tokens (§4.1 owns that); the edge terminates
 * auth and forwards the resolved principal in a header. That is a sound design
 * with exactly one precondition:
 *
 *   **the header is only worth anything if the caller cannot forge it.**
 *
 * `JSON.parse(req.headers['x-intafaced-principal'])` does not meet that bar. It
 * lets anyone who can reach the port assert any user id, any scope set, any KYC
 * tier, and `mfa: true` — which is not "a public procedure is exposed", it is
 * every procedure simultaneously, including the ones guarding withdrawals.
 *
 * So the header is signed. The edge HMACs the exact bytes it forwards; the
 * service verifies before it believes anything. Network placement stops being
 * the only thing between a caller and a withdrawal.
 */

export const EDGE_PRINCIPAL_HEADER = 'x-intafaced-principal';
export const EDGE_SIGNATURE_HEADER = 'x-intafaced-principal-sig';

/**
 * The wire form. This is `AccessClaims` plus the two fields `Principal` adds,
 * with `expiresAt` as an ISO string because a header is text.
 *
 * It is validated rather than cast. The previous `as never` did not merely skip
 * a check — it told the compiler to stop asking, so every downstream read of
 * `principal.scopes` was typed against a value nothing had ever inspected.
 */
export const principalHeaderSchema = accessClaimsSchema.extend({
  userId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});

export type PrincipalHeader = z.infer<typeof principalHeaderSchema>;

/** Serialise a principal for forwarding. The edge calls this; services do not. */
export function encodePrincipal(principal: Principal): string {
  const wire: PrincipalHeader = {
    sub: principal.sub,
    scopes: [...principal.scopes],
    tier: principal.tier,
    mfa: principal.mfa,
    sid: principal.sid,
    userId: principal.userId,
    expiresAt: principal.expiresAt.toISOString(),
    ...(principal.sub_account ? { sub_account: principal.sub_account } : {}),
    ...(principal.kid ? { kid: principal.kid } : {}),
    ...(principal.key_env ? { key_env: principal.key_env } : {}),
  };
  return JSON.stringify(wire);
}

/**
 * HMAC-SHA256 over the raw header bytes.
 *
 * Over the RAW STRING, not over a re-serialised object: JSON key order is not
 * canonical, so signing a parsed-and-restringified value would verify a
 * different byte sequence than the one that arrived.
 */
export function signPrincipalHeader(raw: string, secret: string, region = 'XX'): string {
  // L2-4: region is bound into the signature so a free header cannot forge jurisdiction.
  return createHmac('sha256', secret).update(`${raw}\nregion=${region}`, 'utf8').digest('hex');
}

function signatureMatches(raw: string, signature: string, secret: string, region = 'XX'): boolean {
  const expected = signPrincipalHeader(raw, secret, region);

  // Length first and separately: timingSafeEqual THROWS on a length mismatch,
  // and an exception here would be an unauthenticated caller crashing a request
  // handler. Non-hex is rejected on the way in because Buffer.from('zz', 'hex')
  // silently yields an empty buffer, and two empty buffers compare equal.
  if (signature.length !== expected.length) return false;
  if (!/^[0-9a-f]+$/.test(signature)) return false;

  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

export interface EdgeVerifyResult {
  principal: Principal | null;
  /** Why a principal was refused. Null when one was accepted or none was sent. */
  rejected: 'bad-signature' | 'malformed' | 'expired' | null;
}

/**
 * Verify a forwarded principal.
 *
 * Fails CLOSED in every direction: a bad signature, unparseable JSON, a shape
 * that does not match, or an expired principal all yield `null` — an anonymous
 * caller — rather than a partially-trusted one. There is no branch in which a
 * principal survives with some of its claims unverified.
 */
export function verifyForwardedPrincipal(
  raw: string | undefined,
  signature: string | undefined,
  secret: string,
  now: Date = new Date(),
  region = 'XX',
): EdgeVerifyResult {
  if (!raw) return { principal: null, rejected: null };
  if (!signature) return { principal: null, rejected: 'bad-signature' };
  if (!signatureMatches(raw, signature, secret, region)) return { principal: null, rejected: 'bad-signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { principal: null, rejected: 'malformed' };
  }

  const result = principalHeaderSchema.safeParse(parsed);
  if (!result.success) return { principal: null, rejected: 'malformed' };

  const expiresAt = new Date(result.data.expiresAt);

  // A signature proves the edge said it; it does not prove the edge said it
  // recently. A captured header would otherwise be replayable forever.
  if (expiresAt.getTime() <= now.getTime()) return { principal: null, rejected: 'expired' };

  const { expiresAt: _discard, ...claims } = result.data;
  return { principal: { ...claims, expiresAt }, rejected: null };
}

export interface EdgeContextOptions {
  /** Shared secret between the edge and this service. */
  secret: string;
  /** Service name, used only in the boot-time error message. */
  serviceName: string;
  /**
   * Shared secret for service-to-service calls (§2).
   *
   * Required by any service exposing a `serviceProcedure` — svc-ledger above
   * all. Omit only for a service with no internal-only endpoints; the context
   * then reports every caller as `service: null`, which fails those procedures
   * closed rather than open.
   */
  internalSecret?: string;
  /**
   * How strictly S2S HMAC binds the request body. Defaults to
   * `DEFAULT_SERVICE_BODY_BIND_MODE` (`accept-both`).
   *
   * Pass `require` only after callers sign v2 and this instance has
   * `retainRawBody` installed — otherwise every service call is
   * `body-unavailable`. Does not change the package-wide default.
   */
  bodyBindMode?: ServiceBodyBindMode;
}

/**
 * Minimum secret length. Shorter than this and the HMAC is guessable offline,
 * at which point signing is theatre.
 */
const MIN_SECRET_LENGTH = 32;

export class EdgeTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeTrustError';
  }
}

export interface EdgeRequest {
  headers: Record<string, string | string[] | undefined>;
  id?: string | number;
}

/**
 * Build the tRPC context factory for a self-mounted service.
 *
 * Throws at BOOT if the secret is missing or weak, rather than per-request.
 * A service that cannot authenticate the edge must not start and quietly serve
 * traffic as anonymous — that failure mode looks identical to "no users yet"
 * until the first unauthorised call succeeds against a `publicProcedure`.
 */
export function createEdgeContext(options: EdgeContextOptions): (req: EdgeRequest) => Context {
  if (!options.secret || options.secret.length < MIN_SECRET_LENGTH) {
    throw new EdgeTrustError(
      `${options.serviceName}: EDGE_PRINCIPAL_SECRET must be at least ${MIN_SECRET_LENGTH} characters to mount /trpc. ` +
        'Without it the principal header is caller-controlled and every scope check is decorative (§9).',
    );
  }

  // A present service-to-service secret is the same HMAC. Shorter than
  // MIN_SECRET_LENGTH is offline-guessable signing theatre, including the
  // svc-ledger path. Absence stays optional and reports service: null.
  if (options.internalSecret !== undefined && options.internalSecret.length < MIN_SECRET_LENGTH) {
    throw new EdgeTrustError(
      `${options.serviceName}: INTERNAL_SERVICE_SECRET must be at least ${MIN_SECRET_LENGTH} characters to mount /trpc. ` +
        'Shorter than this and the HMAC is guessable offline, at which point signing is theatre.',
    );
  }

  return (req) => {
    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const region = header('x-intafaced-region') ?? 'XX';
    const { principal } = verifyForwardedPrincipal(
      header(EDGE_PRINCIPAL_HEADER),
      header(EDGE_SIGNATURE_HEADER),
      options.secret,
      new Date(),
      region,
    );

    const traceparent = header('traceparent');

    // A service caller and a user principal are independent. Both may be
    // absent, either may be present; `serviceProcedure` and `scopedProcedure`
    // each check only their own, so neither can stand in for the other.
    //
    // Body bytes must reach the verifier: without them a captured v2 HMAC is
    // replayable against any tRPC input for the skew window. `rawBodyOf` on a
    // plain object (no `retainRawBody`) reports not-retained; accept-both still
    // admits authentic v2, require refuses with body-unavailable.
    const service = options.internalSecret
      ? verifyServiceHeaders(req.headers, options.internalSecret, {
          rawBody: rawBodyOf(req),
          mode: options.bodyBindMode ?? DEFAULT_SERVICE_BODY_BIND_MODE,
        }).service
      : null;

    return {
      principal,
      service,
      region,
      requestId: String(req.id ?? ''),
      ...(traceparent ? { traceparent } : {}),
    };
  };
}
