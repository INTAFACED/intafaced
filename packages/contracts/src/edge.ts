import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import { accessClaimsSchema, type Principal } from '@intafaced/auth';
import type { Context } from './trpc.js';
import { inboundRawBodyOf } from './raw-body.js';
import { verifyServiceHeaders, type ServiceBodyBindMode } from './service-auth.js';
import { verifyServiceRequest, type ServiceAuthMode } from './service-auth-http.js';
import type { ServiceVerifier } from './service-keys.js';

/** The tRPC door has no v1 callers; see `EdgeContextOptions.bodyBindMode`. */
const EDGE_CONTEXT_BODY_BIND_MODE: ServiceBodyBindMode = 'require';

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
  userId: z.string().guid(),
  expiresAt: z.string().datetime(),
  /** Issue time, whole seconds. Present on every Ed25519-signed principal. */
  iat: z.number().int().positive().optional(),
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
    ...(principal.fam ? { fam: principal.fam } : {}),
    ...(principal.dev ? { dev: principal.dev } : {}),
    ...(principal.sub_account ? { sub_account: principal.sub_account } : {}),
    ...(principal.kid ? { kid: principal.kid } : {}),
    ...(principal.key_env ? { key_env: principal.key_env } : {}),
    ...(principal.stp && principal.stp.length > 0 ? { stp: [...principal.stp] } : {}),
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

/**
 * ED25519 PRINCIPAL SIGNING (only svc-edge may sign a user principal).
 *
 * The HMAC scheme above needs every verifier to hold the signing secret, so any
 * service that can verify can also forge a principal for any user. Ed25519 splits
 * the two: svc-edge holds the private key, every other service holds only the
 * public key and can verify but never mint.
 *
 * - Signature header value: `ed25519:` + base64url signature (the HMAC form is bare hex, so the
 *   two never collide).
 * - Preimage: `intafaced-principal-v2\n<raw header>\nregion=<region>` (region is bound, as before).
 * - A principal signed this way carries `iat` and an expiry at most the configured maximum
 *   lifetime after it; anything longer is refused, however it was signed. The maximum lifetime and
 *   the clock-skew allowance are REQUIRED configuration (`EdgePrincipalLimits`), never defaults:
 *   the value is an open owner decision, so a missing or invalid one refuses with a typed error.
 * - The public key is published as the raw 32 bytes, base64url (SERVICE-AUTH-SLICES S2S-00 (1)).
 */

/** Supplied by the caller / service config. There is deliberately no default for either. */
export interface EdgePrincipalLimits {
  /** Longest allowed gap between `iat` and `expiresAt`, in whole seconds (positive integer). */
  readonly maxLifetimeSeconds: number;
  /** How far in the future an `iat` may be, in whole seconds (positive integer). */
  readonly clockSkewSeconds: number;
}

/** Stable codes on `EdgeTrustError.code` for the principal limits. */
export const EDGE_PRINCIPAL_LIMITS_REQUIRED = 'EDGE_PRINCIPAL_LIMITS_REQUIRED';
export const EDGE_PRINCIPAL_LIMITS_INVALID = 'EDGE_PRINCIPAL_LIMITS_INVALID';

const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Throws EdgeTrustError (stable `code`) when either limit is missing, non-integer or not positive. */
export function assertEdgePrincipalLimits(limits: Partial<EdgePrincipalLimits> | undefined): asserts limits is EdgePrincipalLimits {
  if (limits === undefined || limits === null || limits.maxLifetimeSeconds === undefined || limits.clockSkewSeconds === undefined) {
    throw new EdgeTrustError(
      'Forwarded-principal maxLifetimeSeconds and clockSkewSeconds are required configuration and have no default.',
      EDGE_PRINCIPAL_LIMITS_REQUIRED,
    );
  }
  if (!isPositiveInt(limits.maxLifetimeSeconds) || !isPositiveInt(limits.clockSkewSeconds)) {
    throw new EdgeTrustError(
      'Forwarded-principal maxLifetimeSeconds and clockSkewSeconds must be positive integers (seconds).',
      EDGE_PRINCIPAL_LIMITS_INVALID,
    );
  }
}

function limitsOk(limits: Partial<EdgePrincipalLimits> | undefined): limits is EdgePrincipalLimits {
  try {
    assertEdgePrincipalLimits(limits);
    return true;
  } catch {
    return false;
  }
}
const ED25519_PREFIX = 'ed25519:';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function principalPreimage(raw: string, region: string): Buffer {
  return Buffer.from(`intafaced-principal-v2\n${raw}\nregion=${region}`, 'utf8');
}

/** Raw 32-byte Ed25519 public key (base64url) to a key object. Throws on any other length. */
export function edgePrincipalPublicKey(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== publicKey) {
    throw new EdgeTrustError('EDGE_PRINCIPAL_PUBLIC_KEY must be a raw 32-byte Ed25519 public key, base64url');
  }
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** A fresh edge key pair: PKCS8 private key and raw public key, both base64url. For key generation tooling and tests. */
export function generateEdgePrincipalKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64url'),
  };
}

/** Sign the exact header bytes with the edge private key. Only svc-edge holds that key. */
export function signPrincipalHeaderEd25519(raw: string, privateKey: string, region = 'XX'): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  return ED25519_PREFIX + cryptoSign(null, principalPreimage(raw, region), key).toString('base64url');
}

/**
 * The wire form for a principal the edge forwards: `iat` set, expiry clamped to
 * `maxLifetimeSeconds` from now (never later than the token's own expiry). The lifetime is required
 * and has no default; a missing or invalid one throws EdgeTrustError.
 */
export function encodeForwardedPrincipal(principal: Principal, maxLifetimeSeconds: number, now: Date = new Date()): string {
  assertEdgePrincipalLimits({ maxLifetimeSeconds, clockSkewSeconds: 1 });
  const wire = JSON.parse(encodePrincipal(principal)) as PrincipalHeader;
  const iat = Math.floor(now.getTime() / 1000);
  const cap = iat * 1000 + maxLifetimeSeconds * 1000;
  wire.iat = iat;
  wire.expiresAt = new Date(Math.min(principal.expiresAt.getTime(), cap)).toISOString();
  return JSON.stringify(wire);
}

/** What a verifier trusts: the legacy shared secret and/or the edge public key. */
export type EdgePrincipalTrust =
  | string
  | {
      readonly hmacSecret?: string;
      readonly publicKey?: string;
      /** Required to accept the asymmetric form; ignored by the legacy shared-secret path. */
      readonly limits?: EdgePrincipalLimits;
    };

function trustOf(trust: EdgePrincipalTrust): { hmacSecret?: string; publicKey?: string; limits?: EdgePrincipalLimits } {
  return typeof trust === 'string' ? { hmacSecret: trust } : trust;
}

function ed25519Matches(raw: string, signature: string, publicKey: string, region: string): boolean {
  const body = signature.slice(ED25519_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{86}$/.test(body)) return false;
  try {
    return cryptoVerify(null, principalPreimage(raw, region), edgePrincipalPublicKey(publicKey), Buffer.from(body, 'base64url'));
  } catch {
    return false;
  }
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
  rejected: 'bad-signature' | 'malformed' | 'expired' | 'unconfigured' | null;
}

/** What the shared-secret form can return. Exactly the original shape; it never returns 'unconfigured'. */
export interface EdgeLegacyVerifyResult {
  principal: Principal | null;
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
  trust: string,
  now?: Date,
  region?: string,
): EdgeLegacyVerifyResult;
export function verifyForwardedPrincipal(
  raw: string | undefined,
  signature: string | undefined,
  trust: EdgePrincipalTrust,
  now?: Date,
  region?: string,
): EdgeVerifyResult;
export function verifyForwardedPrincipal(
  raw: string | undefined,
  signature: string | undefined,
  trust: EdgePrincipalTrust,
  now: Date = new Date(),
  region = 'XX',
): EdgeVerifyResult {
  if (!raw) return { principal: null, rejected: null };
  if (!signature) return { principal: null, rejected: 'bad-signature' };
  const { hmacSecret, publicKey, limits } = trustOf(trust);
  const asymmetric = signature.startsWith(ED25519_PREFIX);
  if (asymmetric) {
    // No lifetime / skew configured: refuse (fail closed) rather than assume a magnitude.
    // A verifier that holds no public key cannot accept this form, and one that does accepts nothing else for it.
    if (publicKey && !limitsOk(limits)) return { principal: null, rejected: 'unconfigured' };
    if (!publicKey || !ed25519Matches(raw, signature, publicKey, region)) return { principal: null, rejected: 'bad-signature' };
  } else if (!hmacSecret || !signatureMatches(raw, signature, hmacSecret, region)) {
    return { principal: null, rejected: 'bad-signature' };
  }

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

  if (asymmetric) {
    // Short-lived by construction: iat is required, may not be in the future, and the
    // expiry may be at most the configured lifetime after it.
    const iatMs = (result.data.iat ?? 0) * 1000;
    if (!result.data.iat || iatMs > now.getTime() + limits!.clockSkewSeconds * 1000) return { principal: null, rejected: 'malformed' };
    if (expiresAt.getTime() - iatMs > limits!.maxLifetimeSeconds * 1000) return { principal: null, rejected: 'expired' };
  }

  const { expiresAt: _discard, iat: _iat, ...claims } = result.data;
  return { principal: { ...claims, expiresAt }, rejected: null };
}

export interface EdgeContextOptions {
  /**
   * Legacy shared HMAC secret between the edge and this service. A service holding it can also
   * FORGE principals, so a service moves to `edgePublicKey` and drops this. At least one of the
   * two is required; with both set either form is accepted (migration only).
   */
  secret?: string;
  /**
   * The edge's raw 32-byte Ed25519 public key, base64url (`EDGE_PRINCIPAL_PUBLIC_KEY`). Verify-only:
   * a service holding just this key cannot mint a principal anyone else will accept.
   */
  edgePublicKey?: string;
  /**
   * Maximum principal lifetime and clock-skew allowance for the asymmetric form. REQUIRED whenever
   * `edgePublicKey` is set, with no default (the value is an open owner decision): boot throws
   * EdgeTrustError with a stable code when missing, non-integer or non-positive.
   */
  principalLimits?: EdgePrincipalLimits;
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
   * How strictly S2S HMAC binds the request body on this tRPC door. Defaults to
   * `require`.
   *
   * The tRPC door has no v1 callers (every outbound client signs v2 with
   * `serviceAuthHeadersForBody`), and `accept-both` here would let an unbound v1
   * signature — or an empty-body one replayed — authenticate any body for the
   * skew window. Pass `accept-both` only as a deliberate, temporary downgrade.
   * `require` needs the context factory to be handed the whole request (so
   * `req.body` / the retained bytes are visible); `{ headers, id }` alone has no
   * body and refuses every service call as `body-unavailable`. Does not change
   * the package-wide `DEFAULT_SERVICE_BODY_BIND_MODE`.
   */
  bodyBindMode?: ServiceBodyBindMode;
  /**
   * Verifier for key-signed service calls (S2S v3). When set, a call signed with a
   * service's own key is accepted and the caller is named by that key; the
   * shared-secret form keeps working under `internalSecret` unless `s2sMode` is
   * `keypair`. Omitted: behaviour is exactly the shared-secret path.
   */
  serviceVerifier?: ServiceVerifier;
  s2sMode?: ServiceAuthMode;
}

/**
 * Minimum secret length. Shorter than this and the HMAC is guessable offline,
 * at which point signing is theatre.
 */
const MIN_SECRET_LENGTH = 32;

export class EdgeTrustError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
    this.name = 'EdgeTrustError';
  }
}

export interface EdgeRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Method and raw target (path and query). Needed to verify a key-signed service call. */
  method?: string;
  url?: string;
  id?: string | number;
  /**
   * The request body as the HTTP adapter left it. The tRPC Fastify plugin keeps
   * the wire text here (`parseAs: 'string'`); that exact text is bound for S2S
   * body verification. Pass the whole Fastify request, not a copy of its headers.
   */
  body?: unknown;
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
  if (options.edgePublicKey !== undefined) {
    try {
      edgePrincipalPublicKey(options.edgePublicKey);
    } catch {
      throw new EdgeTrustError(`${options.serviceName}: EDGE_PRINCIPAL_PUBLIC_KEY must be a raw 32-byte Ed25519 public key, base64url.`);
    }
  }
  if (options.edgePublicKey !== undefined) {
    try {
      assertEdgePrincipalLimits(options.principalLimits);
    } catch (e) {
      throw new EdgeTrustError(`${options.serviceName}: ${(e as Error).message}`, (e as EdgeTrustError).code);
    }
  }
  const hasSecret = options.secret !== undefined && options.secret.length > 0;
  if (hasSecret && options.secret!.length < MIN_SECRET_LENGTH) {
    throw new EdgeTrustError(
      `${options.serviceName}: EDGE_PRINCIPAL_SECRET must be at least ${MIN_SECRET_LENGTH} characters to mount /trpc. ` +
        'Without it the principal header is caller-controlled and every scope check is decorative (§9).',
    );
  }
  if (!hasSecret && options.edgePublicKey === undefined) {
    throw new EdgeTrustError(
      `${options.serviceName}: set EDGE_PRINCIPAL_PUBLIC_KEY (or the legacy EDGE_PRINCIPAL_SECRET, at least ${MIN_SECRET_LENGTH} characters) to mount /trpc. ` +
        'Without one the principal header is caller-controlled and every scope check is decorative (§9).',
    );
  }
  const trust = {
    ...(hasSecret ? { hmacSecret: options.secret } : {}),
    ...(options.edgePublicKey ? { publicKey: options.edgePublicKey, limits: options.principalLimits } : {}),
  };

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
    const rawPrincipal = header(EDGE_PRINCIPAL_HEADER);
    const principalSignature = header(EDGE_SIGNATURE_HEADER);
    const { principal } = verifyForwardedPrincipal(rawPrincipal, principalSignature, trust, new Date(), region);

    const traceparent = header('traceparent');

    // A service caller and a user principal are independent. Both may be
    // absent, either may be present; `serviceProcedure` and `scopedProcedure`
    // each check only their own, so neither can stand in for the other.
    //
    // Body bytes must reach the verifier: without them a captured v2 HMAC is
    // replayable against any tRPC input for the skew window. The tRPC Fastify
    // plugin replaces the JSON parser inside its own scope with `parseAs:
    // 'string'`, so `retainRawBody`'s parser never runs for /trpc/*; the wire
    // text is `req.body`, and `inboundRawBodyOf` binds exactly that (or the
    // retained bytes on a root route). A plain object with neither reports
    // not-retained, which `require` refuses with body-unavailable.
    const keyed = options.serviceVerifier
      ? verifyServiceRequest(req, {
          verifier: options.serviceVerifier,
          legacySecret: options.internalSecret,
          mode: options.s2sMode,
          bodyBindMode: options.bodyBindMode ?? EDGE_CONTEXT_BODY_BIND_MODE,
        })
      : null;
    const service = keyed
      ? keyed.service
      : options.internalSecret
        ? verifyServiceHeaders(req.headers, options.internalSecret, {
            rawBody: inboundRawBodyOf(req),
            mode: options.bodyBindMode ?? EDGE_CONTEXT_BODY_BIND_MODE,
          }).service
        : null;

    return {
      principal,
      service,
      ...(keyed?.scheme ? { serviceAuth: keyed.scheme } : {}),
      region,
      requestId: String(req.id ?? ''),
      ...(traceparent ? { traceparent } : {}),
      // The exact edge-signed bytes, so a service acting during this user's request can pass
      // them on unchanged. It cannot build or alter them: it holds no signing key.
      ...(principal && rawPrincipal && principalSignature
        ? { forwardedPrincipal: { raw: rawPrincipal, signature: principalSignature, region } }
        : {}),
    };
  };
}

/**
 * Headers for a service that calls another service WHILE ACTING FOR the user of this request:
 * the edge-signed principal, byte for byte, plus the region it was signed with. Empty for an
 * anonymous request or a pure service call: such work runs as the service itself (a signed
 * service call, user id in the signed body), never under a user principal it made up.
 */
export function forwardedPrincipalHeaders(ctx: Pick<Context, 'forwardedPrincipal'>): Record<string, string> {
  const forwarded = ctx.forwardedPrincipal;
  if (!forwarded) return {};
  return {
    [EDGE_PRINCIPAL_HEADER]: forwarded.raw,
    [EDGE_SIGNATURE_HEADER]: forwarded.signature,
    'x-intafaced-region': forwarded.region,
  };
}
