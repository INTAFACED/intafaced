/**
 * Per-key opt-in inbound HMAC. The canonical string matches
 * svc-edge `api-key-request-sign.ts` (locked by the vector test).
 *
 * Default off. Empty IP allowlist stays open until the key opts into
 * "require non-empty IP allowlist". The signing secret is returned once.
 * A missing secret on a key that requires a signature refuses.
 * Nonces older than the 5-minute window are deleted on the next consume.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { AuthError, type AuthService } from './auth-service.js';
import { hashToken } from './passwords.js';

export const REQUEST_SIGN_VERSION = 'INTAFACED-REQ-V1';
export const REQUEST_SIGN_WINDOW_SECONDS = 300;

export type RequestSignReason = 'unsigned' | 'stale' | 'tampered' | 'replay' | 'ip_allowlist_required';

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
    readonly reason: RequestSignReason | 'auth.not_found',
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

export function ipAllowlistSatisfied(requireNonEmpty: boolean, allowlist: readonly string[] | null | undefined): boolean {
  if (!requireNonEmpty) return true;
  return (allowlist ?? []).some((entry) => entry.trim().length > 0);
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
  consume(keyId: string, nonce: string, now: Date): boolean | Promise<boolean>;
}

export async function assessRequestSignature(input: {
  readonly requireSignature: boolean;
  readonly secret: string | null | undefined;
  readonly material: RequestSignMaterial | null | undefined;
  readonly now: Date;
  readonly keyId: string;
  readonly nonceStore: NonceStore;
}): Promise<{ ok: true } | { ok: false; reason: Exclude<RequestSignReason, 'ip_allowlist_required'> }> {
  if (!input.requireSignature) return { ok: true };
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
  const age = Math.abs(Math.floor(input.now.getTime() / 1000) - signedAt);
  if (age > REQUEST_SIGN_WINDOW_SECONDS) return { ok: false, reason: 'stale' };
  const fresh = await input.nonceStore.consume(input.keyId, material.nonce, input.now);
  if (!fresh) return { ok: false, reason: 'replay' };
  return { ok: true };
}

export function postgresNonceStore(sql: Sql): NonceStore {
  return {
    async consume(keyId, nonce, now) {
      const cutoff = new Date(now.getTime() - REQUEST_SIGN_WINDOW_SECONDS * 1000);
      await sql`DELETE FROM api_key_request_nonces WHERE seen_at < ${cutoff}`;
      const inserted = await sql<Array<{ nonce: string }>>`
        INSERT INTO api_key_request_nonces (key_id, nonce, seen_at)
        VALUES (${keyId}, ${nonce}, ${now})
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

export async function setApiKeyRequestSigning(
  sql: Sql,
  userId: string,
  keyId: string,
  input: { requireSignature: boolean; requireNonEmptyIpAllowlist: boolean },
): Promise<{
  id: string;
  requireSignature: boolean;
  requireNonEmptyIpAllowlist: boolean;
  signingSecret: string | null;
}> {
  return sql.begin(async (tx) => {
    const current = await tx<Array<{ id: string; request_signing_secret: string | null }>>`
      SELECT id, request_signing_secret FROM api_keys
      WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
      FOR UPDATE
    `;
    const row = current[0];
    if (!row) throw new ApiKeyRequestSignError('API key not found', 'auth.not_found');
    let secret = row.request_signing_secret;
    let issued: string | null = null;
    if (input.requireSignature) {
      if (!secret) {
        secret = issueSigningSecret();
        issued = secret;
      }
    } else {
      secret = null;
    }
    const updated = await tx<Array<{ id: string; require_signature: boolean; require_non_empty_ip_allowlist: boolean }>>`
      UPDATE api_keys
      SET require_signature = ${input.requireSignature},
          require_non_empty_ip_allowlist = ${input.requireNonEmptyIpAllowlist},
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

async function loadKey(sql: Sql, key: string): Promise<KeySignRow | null> {
  const rows = await sql<KeySignRow[]>`
    SELECT id, require_signature, require_non_empty_ip_allowlist, request_signing_secret, ip_allowlist
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
): Promise<{ ok: true; row: KeySignRow } | { ok: false; reason: RequestSignReason } | { ok: true; row: null }> {
  const row = await loadKey(sql, key);
  if (!row) return { ok: true, row: null };
  if (!ipAllowlistSatisfied(row.require_non_empty_ip_allowlist, row.ip_allowlist)) {
    return { ok: false, reason: 'ip_allowlist_required' };
  }
  const verdict = await assessRequestSignature({
    requireSignature: row.require_signature,
    secret: row.request_signing_secret,
    material,
    now,
    keyId: row.id,
    nonceStore: postgresNonceStore(sql),
  });
  if (!verdict.ok) return verdict;
  return { ok: true, row };
}

/**
 * Outermost exchange wrap. A key that requires a signature cannot mint a JWT
 * without a fresh valid signature. The wire error stays invalid credentials
 * so a refusal does not confirm that the key exists.
 */
export function installApiKeyRequestSignExchange(auth: AuthService, sql: Sql): void {
  const orig = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key: string, requestOrigin?: string | null) => {
    const verdict = await decideApiKeyExchange(sql, key, requestSignAls.getStore(), new Date());
    if (!verdict.ok) {
      throw new AuthError('Invalid credentials', 'auth.invalid_credentials');
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
