/**
 * Inbound API-key request signature (opt-in, per key).
 *
 * Canonical string v1, UTF-8, no trailing newline:
 *   INTAFACED-REQ-V1\n
 *   METHOD\n
 *   PATH\n
 *   TIMESTAMP\n
 *   NONCE\n
 *   BODY_SHA256
 *
 * METHOD is uppercase. PATH is the absolute path plus query as the edge
 * received it (no scheme, no host). TIMESTAMP is unix seconds. NONCE is
 * unique per key inside the window. BODY_SHA256 is lowercase hex of the raw
 * body (empty body hashes as empty bytes).
 *
 * HMAC-SHA256(secret, canonical) as lowercase hex. Compare with
 * timingSafeEqual after a length check. A catch-all allowlist (0.0.0.0/0 or
 * ::/0) does not satisfy a required IP allowlist.
 *
 * The live check is identity's (svc-identity `auth/api-key-request-sign.ts`):
 * the edge reads these headers and sends them with the key exchange, and
 * identity judges them inside the owner's window, which it publishes as
 * `requestSigningPolicy` (blank refuses `auth.request_window_unset`). The
 * verifier below, with its fixed window, is this module's reference for its
 * own tests, not the window a caller is held to.
 *
 * Unsigned is accepted only when the key has not opted in. A key that
 * requires a signature and has no secret refuses (fail closed).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const REQUEST_SIGN_VERSION = 'INTAFACED-REQ-V1';
/** The reference verifier's window (tests only). The live window is the owner's, from identity. */
export const REQUEST_SIGN_WINDOW_SECONDS = 300;

export const REQUEST_TIMESTAMP_HEADER = 'x-intafaced-request-timestamp';
export const REQUEST_NONCE_HEADER = 'x-intafaced-request-nonce';
export const REQUEST_SIGNATURE_HEADER = 'x-intafaced-request-signature';

export type RequestSignReason = 'unsigned' | 'stale' | 'tampered' | 'replay';

export interface RequestSignMaterial {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly signature: string;
}

export interface NonceStore {
  /** True when this key+nonce was not already inside the retention window. `signedAt` is the client timestamp. */
  consume(keyId: string, nonce: string, now: Date, signedAt?: Date): boolean | Promise<boolean>;
}

/** Retain through the last second the signature is still acceptable (age === window). */
export function nonceRetainUntil(signedAtSeconds: number): Date {
  return new Date((signedAtSeconds + REQUEST_SIGN_WINDOW_SECONDS + 1) * 1000);
}

export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  consume(keyId: string, nonce: string, now: Date, signedAt: Date = now): boolean {
    const cutoff = now.getTime();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= cutoff) this.seen.delete(id);
    }
    const id = `${keyId}\0${nonce}`;
    if (this.seen.has(id)) return false;
    const retainUntil = nonceRetainUntil(Math.floor(signedAt.getTime() / 1000)).getTime();
    this.seen.set(id, retainUntil);
    return true;
  }

  size(now: Date = new Date()): number {
    const cutoff = now.getTime();
    let n = 0;
    for (const expiresAt of this.seen.values()) {
      if (expiresAt > cutoff) n += 1;
    }
    return n;
  }
}

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

/** Constant-time on the decoded bytes. Length mismatch returns false and does not throw. */
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

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

export function readRequestSignHeaders(headers: Record<string, string | string[] | undefined>): {
  timestamp: string;
  nonce: string;
  signature: string;
} {
  return {
    timestamp: headerValue(headers, REQUEST_TIMESTAMP_HEADER),
    nonce: headerValue(headers, REQUEST_NONCE_HEADER),
    signature: headerValue(headers, REQUEST_SIGNATURE_HEADER),
  };
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

export async function assessRequestSignature(input: {
  readonly requireSignature: boolean;
  readonly secret: string | null | undefined;
  readonly material: RequestSignMaterial | null | undefined;
  readonly now: Date;
  readonly keyId: string;
  readonly nonceStore: NonceStore;
}): Promise<{ ok: true } | { ok: false; reason: RequestSignReason }> {
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
  const fresh = await input.nonceStore.consume(input.keyId, material.nonce, input.now, new Date(signedAt * 1000));
  if (!fresh) return { ok: false, reason: 'replay' };
  return { ok: true };
}

export function optionalFlag(body: unknown, ...keys: string[]): boolean {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  return keys.some((key) => rec[key] === true);
}

export function optionalFlagFromExchange(body: unknown, ...keys: string[]): boolean {
  if (!body || typeof body !== 'object') return false;
  const envelope = body as { result?: { data?: { json?: unknown } } };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalFlag(data, ...keys);
}
