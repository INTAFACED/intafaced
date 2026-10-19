import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { serviceBodyDigest, lengthPrefixed, type ServiceRawBody } from './service-auth.js';

/**
 * SERVICE-TO-SERVICE AUTHENTICATION, v3: one Ed25519 key pair per service.
 *
 * Every service signs its own calls and every receiver holds only the public
 * keyring, so a compromised receiver cannot sign as another service. The caller
 * is the owner of the key that verified, never a name a caller claims. This file
 * is the library: keyring, signer, verifier and nonce cache. Mounting it on a
 * server and declaring each route's allowed callers is separate work.
 */

/** Services that sign or receive S2S calls. blueprint, dex, indexer and protocol have no S2S role. */
export const SERVICE_NAMES = [
  'svc-academy',
  'svc-agents',
  'svc-bank',
  'svc-edge',
  'svc-execution',
  'svc-fix',
  'svc-identity',
  'svc-ledger',
  'svc-market',
  'svc-matching',
  'svc-mining-pool',
  'svc-notify',
  'svc-ops',
  'svc-p2p',
  'svc-pay',
  'svc-quant',
  'svc-support',
  'svc-tax',
  'svc-token',
  'svc-trade',
  'svc-ws',
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export type KeyUse = 's2s' | 'principal';
export interface KeyringEntry {
  /** `<service>.<label>`, so a key id always names its owner. */
  readonly kid: string;
  readonly svc: ServiceName;
  readonly use: KeyUse;
  /** Raw 32-byte Ed25519 public key, canonical base64url. */
  readonly x: string;
}
export type Keyring = readonly KeyringEntry[];

export const S2S_KID_HEADER = 'x-intafaced-s2s-kid';
export const S2S_AUDIENCE_HEADER = 'x-intafaced-s2s-aud';
export const S2S_TIMESTAMP_HEADER = 'x-intafaced-s2s-ts';
export const S2S_NONCE_HEADER = 'x-intafaced-s2s-nonce';
export const S2S_BODY_HEADER = 'x-intafaced-s2s-body';
export const S2S_SIGNATURE_HEADER = 'x-intafaced-s2s-sig';
const V3_HEADERS = [
  S2S_KID_HEADER,
  S2S_AUDIENCE_HEADER,
  S2S_TIMESTAMP_HEADER,
  S2S_NONCE_HEADER,
  S2S_BODY_HEADER,
  S2S_SIGNATURE_HEADER,
] as const;

const PRINCIPAL_HEADER = 'x-intafaced-principal';
const PRINCIPAL_SIGNATURE_HEADER = 'x-intafaced-principal-sig';
const REGION_HEADER = 'x-intafaced-region';
const CONTENT_TYPE_HEADER = 'content-type';

/** A call may be signed up to this long ago, and no further than this far ahead. */
export const S2S_PAST_SECONDS = 60;
export const S2S_FUTURE_SECONDS = 5;
const NONCE_TTL_PAST_SECONDS = S2S_PAST_SECONDS + 1;

const KID = /^[a-z0-9-]{1,40}\.[a-z0-9]{1,16}$/;
const PATTERNS: Record<(typeof V3_HEADERS)[number], RegExp> = {
  [S2S_KID_HEADER]: KID,
  [S2S_AUDIENCE_HEADER]: /^svc-[a-z0-9-]{1,40}$/,
  [S2S_TIMESTAMP_HEADER]: /^[1-9][0-9]{9,10}$/,
  [S2S_NONCE_HEADER]: /^[A-Za-z0-9_-]{22}$/,
  [S2S_BODY_HEADER]: /^[0-9a-f]{64}$/,
  [S2S_SIGNATURE_HEADER]: /^[A-Za-z0-9_-]{86}$/,
};
const MAX_KEYS_PER_SERVICE_AND_USE = 2;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DOMAIN = 'intafaced-s2s-v3\n';

export class ServiceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceKeyError';
  }
}

function isServiceName(value: unknown): value is ServiceName {
  return typeof value === 'string' && (SERVICE_NAMES as readonly string[]).includes(value);
}

/** Canonical base64url of exactly 32 bytes: decodes to 32 bytes and re-encodes to the same text. */
function isCanonicalKey(x: unknown): x is string {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
  const raw = Buffer.from(x, 'base64url');
  return raw.length === 32 && raw.toString('base64url') === x;
}

/** Parse the public keyring. It never accepts private material. Anything unexpected throws. */
export function parseKeyring(json: string): Keyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ServiceKeyError('S2S keyring is not valid JSON');
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new ServiceKeyError('S2S keyring must be {"keys":[...]}');
  const entries: KeyringEntry[] = [];
  const seenKids = new Set<string>();
  const perOwner = new Map<string, number>();
  for (const raw of keys) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ServiceKeyError('S2S keyring entry must be an object');
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((k) => !['kid', 'svc', 'use', 'x'].includes(k))) {
      throw new ServiceKeyError('S2S keyring entry has an unexpected field; private key material never belongs in the keyring');
    }
    if (!isServiceName(entry.svc)) throw new ServiceKeyError('S2S keyring entry names an unknown service');
    if (entry.use !== 's2s' && entry.use !== 'principal') throw new ServiceKeyError('S2S keyring entry use must be s2s or principal');
    if (typeof entry.kid !== 'string' || !KID.test(entry.kid) || !entry.kid.startsWith(`${entry.svc}.`)) {
      throw new ServiceKeyError('S2S key id must look like <service>.<label> and name its own service');
    }
    if (!isCanonicalKey(entry.x)) throw new ServiceKeyError('S2S public key must be canonical base64url of exactly 32 bytes');
    if (seenKids.has(entry.kid)) throw new ServiceKeyError('S2S keyring has a duplicate key id');
    seenKids.add(entry.kid);
    const owner = `${entry.svc}/${entry.use}`;
    const count = (perOwner.get(owner) ?? 0) + 1;
    if (count > MAX_KEYS_PER_SERVICE_AND_USE) throw new ServiceKeyError('S2S keyring allows at most two keys per service and use');
    perOwner.set(owner, count);
    entries.push({ kid: entry.kid, svc: entry.svc, use: entry.use, x: entry.x });
  }
  return entries;
}

function publicKeyObject(x: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(x, 'base64url')]), format: 'der', type: 'spki' });
}

/** The request headers a v3 signature commits to besides the body: who is acting for whom, where, and how. */
export interface ServiceSignedContext {
  readonly principal?: string;
  readonly principalSignature?: string;
  readonly region?: string;
  readonly contentType?: string;
}

function contextDigest(context: ServiceSignedContext): string {
  return createHash('sha256')
    .update(
      lengthPrefixed(context.principal ?? '') +
        lengthPrefixed(context.principalSignature ?? '') +
        lengthPrefixed(context.region ?? '') +
        lengthPrefixed(context.contentType ?? ''),
    )
    .digest('hex');
}

function preimage(f: {
  kid: string;
  aud: string;
  method: string;
  target: string;
  ts: string;
  nonce: string;
  body: string;
  ctx: string;
}): Buffer {
  return Buffer.from(
    DOMAIN + [f.kid, f.aud, f.method.toUpperCase(), f.target, f.ts, f.nonce, f.body, f.ctx].map(lengthPrefixed).join(''),
    'utf8',
  );
}

export interface ServiceSignInput {
  readonly audience: ServiceName;
  readonly method: string;
  readonly url: URL;
  readonly body?: string | Buffer | null;
  readonly context?: ServiceSignedContext;
}
export interface ServiceSigner {
  readonly service: ServiceName;
  readonly kid: string;
  headers(input: ServiceSignInput): Record<string, string>;
}

export interface ServiceSignerOptions {
  readonly service: ServiceName;
  readonly kid: string;
  /** PKCS8 private key, base64url (the format `generateEdgePrincipalKeyPair` produces). */
  readonly privateKey: string;
  readonly keyring: Keyring;
  readonly now?: () => Date;
}

/** Refuses to build unless the private key is the one the keyring publishes for this service and key id. */
export function createServiceSigner(options: ServiceSignerOptions): ServiceSigner {
  const entry = options.keyring.find((k) => k.kid === options.kid);
  if (!entry || entry.svc !== options.service || entry.use !== 's2s') {
    throw new ServiceKeyError(`${options.service}: no s2s key ${options.kid} for this service in the keyring`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(options.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new ServiceKeyError(`${options.service}: S2S private key is not a PKCS8 Ed25519 key, base64url`);
  }
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || Buffer.from(derived.subarray(-32)).toString('base64url') !== entry.x) {
    throw new ServiceKeyError(`${options.service}: S2S private key does not match the published key ${options.kid}`);
  }
  const clock = options.now ?? (() => new Date());
  return {
    service: options.service,
    kid: options.kid,
    headers(input) {
      const ts = String(Math.floor(clock().getTime() / 1000));
      const nonce = randomBytes(16).toString('base64url');
      const body = serviceBodyDigest(input.body);
      const target = input.url.pathname + input.url.search;
      const signature = sign(
        null,
        preimage({
          kid: options.kid,
          aud: input.audience,
          method: input.method,
          target,
          ts,
          nonce,
          body,
          ctx: contextDigest(input.context ?? {}),
        }),
        key,
      ).toString('base64url');
      return {
        [S2S_KID_HEADER]: options.kid,
        [S2S_AUDIENCE_HEADER]: input.audience,
        [S2S_TIMESTAMP_HEADER]: ts,
        [S2S_NONCE_HEADER]: nonce,
        [S2S_BODY_HEADER]: body,
        [S2S_SIGNATURE_HEADER]: signature,
      };
    },
  };
}

export interface NonceCache {
  /** Remember `key` until `expiresAtSeconds`. Never evicts a live entry to make room. */
  add(key: string, expiresAtSeconds: number, nowSeconds: number): 'ok' | 'replay' | 'full';
  size(): number;
}

/** In-memory replay cache. Sound only while one process serves each service (see the S2S plan). */
export function createNonceCache(options: { maxEntries?: number } = {}): NonceCache {
  const max = options.maxEntries ?? 100_000;
  const entries = new Map<string, number>();
  return {
    add(key, expiresAtSeconds, nowSeconds) {
      for (const [k, expiry] of entries) if (expiry <= nowSeconds) entries.delete(k);
      if (entries.has(key)) return 'replay';
      if (entries.size >= max) return 'full';
      entries.set(key, expiresAtSeconds);
      return 'ok';
    },
    size: () => entries.size,
  };
}

export type ServiceRejectReasonV3 =
  | 'malformed'
  | 'wrong-audience'
  | 'unknown-key'
  | 'stale'
  | 'bad-signature'
  | 'body-mismatch'
  | 'body-unavailable'
  | 'replay'
  | 'replay-cache-full';

export type ServiceVerifyResultV3 =
  { status: 'absent' } | { status: 'accepted'; service: ServiceName; kid: string } | { status: 'rejected'; reason: ServiceRejectReasonV3 };

export interface ServiceVerifyRequest {
  readonly method: string;
  /** The raw request target as received: path and query. */
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: ServiceRawBody;
}

export interface ServiceVerifierOptions {
  readonly self: ServiceName;
  readonly keyring: Keyring;
  readonly nonce?: NonceCache;
  readonly now?: () => Date;
  /** Calls signed before this second are refused, so a restart cannot reopen a cleared replay cache. */
  readonly bootSecond?: number;
}
export interface ServiceVerifier {
  verify(request: ServiceVerifyRequest): ServiceVerifyResultV3;
}

function single(headers: ServiceVerifyRequest['headers'], name: string): string | null | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/**
 * Verify one request against the v3 scheme. It reports `absent` only when the
 * request carries none of the six headers (a user or anonymous request); any
 * partial or invalid set is rejected, never ignored. Fails closed on every step.
 */
export function createServiceVerifier(options: ServiceVerifierOptions): ServiceVerifier {
  const clock = options.now ?? (() => new Date());
  const nonce = options.nonce ?? createNonceCache();
  const bootSecond = options.bootSecond ?? Math.floor(clock().getTime() / 1000);
  const keys = new Map<string, { svc: ServiceName; key: KeyObject }>();
  for (const entry of options.keyring) if (entry.use === 's2s') keys.set(entry.kid, { svc: entry.svc, key: publicKeyObject(entry.x) });
  const reject = (reason: ServiceRejectReasonV3): ServiceVerifyResultV3 => ({ status: 'rejected', reason });

  return {
    verify(request) {
      const present = V3_HEADERS.filter((h) => request.headers[h] !== undefined);
      if (present.length === 0) return { status: 'absent' };

      const values = {} as Record<(typeof V3_HEADERS)[number], string>;
      for (const name of V3_HEADERS) {
        const value = single(request.headers, name);
        if (typeof value !== 'string' || !PATTERNS[name].test(value)) return reject('malformed');
        values[name] = value;
      }
      if (values[S2S_AUDIENCE_HEADER] !== options.self) return reject('wrong-audience');
      const known = keys.get(values[S2S_KID_HEADER]);
      if (!known) return reject('unknown-key');

      const nowSeconds = Math.floor(clock().getTime() / 1000);
      const ts = Number(values[S2S_TIMESTAMP_HEADER]);
      if (ts < nowSeconds - S2S_PAST_SECONDS || ts > nowSeconds + S2S_FUTURE_SECONDS || ts < bootSecond) return reject('stale');

      const ctx = contextDigest({
        principal: single(request.headers, PRINCIPAL_HEADER) ?? undefined,
        principalSignature: single(request.headers, PRINCIPAL_SIGNATURE_HEADER) ?? undefined,
        region: single(request.headers, REGION_HEADER) ?? undefined,
        contentType: single(request.headers, CONTENT_TYPE_HEADER) ?? undefined,
      });
      const ok = verify(
        null,
        preimage({
          kid: values[S2S_KID_HEADER],
          aud: values[S2S_AUDIENCE_HEADER],
          method: request.method,
          target: request.url,
          ts: values[S2S_TIMESTAMP_HEADER],
          nonce: values[S2S_NONCE_HEADER],
          body: values[S2S_BODY_HEADER],
          ctx,
        }),
        known.key,
        Buffer.from(values[S2S_SIGNATURE_HEADER], 'base64url'),
      );
      if (!ok) return reject('bad-signature');

      if (!request.rawBody.retained) return reject('body-unavailable');
      if (serviceBodyDigest(request.rawBody.bytes) !== values[S2S_BODY_HEADER]) return reject('body-mismatch');

      const outcome = nonce.add(`${values[S2S_KID_HEADER]}|${values[S2S_NONCE_HEADER]}`, ts + NONCE_TTL_PAST_SECONDS, nowSeconds);
      if (outcome === 'replay') return reject('replay');
      if (outcome === 'full') return reject('replay-cache-full');
      return { status: 'accepted', service: known.svc, kid: values[S2S_KID_HEADER] };
    },
  };
}
