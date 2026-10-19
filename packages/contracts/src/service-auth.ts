import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';

/**
 * SERVICE-TO-SERVICE AUTHENTICATION (§2, §9).
 *
 * Distinct from the edge principal, and needed for a different reason.
 *
 * `packages/auth` deliberately has no `ledger:write` scope: a user token must
 * never be able to move value directly. svc-ledger's `post` documented that as
 * the reason it was safe —
 *
 *     "there is no user-facing write ... which is why packages/auth has no
 *      ledger:write scope at all"
 *
 * — and then declared `post` a `publicProcedure`. The reasoning is inverted.
 * `publicProcedure` does not check a scope, so the ABSENCE of `ledger:write`
 * protects nothing; it just means there is no scope left to check. Every one of
 * the six services calling svc-ledger over HTTP sent `content-type` and nothing
 * else, so there was no credential to verify either.
 *
 * The consequence, once svc-ledger is mounted: anyone who can reach the port
 * posts a balanced two-entry transaction crediting `railBoundary` (a `treasury`
 * account, and treasury is the one owner type allowed to run negative) and
 * debiting their own `available`. That is the `deposit` recipe. Every invariant
 * passes — sum-to-zero, non-negative, paired locks — because the transaction is
 * genuinely well-formed. It is simply not authorised, and nothing was asking.
 *
 * So callers now prove which service they are.
 *
 * ── L2-6: the body IS signed now. What changed, and why ──────────────────────
 *
 * The first cut signed `${service}\n${timestamp}` and NOT the request body. It
 * said so, and said why: body signing needs the raw bytes at verification time,
 * and Fastify has already parsed and discarded them by the time a handler or a
 * tRPC context runs. That deferral was the right call in a hurry; it was also a
 * real hole. Within the 300-second window a captured signature was replayable
 * against **any body on any procedure of that service** — and the S2S surfaces
 * include svc-ledger's `/trpc/post` and svc-matching's order writes, so a
 * replayable signature was a replayable money instruction.
 *
 * Two schemes therefore exist, and exactly two:
 *
 *   **v1 (legacy)**  preimage `${service}\n${timestamp}`.
 *                    No body digest header. Kept only so the fleet can be
 *                    redeployed one service at a time. Provides identity and a
 *                    replay bound; provides NO body integrity.
 *
 *   **v2**           preimage per `serviceCallPreimage` below, over
 *                    (service, timestamp, sha256(raw body)).
 *                    The digest travels in `SERVICE_BODY_DIGEST_HEADER`, and its
 *                    PRESENCE is the version marker. There is no fourth
 *                    "version" header, because a header whose only content is a
 *                    restatement of another header's presence is one more thing
 *                    to keep in sync for no gain.
 *
 * ── Why length-prefixing rather than another newline ─────────────────────────
 *
 * v1 used a newline so `('ab', 1)` and `('a', 11)` could not share a preimage.
 * With three fields that reasoning gets thinner: `service` is entirely
 * caller-controlled and may contain a newline, so a bare `\n` join is injective
 * only because of validation living elsewhere in this file — the timestamp must
 * parse as an integer, the digest must be 64 hex characters. That is an
 * invariant held at a distance. One relaxed validator, or one added field, and
 * the framing silently stops being unambiguous.
 *
 * So each field is length-prefixed (`<byteLength>:<value>\n`). The encoding is
 * injective on its own terms: no field's content can be read as a delimiter or
 * as part of a neighbouring field, whatever it contains. Byte length, not
 * character length, so a multi-byte service name cannot shift the frame.
 *
 * The scheme also carries a domain tag (`intafaced-s2s-v2`). That makes v1 and
 * v2 preimages disjoint by construction, which is what makes `accept-both` a
 * migration window rather than a second hole: a captured v1 signature can never
 * be reinterpreted as a v2 signature, or the reverse.
 *
 * ── The honest limit of `accept-both` ────────────────────────────────────────
 *
 * In `accept-both` a verifier still accepts a v1 call, so an active attacker who
 * captures a v2 call can strip the digest header and downgrade to v1 — regaining
 * exactly the replay this change closes. **`accept-both` buys a migration with
 * no outage. It does not buy body integrity.** The security property exists only
 * under `require`. `docs/decisions/s2s-body-bind.md` has the flip procedure and
 * the signal that says it is safe.
 *
 * Still recorded rather than hidden, and deliberately NOT in this change:
 *
 *   · **Per-service keypairs.** Every service shares one secret today, so any
 *     service can mint any other service's signature. Body binding does not help
 *     with that and neither does v2 framing. It is a key-distribution and
 *     rotation problem — different design, different blast radius — and it wants
 *     its own PR rather than being half-done alongside this one.
 *   · **Binding the method and path.** Body binding stops "any body"; it stops
 *     "any procedure" only narrowly, since two procedures can accept
 *     structurally similar bodies. Binding the request target is the completion
 *     and it is cheap in code — but it breaks the fleet the first time anything
 *     between two services rewrites a path, so it needs a survey of the proxy
 *     and mount topology first. The length-prefixed framing exists precisely so
 *     that adding a fourth field later is a clean `v3` and not a collision risk.
 */

export const SERVICE_HEADER = 'x-intafaced-service';
export const SERVICE_TIMESTAMP_HEADER = 'x-intafaced-service-ts';
export const SERVICE_SIGNATURE_HEADER = 'x-intafaced-service-sig';

/**
 * Hex sha256 of the exact request bytes. Its presence marks a v2 call.
 *
 * A caller with no body sends the digest of the empty body rather than omitting
 * this header — "there is no body" is then a signed statement, so a body cannot
 * be added to a call that had none.
 */
export const SERVICE_BODY_DIGEST_HEADER = 'x-intafaced-service-body';

/** How far out of date a service call may be. Bounds replay of a captured header. */
export const SERVICE_CALL_MAX_SKEW_SECONDS = 300;

const MIN_SECRET_LENGTH = 32;

/** Which preimage a call used. Reported so a verifier can count v1 traffic during the migration. */
export type ServiceAuthScheme = 'v1' | 'v2';

/**
 * How strictly a verifier enforces body binding.
 *
 * There are deliberately only two. A third mode that ignored the digest header
 * would look like a rollback lever and behave like an outage: once callers sign
 * v2 preimages, refusing to read the digest rejects every one of them. The
 * rollback here is `require` → `accept-both`, which cannot 401 anybody.
 */
export const SERVICE_BODY_BIND_MODES = ['accept-both', 'require'] as const;
export type ServiceBodyBindMode = (typeof SERVICE_BODY_BIND_MODES)[number];

/**
 * Default for every verifier that does not say otherwise.
 *
 * `accept-both`, not `require`, and that is a migration decision rather than a
 * security preference: services share one secret and are redeployed
 * independently, so a verifier defaulting to `require` would 401 every caller
 * still running the old build — which is the whole fleet, at the moment the
 * first service rolls.
 */
export const DEFAULT_SERVICE_BODY_BIND_MODE: ServiceBodyBindMode = 'accept-both';

const EMPTY_BODY = Buffer.alloc(0);

/** sha256 hex is 64 characters. A digest header of any other length is not one. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export class ServiceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceAuthError';
  }
}

function assertSecret(secret: string, context: string): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new ServiceAuthError(
      `${context}: INTERNAL_SERVICE_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ` +
        'Without it, service-to-service calls are unauthenticated and `ledger.post` accepts anyone (§2).',
    );
  }
}

/**
 * sha256 of the exact bytes a request carries, hex encoded.
 *
 * Over the RAW BYTES, never over a re-serialised object: JSON key order is not
 * canonical and neither is whitespace, so digesting a parsed-and-restringified
 * body would commit to a different byte sequence than the one that arrived. Same
 * rule `signPrincipalHeader` follows in `edge.ts`, for the same reason.
 *
 * No body digests as the empty body — a definite value, not an absent one.
 */
export function serviceBodyDigest(body?: string | Buffer | null): string {
  const hash = createHash('sha256');
  if (typeof body === 'string') hash.update(body, 'utf8');
  else hash.update(body ?? EMPTY_BODY);
  return hash.digest('hex');
}

/** `<byteLength>:<value>\n` — injective regardless of what `value` contains. */
export function lengthPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}\n`;
}

/** Domain tag. Makes v1 and v2 preimages disjoint by construction. */
const V2_DOMAIN = 'intafaced-s2s-v2';

/**
 * The v2 canonical string. Exported so a test can assert the framing directly
 * rather than only through a signature, and so a non-Node caller has one
 * unambiguous thing to reproduce.
 */
export function serviceCallPreimage(service: string, timestamp: number, bodyDigest: string): string {
  return `${V2_DOMAIN}\n${lengthPrefixed(service)}${lengthPrefixed(String(timestamp))}${lengthPrefixed(bodyDigest)}`;
}

/**
 * LEGACY (v1). Signs identity and freshness only — no body.
 *
 * Retained for the migration window, and to verify callers that have not been
 * redeployed. New call sites want `signServiceCallWithBody`.
 */
export function signServiceCall(service: string, secret: string, timestamp: number): string {
  assertSecret(secret, 'signServiceCall');
  // Newline-separated so ('ab', 1) and ('a', 'b1') cannot produce the same
  // preimage — a delimiter-free concatenation is forgeable across fields.
  return createHmac('sha256', secret).update(`${service}\n${timestamp}`, 'utf8').digest('hex');
}

/** v2. Signs identity, freshness, and a digest of the exact request bytes. */
export function signServiceCallWithBody(service: string, secret: string, timestamp: number, bodyDigest: string): string {
  assertSecret(secret, 'signServiceCallWithBody');
  return createHmac('sha256', secret)
    .update(serviceCallPreimage(service, timestamp, bodyDigest), 'utf8')
    .digest('hex');
}

export interface ServiceAuthHeaderOptions {
  /** Overridable only so a test can pin the skew window. */
  now?: Date | undefined;
}

/**
 * LEGACY (v1) headers: three, no body digest.
 *
 * Kept callable so a service that has not been updated still compiles and still
 * authenticates during the migration. **A new caller should not use this.** It
 * produces a signature that any party who captures it can replay against any
 * body on any procedure of the callee for the next 300 seconds.
 */
export function serviceAuthHeaders(service: string, secret: string, options: ServiceAuthHeaderOptions = {}): Record<string, string> {
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return {
    [SERVICE_HEADER]: service,
    [SERVICE_TIMESTAMP_HEADER]: String(timestamp),
    [SERVICE_SIGNATURE_HEADER]: signServiceCall(service, secret, timestamp),
  };
}

/**
 * v2 headers: four, binding the exact bytes in `body`.
 *
 * `body` is a REQUIRED positional rather than an optional field on the options
 * object, and that is the point. An optional `body` would let a caller that
 * meant to bind its payload pass an accidentally-`undefined` variable and get a
 * silently downgraded v1 signature back — a security regression that type-checks
 * and tests green. Here, "no body" has to be written as `''`.
 *
 * The caller must send **these exact bytes**. Serialise once and pass the same
 * value to both this function and the request: digesting `JSON.stringify(x)` and
 * then letting a client re-serialise `x` is the failure this comment exists to
 * prevent, and it presents as an intermittent 401.
 */
export function serviceAuthHeadersForBody(
  service: string,
  secret: string,
  body: string | Buffer,
  options: ServiceAuthHeaderOptions = {},
): Record<string, string> {
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const digest = serviceBodyDigest(body);
  return {
    [SERVICE_HEADER]: service,
    [SERVICE_TIMESTAMP_HEADER]: String(timestamp),
    [SERVICE_BODY_DIGEST_HEADER]: digest,
    [SERVICE_SIGNATURE_HEADER]: signServiceCallWithBody(service, secret, timestamp, digest),
  };
}

/**
 * Whether the raw request bytes were kept, and what they were.
 *
 * Three states matter, and two of them look identical if this is modelled as
 * `Buffer | undefined`:
 *
 *   `{ retained: true, bytes: <n> }`   the request carried a body
 *   `{ retained: true, bytes: <0> }`   the request carried no body, and we know
 *   `{ retained: false }`              nobody kept the bytes — we cannot tell
 *
 * The last must not be confused with "no body": "no body" verifies against the
 * empty digest, whereas "we did not look" has to fail closed under `require`.
 * See `raw-body.ts`.
 *
 * `unread: true` narrows the last state: retention IS installed on this instance
 * but the request announced a body (content-length, transfer-encoding) that no
 * parser kept — e.g. a `text/plain` POST, or a tRPC POST whose adapter parser
 * replaced the retaining one. We positively know a body exists and cannot digest
 * it, so an authentic v2 signature (which may well be the digest of the EMPTY
 * body, replayed) is refused in BOTH modes rather than waved through.
 */
export type ServiceRawBody = { retained: true; bytes: Buffer } | { retained: false; unread?: true };

export interface ServiceVerifyOptions {
  /**
   * The v2 digest header. `verifyServiceHeaders` reads it for you; pass it
   * explicitly only when the headers are not in hand.
   */
  bodyDigest?: string | undefined;
  /** The bytes this request actually carried, per `rawBodyOf`. */
  rawBody?: ServiceRawBody | undefined;
  /** Defaults to `accept-both`. */
  mode?: ServiceBodyBindMode | undefined;
  now?: Date | undefined;
}

export type ServiceRejectReason =
  | 'missing'
  | 'bad-signature'
  | 'stale'
  /** Authentic signature, but the bytes on the wire are not the bytes that were signed. */
  | 'body-mismatch'
  /** Authentic v1 caller under `require` — it has not been redeployed yet. */
  | 'missing-body-digest'
  /** Authentic v2 caller under `require`, but this verifier never kept the bytes. Our bug, not theirs. */
  | 'body-unavailable';

export interface ServiceVerifyResult {
  service: string | null;
  rejected: ServiceRejectReason | null;
  /**
   * Which scheme an accepted call used; `null` when nothing was accepted.
   *
   * This is the migration instrument. A verifier logs `scheme === 'v1'` accepts
   * with the caller's name, and "that log has gone quiet for every caller" is
   * what turns flipping to `require` into a decision rather than a gamble.
   */
  scheme: ServiceAuthScheme | null;
}

/**
 * Constant-time hex comparison.
 *
 * Length checked separately: `timingSafeEqual` THROWS on a length mismatch, and
 * an exception here would be an unauthenticated caller crashing a request
 * handler. Non-hex is rejected on the way in because `Buffer.from('zz','hex')`
 * silently yields an empty buffer, and two empty buffers compare equal.
 *
 * Only `actual` is shape-checked — `expected` always comes from `digest('hex')`.
 */
function hexEquals(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  if (!/^[0-9a-f]+$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Verify a service caller. Fails closed: any problem yields `service: null`,
 * never a partially-trusted caller.
 *
 * Order is load-bearing. Freshness is checked before the signature so a captured
 * header stops working even though its signature stays valid forever; and every
 * body-binding decision happens strictly AFTER the signature verifies, so a
 * policy reason like `missing-body-digest` always describes an authenticated
 * caller that needs redeploying and never an anonymous one probing the port. An
 * anonymous caller only ever sees `missing`, `stale` or `bad-signature`.
 */
export function verifyServiceCall(
  service: string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  options: ServiceVerifyOptions = {},
): ServiceVerifyResult {
  const mode = options.mode ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  const now = options.now ?? new Date();
  const rawBody: ServiceRawBody = options.rawBody ?? { retained: false };
  const { bodyDigest } = options;

  const reject = (rejected: ServiceRejectReason): ServiceVerifyResult => ({ service: null, rejected, scheme: null });

  if (!service || !timestamp || !signature) return reject('missing');

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return reject('missing');

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (skew > SERVICE_CALL_MAX_SKEW_SECONDS) return reject('stale');

  // Presence of the digest header IS the scheme marker.
  const scheme: ServiceAuthScheme = bodyDigest === undefined ? 'v1' : 'v2';

  // A malformed digest is a forgery attempt rather than a body mismatch: the
  // digest sits inside the signed preimage, so a well-formed caller cannot
  // produce one.
  if (bodyDigest !== undefined && !DIGEST_PATTERN.test(bodyDigest)) return reject('bad-signature');

  const expected =
    bodyDigest === undefined ? signServiceCall(service, secret, ts) : signServiceCallWithBody(service, secret, ts, bodyDigest);

  if (!hexEquals(signature, expected)) return reject('bad-signature');

  // ── Authenticated. Everything below is body-binding policy. ────────────────

  if (bodyDigest === undefined) {
    // A v1 caller that genuinely holds the secret. Tolerated during the
    // migration, refused once an operator has flipped to `require`.
    return mode === 'require' ? reject('missing-body-digest') : { service, rejected: null, scheme };
  }

  if (!rawBody.retained) {
    // A body was announced on an instance that retains bodies, and nobody kept
    // it. The digest header is authentic but may be the digest of the empty body
    // replayed against this one (captured from any bodyless call). Never
    // accepted, whatever the mode: honest v2 callers sign their real bytes and
    // would have mismatched the empty digest anyway, so refusing costs nothing.
    if (rawBody.unread) return reject('body-unavailable');
    // The signature proves the digest header is authentic, so nothing was
    // tampered with in transit — but without the bytes we cannot prove the body
    // MATCHES that digest. Under `require` that is a deployment fault in this
    // service (retention not installed) and must be loud rather than silent.
    return mode === 'require' ? reject('body-unavailable') : { service, rejected: null, scheme };
  }

  // The check the whole change exists for. Enforced in BOTH modes: if we hold
  // the bytes and they disagree with what was signed, that is an attack, and
  // waiting for a config flag to say so would be absurd.
  if (!hexEquals(serviceBodyDigest(rawBody.bytes), bodyDigest)) return reject('body-mismatch');

  return { service, rejected: null, scheme };
}

/** Read a header that may arrive repeated. */
export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function verifyServiceHeaders(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options: ServiceVerifyOptions = {},
): ServiceVerifyResult {
  return verifyServiceCall(
    headerValue(headers, SERVICE_HEADER),
    headerValue(headers, SERVICE_TIMESTAMP_HEADER),
    headerValue(headers, SERVICE_SIGNATURE_HEADER),
    secret,
    { ...options, bodyDigest: options.bodyDigest ?? headerValue(headers, SERVICE_BODY_DIGEST_HEADER) },
  );
}

/**
 * Guard for a procedure that only another service may call.
 *
 * Throws UNAUTHORIZED — not FORBIDDEN — because the caller has not identified
 * itself at all. A service that IS authenticated but not permitted would be a
 * different answer, and the two must stay distinguishable to a caller.
 */
export function requireServiceCaller(service: string | null): asserts service is string {
  if (!service) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This procedure is callable only by another INTAFACED service with valid service credentials (§2)',
    });
  }
}
