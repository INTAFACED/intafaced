/**
 * Merchant request signing helper. Same canonical string the edge verifies.
 *
 * INTAFACED-REQ-V1, UTF-8, no trailing newline:
 *   version, method, absolute path (plus query), unix seconds, nonce, body sha256.
 *
 * The server holds each timestamp to the owner's signing window, published at
 * /developers/authentication; while the window is unset every signed request is
 * refused (auth.request_window_unset). This helper sets no window of its own.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const REQUEST_SIGN_VERSION = 'INTAFACED-REQ-V1';

export const REQUEST_TIMESTAMP_HEADER = 'x-intafaced-request-timestamp';
export const REQUEST_NONCE_HEADER = 'x-intafaced-request-nonce';
export const REQUEST_SIGNATURE_HEADER = 'x-intafaced-request-signature';

const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
const HEX = /^[0-9a-f]+$/i;

export function hashBody(body: Uint8Array | string | null | undefined): string {
  const bytes = body == null ? new Uint8Array() : typeof body === 'string' ? new TextEncoder().encode(body) : body;
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

/** Constant-time on the decoded bytes. A length mismatch returns false and does not throw. */
export function signaturesEqual(provided: string, expected: string): boolean {
  if (!HEX.test(provided) || !HEX.test(expected)) return false;
  const left = Buffer.from(provided, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function newRequestNonce(): string {
  return randomBytes(16).toString('base64url');
}

export interface SignedPayRequest {
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyHash: string;
  readonly signature: string;
  readonly canonical: string;
}

export function signPayRequest(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body?: Uint8Array | string | null;
}): SignedPayRequest {
  if (!input.secret) throw new Error('signing secret is not configured');
  const method = input.method.toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) throw new Error('request method is not signable');
  if (!input.path.startsWith('/') || input.path.includes('://') || /\s/.test(input.path)) {
    throw new Error('request path is not an absolute path');
  }
  if (!/^\d{1,16}$/.test(input.timestamp)) throw new Error('timestamp is not unix seconds');
  if (!NONCE.test(input.nonce)) throw new Error('nonce is not usable');
  const bodyHash = hashBody(input.body);
  const canonical = canonicalRequest({
    method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodyHash,
  });
  return {
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodyHash,
    signature: signRequest(input.secret, canonical),
    canonical,
  };
}
