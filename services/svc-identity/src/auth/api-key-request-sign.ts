/**
 * Per-key inbound HMAC. The canonical string matches
 * svc-edge `api-key-request-sign.ts` (locked by the vector test).
 *
 * On by default for a key that may place orders (`trade:write`, DV-auth-01: `developer-keys.ts`); any other key
 * opts in. The timestamp window is the owner's `IDENTITY_REQUEST_SIGN_WINDOW_SECONDS`: blank, every signed request
 * refuses `auth.request_window_unset`. Empty IP allowlist stays open until the key opts into
 * "require non-empty IP allowlist". The signing secret is returned once.
 * A missing secret on a key that requires a signature refuses.
 * A nonce is kept until the signed timestamp plus the acceptance window, so a
 * skewed client clock cannot forget it while that signature is still acceptable.
 * The signing secret is stored as enc:v1 ciphertext. A catch-all allowlist
 * (0.0.0.0/0 or ::/0) does not satisfy "require non-empty IP allowlist".
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { AuthError, type AuthService } from './auth-service.js';
import { REQUEST_SIGN_VERSION, type RequestSigningPolicy } from '@intafaced/contracts/api-keys';
import { signsByDefault } from './api-key-signs-by-default.js';
import { hashToken } from './passwords.js';
import { decryptAtRest, encryptAtRest, TOTP_SECRET_ENC_PREFIX } from './totp-crypto.js';

export { REQUEST_SIGN_VERSION };

/** The longest window the service will run with: a signed request older than an hour is never fresh. */
export const REQUEST_SIGN_WINDOW_MAX_SECONDS = 3600;

/**
 * `IDENTITY_REQUEST_SIGN_WINDOW_SECONDS`: the owner's timestamp window, whole seconds from 1 to 3600. Blank: null,
 * and every signed request refuses `auth.request_window_unset`. Anything else throws, so the service does not start
 * on a window it cannot read.
 */
export function parseRequestSignWindow(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const seconds = /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > REQUEST_SIGN_WINDOW_MAX_SECONDS) {
    throw new Error(`IDENTITY_REQUEST_SIGN_WINDOW_SECONDS must be whole seconds from 1 to ${REQUEST_SIGN_WINDOW_MAX_SECONDS}`);
  }
  return seconds;
}

/**
 * Why a signature check refused. `stale`: signed longer ago than the window. `future`: signed further ahead of the
 * server's clock than the window (the caller's clock runs fast). Each has its own code so a signer can tell which
 * way its clock is off.
 */
export type RequestSignReason = 'unsigned' | 'stale' | 'future' | 'tampered' | 'replay' | 'window_unset' | 'ip_allowlist_required';

export interface RequestSignMaterial {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly signature: string;
}

export const requestSignWireSchema = z.object({
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(2048),
  timestamp: z.string().min(1).max(32),
  nonce: z.string().min(8).max(128),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/i),
  signature: z.string().regex(/^[0-9a-f]{64}$/i),
});

export const requestSignAls = new AsyncLocalStorage<RequestSignMaterial | undefined>();

export class ApiKeyRequestSignError extends Error {
  constructor(
    message: string,
    readonly reason:
      | RequestSignReason
      | 'auth.not_found'
      | 'auth.not_configured'
      | 'auth.signature_not_required'
      | 'auth.signing_change_unset'
      | 'auth.signing_required',
  ) {
    super(message);
    this.name = 'ApiKeyRequestSignError';
  }
}

type KeySignRow = {
  id: string;
  require_signature: boolean;
  require_non_empty_ip_allowlist: boolean;
  request_signing_secret: string | null;
  ip_allowlist: string[] | null;
  expires_at: Date | null;
};

export function hashBody(body: Buffer | string | Uint8Array | null | undefined): string {
  const bytes = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
}): string {
  return [REQUEST_SIGN_VERSION, input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.bodyHash].join('\n');
}

export function signRequest(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export function signaturesEqual(provided: string, expected: string): boolean {
  if (!/^[0-9a-f]+$/i.test(provided) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const left = Buffer.from(provided, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

const CATCH_ALL_ALLOWLIST = new Set(['0.0.0.0/0', '::/0']);

/** A catch-all route counts as empty: it does not restrict the caller. */
export function ipAllowlistEntryCounts(entry: string): boolean {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed) return false;
  return !CATCH_ALL_ALLOWLIST.has(trimmed);
}

export function ipAllowlistSatisfied(requireNonEmpty: boolean, allowlist: readonly string[] | null | undefined): boolean {
  if (!requireNonEmpty) return true;
  return (allowlist ?? []).some(ipAllowlistEntryCounts);
}

/**
 * Retain through the last second the signature could be acceptable under any window the service will run with
 * (age === REQUEST_SIGN_WINDOW_MAX_SECONDS), not only today's: an owner who widens the window on restart must not
 * turn an already-used nonce fresh again.
 */
export function nonceRetainUntil(signedAtSeconds: number): Date {
  return new Date((signedAtSeconds + REQUEST_SIGN_WINDOW_MAX_SECONDS + 1) * 1000);
}

function validPath(path: string): boolean {
  return path.startsWith('/') && path.length <= 2048 && !path.includes('://') && !/\s/.test(path);
}

function validNonce(nonce: string): boolean {
  return nonce.length >= 8 && nonce.length <= 128 && /^[A-Za-z0-9_-]+$/.test(nonce);
}

function timestampSeconds(timestamp: string): number | null {
  if (!/^\d{1,16}$/.test(timestamp)) return null;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds;
}

export interface NonceStore {
  /** `signedAt` is the client timestamp. Retention runs from that instant, not from server `now`. */
  consume(keyId: string, nonce: string, now: Date, signedAt?: Date): boolean | Promise<boolean>;
}

export async function assessRequestSignature(input: {
  readonly requireSignature: boolean;
  readonly secret: string | null | undefined;
  readonly material: RequestSignMaterial | null | undefined;
  readonly now: Date;
  readonly keyId: string;
  readonly nonceStore: NonceStore;
  /** The owner's window. Null refuses every signed request: freshness cannot be judged against an unset window. */
  readonly windowSeconds: number | null;
}): Promise<{ ok: true } | { ok: false; reason: Exclude<RequestSignReason, 'ip_allowlist_required'> }> {
  if (!input.requireSignature) return { ok: true };
  if (input.windowSeconds === null) return { ok: false, reason: 'window_unset' };
  const windowSeconds = input.windowSeconds;
  const material = input.material;
  if (!input.secret || !material?.signature || !material.timestamp || !material.nonce) {
    return { ok: false, reason: 'unsigned' };
  }
  if (
    !validPath(material.path) ||
    !validNonce(material.nonce) ||
    !/^[0-9a-f]{64}$/i.test(material.bodyHash) ||
    !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(material.method.toUpperCase())
  ) {
    return { ok: false, reason: 'tampered' };
  }
  const signedAt = timestampSeconds(material.timestamp);
  const expected = signRequest(
    input.secret,
    canonicalRequest({
      method: material.method,
      path: material.path,
      timestamp: material.timestamp,
      nonce: material.nonce,
      bodyHash: material.bodyHash,
    }),
  );
  if (signedAt === null || !signaturesEqual(material.signature, expected)) {
    return { ok: false, reason: signedAt === null ? 'stale' : 'tampered' };
  }
  const ahead = signedAt - Math.floor(input.now.getTime() / 1000);
  if (-ahead > windowSeconds) return { ok: false, reason: 'stale' };
  if (ahead > windowSeconds) return { ok: false, reason: 'future' };
  const fresh = await input.nonceStore.consume(input.keyId, material.nonce, input.now, new Date(signedAt * 1000));
  if (!fresh) return { ok: false, reason: 'replay' };
  return { ok: true };
}

export function postgresNonceStore(sql: Sql): NonceStore {
  return {
    async consume(keyId, nonce, now, signedAt = now) {
      const expiresAt = nonceRetainUntil(Math.floor(signedAt.getTime() / 1000));
      await sql`DELETE FROM api_key_request_nonces WHERE expires_at <= ${now}`;
      const inserted = await sql<Array<{ nonce: string }>>`
        INSERT INTO api_key_request_nonces (key_id, nonce, seen_at, expires_at)
        VALUES (${keyId}, ${nonce}, ${now}, ${expiresAt})
        ON CONFLICT (key_id, nonce) DO NOTHING
        RETURNING nonce
      `;
      return inserted.length > 0;
    },
  };
}

export function issueSigningSecret(): string {
  return `ifs_${randomBytes(32).toString('base64url')}`;
}

export function sealSigningSecret(encKey: Buffer | null, plaintext: string): string {
  if (!encKey) {
    throw new ApiKeyRequestSignError('API key signing is not configured', 'auth.not_configured');
  }
  return encryptAtRest(encKey, plaintext);
}

/** Ciphertext only. Plaintext at rest, a missing key, or a bad seal is treated as no secret. */
export function openSigningSecret(encKey: Buffer | null, stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith(TOTP_SECRET_ENC_PREFIX) || !encKey) return null;
  try {
    return decryptAtRest(encKey, stored);
  } catch {
    return null;
  }
}

/** The signed `request` body is the edge's observation. A public caller cannot supply it. */
export function assertEdgeSignedRequest(service: string | null, request: unknown): void {
  if (request == null) return;
  if (service !== 'svc-edge') {
    // Its own code: the caller forwarding request material is not the edge. That is a setup failure between
    // services, never a verdict on the developer's key, so the edge answers it as unavailable, not as a bad key.
    throw new AuthError('Request material may only come from the edge', 'auth.edge_unauthenticated');
  }
}

/**
 * Run `fn` in a transaction. When `sql` is already a transaction (a guarded API-key action hands one in)
 * it has no `begin`, so `fn` runs on it directly and commits or rolls back with the caller.
 */
export async function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (typeof (sql as { begin?: unknown }).begin === 'function') return (await sql.begin((tx) => fn(tx as unknown as Sql))) as T;
  return fn(sql);
}

export async function setApiKeyRequestSigning(
  sql: Sql,
  userId: string,
  keyId: string,
  input: { requireSignature?: boolean; requireNonEmptyIpAllowlist?: boolean },
  encKey: Buffer | null,
  /** The owner's `API_KEY_SIGNING_OPTIONAL`. False (blank): a key that may place orders cannot turn signing off. */
  signingOptional = false,
): Promise<{
  id: string;
  requireSignature: boolean;
  requireNonEmptyIpAllowlist: boolean;
  signingSecret: string | null;
}> {
  if (input.requireSignature === undefined && input.requireNonEmptyIpAllowlist === undefined) {
    throw new ApiKeyRequestSignError('API key signing change is unset', 'auth.signing_change_unset');
  }
  return inTransaction(sql, async (tx) => {
    const current = await tx<
      Array<{
        id: string;
        request_signing_secret: string | null;
        require_signature: boolean;
        require_non_empty_ip_allowlist: boolean;
        scopes: string[];
      }>
    >`
      SELECT id, request_signing_secret, require_signature, require_non_empty_ip_allowlist, scopes FROM api_keys
      WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
      FOR UPDATE
    `;
    const row = current[0];
    if (!row) throw new ApiKeyRequestSignError('API key not found', 'auth.not_found');
    if (input.requireSignature === false && !signingOptional && signsByDefault(row.scopes)) {
      throw new ApiKeyRequestSignError('A key that places orders signs every request', 'auth.signing_required');
    }
    // Omitted means keep the stored flag. An IP-only write must not turn signing off or wipe the secret.
    const requireSignature = input.requireSignature ?? row.require_signature;
    const requireNonEmptyIpAllowlist = input.requireNonEmptyIpAllowlist ?? row.require_non_empty_ip_allowlist;
    let secret = row.request_signing_secret;
    let issued: string | null = null;
    if (input.requireSignature === undefined) {
      // Leave the stored secret alone, including when signing stays on.
    } else if (requireSignature) {
      if (!openSigningSecret(encKey, secret)) {
        issued = issueSigningSecret();
        secret = sealSigningSecret(encKey, issued);
      }
    } else {
      secret = null;
    }
    const updated = await tx<Array<{ id: string; require_signature: boolean; require_non_empty_ip_allowlist: boolean }>>`
      UPDATE api_keys
      SET require_signature = ${requireSignature},
          require_non_empty_ip_allowlist = ${requireNonEmptyIpAllowlist},
          request_signing_secret = ${secret}
      WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
      RETURNING id, require_signature, require_non_empty_ip_allowlist
    `;
    const out = updated[0];
    if (!out) throw new ApiKeyRequestSignError('API key not found', 'auth.not_found');
    return {
      id: out.id,
      requireSignature: out.require_signature,
      requireNonEmptyIpAllowlist: out.require_non_empty_ip_allowlist,
      signingSecret: issued,
    };
  });
}

/**
 * Replace the signing secret in one transaction. require_signature stays true,
 * so there is no moment where the key accepts an unsigned call.
 * The new secret is returned once. The caller must own the key.
 */
export async function rotateSigningSecret(
  sql: Sql,
  userId: string,
  keyId: string,
  encKey: Buffer | null,
): Promise<{ id: string; signingSecret: string }> {
  return inTransaction(sql, async (tx) => {
    const current = await tx<Array<{ id: string; require_signature: boolean }>>`
      SELECT id, require_signature FROM api_keys
      WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
      FOR UPDATE
    `;
    const row = current[0];
    if (!row) throw new ApiKeyRequestSignError('API key not found', 'auth.not_found');
    if (!row.require_signature) {
      throw new ApiKeyRequestSignError('API key does not require a signature', 'auth.signature_not_required');
    }
    const issued = issueSigningSecret();
    const stored = sealSigningSecret(encKey, issued);
    const updated = await tx<Array<{ id: string }>>`
      UPDATE api_keys
      SET request_signing_secret = ${stored},
          require_signature = true
      WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false AND require_signature = true
      RETURNING id
    `;
    const out = updated[0];
    if (!out) throw new ApiKeyRequestSignError('API key not found', 'auth.not_found');
    return { id: out.id, signingSecret: issued };
  });
}

async function loadKey(sql: Sql, key: string): Promise<KeySignRow | null> {
  const rows = await sql<KeySignRow[]>`
    SELECT id, require_signature, require_non_empty_ip_allowlist, request_signing_secret, ip_allowlist, expires_at
    FROM api_keys
    WHERE key_hash = ${hashToken(key)} AND revoked = false
  `;
  return rows[0] ?? null;
}

export async function decideApiKeyExchange(
  sql: Sql,
  key: string,
  material: RequestSignMaterial | null | undefined,
  now: Date,
  encKey: Buffer | null,
  windowSeconds: number | null,
): Promise<
  { ok: true; row: KeySignRow } | { ok: false; reason: RequestSignReason } | { ok: true; row: null } | { ok: false; expired: true }
> {
  const row = await loadKey(sql, key);
  if (!row) return { ok: true, row: null };
  // Expiry is judged here, on the same clock as the signature: an expired key is refused outright, so no clock
  // disagreement between this check and the key check can let a key that must sign mint a token unsigned.
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) return { ok: false, expired: true };
  if (!ipAllowlistSatisfied(row.require_non_empty_ip_allowlist, row.ip_allowlist)) {
    return { ok: false, reason: 'ip_allowlist_required' };
  }
  const verdict = await assessRequestSignature({
    requireSignature: row.require_signature,
    secret: openSigningSecret(encKey, row.request_signing_secret),
    material,
    now,
    keyId: row.id,
    // Without a window nothing is consumed: assessRequestSignature refuses before the nonce store is asked.
    nonceStore: postgresNonceStore(sql),
    windowSeconds,
  });
  if (!verdict.ok) return verdict;
  return { ok: true, row };
}

export type RequestSignRefusalCode =
  | 'auth.request_unsigned'
  | 'auth.request_stale'
  | 'auth.request_future'
  | 'auth.request_tampered'
  | 'auth.request_replay'
  | 'auth.request_window_unset'
  | 'auth.ip_allowlist_required';

/** The typed code a refused signature check answers with (DV-auth-01; the edge names each one). */
export function requestSignRefusalCode(reason: RequestSignReason): RequestSignRefusalCode {
  return reason === 'ip_allowlist_required' ? 'auth.ip_allowlist_required' : `auth.request_${reason}`;
}

const REFUSAL_MESSAGE: Record<RequestSignReason, string> = {
  unsigned: 'This key signs every request; the request carried no signature',
  stale: 'The request was signed longer ago than the timestamp window',
  future: 'The request is timestamped ahead of the server clock by more than the window',
  tampered: 'The signature does not match the request',
  replay: 'This nonce was already used inside the timestamp window',
  window_unset: 'The request-signing timestamp window is not set',
  ip_allowlist_required: 'This key requires an IP allowlist',
};

/**
 * Outermost exchange wrap. A key that requires a signature cannot mint a JWT without a fresh valid signature.
 * A refusal names its reason (stale, tampered, replay, unsigned) so the key holder can fix their signer. It is
 * reached only by a caller who presented a live key's full secret: an unknown, revoked or wrong key never gets here
 * (`loadKey` finds no row) and stays `auth.invalid_credentials`, so the reason confirms nothing a guesser lacks.
 */
export function installApiKeyRequestSignExchange(auth: AuthService, sql: Sql, encKey: Buffer | null, windowSeconds: number | null): void {
  const orig = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key: string, requestOrigin?: string | null) => {
    const verdict = await decideApiKeyExchange(sql, key, requestSignAls.getStore(), new Date(), encKey, windowSeconds);
    if (!verdict.ok) {
      if ('expired' in verdict) throw new AuthError('API key has expired', 'auth.api_key_expired');
      throw new AuthError(REFUSAL_MESSAGE[verdict.reason], requestSignRefusalCode(verdict.reason));
    }
    const issued = await orig(key, requestOrigin);
    if (!verdict.row) return issued;
    return {
      ...issued,
      requireSignature: verdict.row.require_signature,
      requireNonEmptyIpAllowlist: verdict.row.require_non_empty_ip_allowlist,
      ipAllowlist: verdict.row.ip_allowlist ?? [],
    };
  };
}

/** The published TEST vector's inputs. The secret signs nothing real: no key is ever minted with it. */
const TEST_VECTOR = {
  method: 'POST',
  path: '/api/v1/trade/orders',
  timestamp: '1767225600',
  nonce: 'test-vector-nonce-0001',
  body: '{"symbol":"TEST-USD","side":"buy","type":"limit","price":"1.00","quantity":"1"}',
  secret: 'ifs_TEST_published_vector_secret_signs_nothing_real',
} as const;

/**
 * The public signing policy: the owner's window (null while unset) and one request signed by this service's own
 * signer with the published TEST secret, so the page cannot drift from what the service checks.
 */
export function requestSigningPolicy(windowSeconds: number | null): RequestSigningPolicy {
  const bodySha256 = hashBody(TEST_VECTOR.body);
  const canonical = canonicalRequest({
    method: TEST_VECTOR.method,
    path: TEST_VECTOR.path,
    timestamp: TEST_VECTOR.timestamp,
    nonce: TEST_VECTOR.nonce,
    bodyHash: bodySha256,
  });
  return {
    version: REQUEST_SIGN_VERSION,
    windowSeconds,
    headers: {
      timestamp: 'x-intafaced-request-timestamp',
      nonce: 'x-intafaced-request-nonce',
      signature: 'x-intafaced-request-signature',
    },
    vector: { ...TEST_VECTOR, bodySha256, canonical, signature: signRequest(TEST_VECTOR.secret, canonical) },
  };
}
