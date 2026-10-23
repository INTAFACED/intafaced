import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { accessClaimsSchema, type Principal } from '@intafaced/auth';
import type { Context, ForwardedPrincipal } from './trpc.js';
import { inboundRawBodyOf } from './raw-body.js';
import { verifyServiceHeaders, type ServiceBodyBindMode } from './service-auth.js';

/**
 * How long an edge-signed principal may live. S2S-00 / N5: 300s, not 60s.
 * A one-minute cap expires under a live agent turn. The bound is `exp`,
 * the scope cap and hop binding — not a shorter clock.
 */
export const PRINCIPAL_MAX_TTL_SECONDS = 300;

/** Ed25519 PKCS8 prefix (RFC 8410). 16 bytes + 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Ed25519 SPKI prefix. 12 bytes + 32-byte raw public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SEED_DOMAIN = 'intafaced-edge-principal-v1\n';

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
 * So the header is signed. svc-edge signs with an Ed25519 private key; every
 * other service holds only the raw public key and cannot mint. A bad or
 * missing signature is anonymous. Network placement is not the control.
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
  /** Unix seconds. Edge sets both; `exp - iat` is at most {@link PRINCIPAL_MAX_TTL_SECONDS}. */
  iat: z.number().int(),
  exp: z.number().int(),
});

export type PrincipalHeader = z.infer<typeof principalHeaderSchema>;

/** Serialise a principal for forwarding. The edge calls this; services do not. */
export function encodePrincipal(principal: Principal, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const maxExpMs = now.getTime() + PRINCIPAL_MAX_TTL_SECONDS * 1000;
  const effectiveExpiry = principal.expiresAt.getTime() > maxExpMs ? new Date(maxExpMs) : principal.expiresAt;
  let exp = Math.ceil(effectiveExpiry.getTime() / 1000);
  if (exp - iat > PRINCIPAL_MAX_TTL_SECONDS) exp = iat + PRINCIPAL_MAX_TTL_SECONDS;
  const wire: PrincipalHeader = {
    sub: principal.sub,
    scopes: [...principal.scopes],
    tier: principal.tier,
    mfa: principal.mfa,
    sid: principal.sid,
    userId: principal.userId,
    expiresAt: effectiveExpiry.toISOString(),
    iat,
    exp,
    ...(principal.sub_account ? { sub_account: principal.sub_account } : {}),
    ...(principal.kid ? { kid: principal.kid } : {}),
    ...(principal.key_env ? { key_env: principal.key_env } : {}),
    ...(principal.stp && principal.stp.length > 0 ? { stp: [...principal.stp] } : {}),
  };
  return JSON.stringify(wire);
}

function decodeB64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value) return null;
  return raw;
}

/** Canonical base64url of exactly 32 bytes. Verify-only. Cannot mint. */
export function isRawEd25519PublicKey(value: string): boolean {
  const raw = decodeB64Url(value);
  return raw !== null && raw.length === 32;
}

function pkcs8Seed(value: string): Buffer | null {
  const der = decodeB64Url(value);
  if (!der || der.length !== ED25519_PKCS8_PREFIX.length + 32) return null;
  if (!der.subarray(0, ED25519_PKCS8_PREFIX.length).equals(ED25519_PKCS8_PREFIX)) return null;
  return der;
}

function publicKeyFromRaw(b64url: string): KeyObject {
  const raw = Buffer.from(b64url, 'base64url');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function privateKeyFromPkcs8(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function privateKeyFromSeed(seed: string): KeyObject {
  const seed32 = createHash('sha256').update(`${SEED_DOMAIN}${seed}`, 'utf8').digest();
  return privateKeyFromPkcs8(Buffer.concat([ED25519_PKCS8_PREFIX, seed32]));
}

function rawPublicOf(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
}

/**
 * Public key for a signing key. A raw public key is returned as itself.
 * A PKCS8 private key or a test seed (32+ characters, not a public key) yields
 * the matching public key. Production edge uses PKCS8; tests keep a shared
 * string that derives the same pair on both sides.
 */
export function edgePrincipalPublicKeyOf(material: string): string {
  if (isRawEd25519PublicKey(material)) return material;
  const pkcs8 = pkcs8Seed(material);
  if (pkcs8) return rawPublicOf(createPublicKey(privateKeyFromPkcs8(pkcs8)));
  if (material.length >= MIN_SECRET_LENGTH) return rawPublicOf(createPublicKey(privateKeyFromSeed(material)));
  throw new EdgeTrustError('edge principal key is not a public key, a PKCS8 private key, or a test seed of at least 32 characters');
}

function signingKey(material: string): KeyObject {
  if (isRawEd25519PublicKey(material)) {
    throw new EdgeTrustError(
      'a raw Ed25519 public key cannot mint a user principal. Only svc-edge holds EDGE_PRINCIPAL_PRIVATE_KEY.',
    );
  }
  const pkcs8 = pkcs8Seed(material);
  if (pkcs8) return privateKeyFromPkcs8(pkcs8);
  if (material.length >= MIN_SECRET_LENGTH) return privateKeyFromSeed(material);
  throw new EdgeTrustError('edge principal signing key is missing or shorter than 32 characters');
}

function verifyingKey(material: string): KeyObject | null {
  try {
    if (isRawEd25519PublicKey(material)) return publicKeyFromRaw(material);
    const pkcs8 = pkcs8Seed(material);
    if (pkcs8) return createPublicKey(privateKeyFromPkcs8(pkcs8));
    if (material.length >= MIN_SECRET_LENGTH) return createPublicKey(privateKeyFromSeed(material));
    return null;
  } catch {
    return null;
  }
}

function principalPreimage(raw: string, region: string): Buffer {
  return Buffer.from(`${raw}\nregion=${region}`, 'utf8');
}

function regionPreimage(region: string): Buffer {
  return Buffer.from(`intafaced-region-v1\nregion=${region}`, 'utf8');
}

function ed25519Sign(message: Buffer, material: string): string {
  return sign(null, message, signingKey(material)).toString('base64url');
}

function ed25519Ok(message: Buffer, signature: string, material: string): boolean {
  const key = verifyingKey(material);
  const sig = decodeB64Url(signature);
  if (!key || !sig || sig.length !== 64) return false;
  try {
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/**
 * Ed25519 over the raw header bytes and the region.
 *
 * Over the RAW STRING, not over a re-serialised object: JSON key order is not
 * canonical, so signing a parsed-and-restringified value would verify a
 * different byte sequence than the one that arrived. Region is in the
 * preimage so a free `x-intafaced-region` header cannot pick a jurisdiction.
 *
 * `key` is the PKCS8 private key (base64url) or a test seed. A raw public key
 * throws: holding it must not mint.
 */
export function signPrincipalHeader(raw: string, key: string, region = 'XX'): string {
  return ed25519Sign(principalPreimage(raw, region), key);
}

/**
 * Signature over the region alone, for a proxied request that has no user.
 * The same key as {@link signPrincipalHeader}. Receivers trust
 * `x-intafaced-region` only when this verifies, or when a principal signature
 * covers that region.
 */
export function signRegionAttestation(region: string, key: string): string {
  return ed25519Sign(regionPreimage(region), key);
}

export function regionAttestationOk(signature: string | undefined, region: string, key: string): boolean {
  if (!signature || !region) return false;
  return ed25519Ok(regionPreimage(region), signature, key);
}

/** Headers a service may copy onto the next hop. Undefined when edge did not sign. */
export function forwardedPrincipalHeaders(forwarded: ForwardedPrincipal | undefined): Record<string, string> | undefined {
  if (!forwarded) return undefined;
  return {
    [EDGE_PRINCIPAL_HEADER]: forwarded.raw,
    [EDGE_SIGNATURE_HEADER]: forwarded.signature,
    'x-intafaced-region': forwarded.region,
  };
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
  key: string,
  now: Date = new Date(),
  region = 'XX',
): EdgeVerifyResult {
  if (!raw) return { principal: null, rejected: null };
  if (!signature) return { principal: null, rejected: 'bad-signature' };
  if (!ed25519Ok(principalPreimage(raw, region), signature, key)) return { principal: null, rejected: 'bad-signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { principal: null, rejected: 'malformed' };
  }

  const result = principalHeaderSchema.safeParse(parsed);
  if (!result.success) return { principal: null, rejected: 'malformed' };

  const { expiresAt: expiresAtIso, iat, exp, ...claims } = result.data;
  if (exp - iat > PRINCIPAL_MAX_TTL_SECONDS) return { principal: null, rejected: 'malformed' };

  const expiresAt = new Date(expiresAtIso);
  const effectiveMs = Math.min(expiresAt.getTime(), exp * 1000);
  // A signature proves the edge said it; it does not prove the edge said it
  // recently. `exp` is the cap (300s). A captured header dies with it.
  if (effectiveMs <= now.getTime()) return { principal: null, rejected: 'expired' };

  return { principal: { ...claims, expiresAt: new Date(effectiveMs) }, rejected: null };
}

export interface EdgeContextOptions {
  /**
   * Verify material. A test seed (32+ characters) or, when `publicKey` is
   * omitted, the same string tests have always passed. Production passes
   * {@link EdgeContextOptions.publicKey} and does not put a signing key here.
   */
  secret?: string;
  /**
   * Raw 32-byte Ed25519 public key, base64url. Verify only. Wins over `secret`.
   * A service that has this and not the private key cannot mint.
   */
  publicKey?: string;
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
function verifyMaterial(options: EdgeContextOptions): string {
  const pub = options.publicKey?.trim();
  if (pub) return pub;
  return options.secret ?? '';
}

export function createEdgeContext(options: EdgeContextOptions): (req: EdgeRequest) => Context {
  const material = verifyMaterial(options);
  const usable = isRawEd25519PublicKey(material) || pkcs8Seed(material) !== null || material.length >= MIN_SECRET_LENGTH;
  if (!usable) {
    throw new EdgeTrustError(
      `${options.serviceName}: EDGE_PRINCIPAL_PUBLIC_KEY (raw Ed25519, base64url) or a test seed of at least ${MIN_SECRET_LENGTH} characters is required to mount /trpc. ` +
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

    const raw = header(EDGE_PRINCIPAL_HEADER);
    const signature = header(EDGE_SIGNATURE_HEADER);
    const headerRegion = header('x-intafaced-region');
    // Region is trusted only when edge's signature covers it. An unsigned
    // header used to drive publicJurisdictionProcedure. It does not now.
    let region = 'XX';
    let principal: Context['principal'] = null;
    let forwardedPrincipal: ForwardedPrincipal | undefined;
    if (raw) {
      const claimed = headerRegion ?? 'XX';
      const verified = verifyForwardedPrincipal(raw, signature, material, new Date(), claimed);
      if (verified.principal && signature) {
        principal = verified.principal;
        region = claimed;
        forwardedPrincipal = { raw, signature, region: claimed };
      }
    } else if (headerRegion && regionAttestationOk(signature, headerRegion, material)) {
      region = headerRegion;
    }

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
    const service = options.internalSecret
      ? verifyServiceHeaders(req.headers, options.internalSecret, {
          rawBody: inboundRawBodyOf(req),
          mode: options.bodyBindMode ?? EDGE_CONTEXT_BODY_BIND_MODE,
        }).service
      : null;

    return {
      principal,
      service,
      region,
      requestId: String(req.id ?? ''),
      ...(traceparent ? { traceparent } : {}),
      ...(forwardedPrincipal ? { forwardedPrincipal } : {}),
    };
  };
}
