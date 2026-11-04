/**
 * Who someone is on INTAFACED: the caller's own handle and "pay by exact @handle" (UI-SPEC 5.10, U2).
 *
 * Coded against backend PR #4688 (svc-identity), which adds two procedures:
 *   - `identity.me` -> `{ userId, handle }` (the caller's own, no input);
 *   - `identity.users.resolveHandle({ handle })` -> `{ found: true, userId, handle, self, name, memberSince }` | `{ found: false }`.
 *     `name` is the name the person chose for their profile (null when none); `memberSince` is the month they joined
 *     (`YYYY-MM`). A server older than that answer leaves both out, read here as null.
 *     Exact, case-insensitive match only. A caller who looks up too fast gets HTTP 429 with the code
 *     `identity.handle_lookup_rate_limited`; API keys get 403 (a browser session never does).
 *
 * Until that PR is deployed the server answers 404 (or 501) for both. That is NOT an error to show: it means "this
 * server cannot do handles yet", and the caller falls back to the older Account ID input (`kind: 'unavailable'`).
 * Any other failure is `failed`, never a guess.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../shared/api';

export const HANDLE_LOOKUP_RATE_LIMITED = 'identity.handle_lookup_rate_limited';

/** Same rule as sign-up: 3 to 32 letters, numbers or underscores. */
export const HANDLE_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

export const meSchema = z.object({
  userId: z.string().guid(),
  handle: z.string().min(1),
  /** Absent on a server that does not yet report confirmation. */
  emailVerified: z.boolean().optional(),
});

export const resolveHandleSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    userId: z.string().guid(),
    handle: z.string().min(1),
    self: z.boolean(),
    name: z.string().nullish(),
    memberSince: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .nullish(),
  }),
]);

export type MeOutcome =
  | { kind: 'ok'; userId: string; handle: string; emailVerified?: boolean }
  /** The server has no `identity.me` yet. */
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export type ResolveOutcome =
  /** `name` is undefined when the server does not answer names (older than J-pay-01 #2), null when they have none. */
  | { kind: 'found'; userId: string; handle: string; self: boolean; name: string | null | undefined; memberSince: string | null }
  | { kind: 'notFound' }
  | { kind: 'rateLimited' }
  /** The server has no `resolveHandle` yet: fall back to the Account ID input. */
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/** "@Luffy " -> "Luffy"; null when what is left is not a well-formed handle. */
export function cleanHandle(raw: string): string | null {
  const bare = raw.trim().replace(/^@/, '');
  return HANDLE_PATTERN.test(bare) ? bare : null;
}

/** 404 and 501 on a procedure mean the server is older than the client, not that the request was bad. */
export function procedureMissing(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return result.reason === 'not_mounted' || result.reason === 'not_supported' || result.status === 404 || result.status === 501;
}

export async function fetchMe(api: ApiClient, signal?: AbortSignal): Promise<MeOutcome> {
  const result = await api.query('identity', 'me', undefined, meSchema, { signal });
  if (result.ok) {
    return {
      kind: 'ok',
      userId: result.data.userId,
      handle: result.data.handle,
      ...(result.data.emailVerified === undefined ? {} : { emailVerified: result.data.emailVerified }),
    };
  }
  return procedureMissing(result) ? { kind: 'unavailable' } : { kind: 'failed' };
}

export async function resolveHandle(api: ApiClient, handle: string, signal?: AbortSignal): Promise<ResolveOutcome> {
  const clean = cleanHandle(handle);
  // Never spend a lookup (they are rationed) on something that cannot be a handle.
  if (clean === null) return { kind: 'notFound' };
  const result = await api.query('identity', 'users.resolveHandle', { handle: clean }, resolveHandleSchema, { signal });
  if (!result.ok) {
    if (result.status === 429 || result.code === HANDLE_LOOKUP_RATE_LIMITED) return { kind: 'rateLimited' };
    return procedureMissing(result) ? { kind: 'unavailable' } : { kind: 'failed' };
  }
  if (!result.data.found) return { kind: 'notFound' };
  // The answer must be about the handle we asked for. Anything else is a bad answer, not a person to pay.
  if (result.data.handle.toLowerCase() !== clean.toLowerCase()) return { kind: 'failed' };
  const raw = result.data.name;
  const name = raw === undefined ? undefined : raw?.trim() ? raw.trim() : null;
  return {
    kind: 'found',
    userId: result.data.userId,
    handle: result.data.handle,
    self: result.data.self,
    name,
    memberSince: result.data.memberSince ?? null,
  };
}

// ── Saved recipients (`identity.recipients.list`) ──────────────────────────────────────────────────────────────
// The people the customer saved to pay again, by handle. Send checks a looked-up handle against them, so a look-alike of
// someone saved is flagged before anything is sent (J-pay-01 #2).

const savedRecipientsSchema = z.array(z.object({ handle: z.string().min(1), label: z.string(), addedAt: z.string() }));

export type SavedRecipientsOutcome = { kind: 'ok'; handles: string[] } | { kind: 'failed' };

/** The most recently saved recipients' handles, one page of 100. Any failure is `failed`: the screen says it could not check, never "none". */
export async function fetchSavedRecipients(api: ApiClient, signal?: AbortSignal): Promise<SavedRecipientsOutcome> {
  const result = await api.query('identity', 'recipients.list', { limit: 100 }, savedRecipientsSchema, { signal });
  return result.ok ? { kind: 'ok', handles: result.data.map((row) => row.handle) } : { kind: 'failed' };
}

// ── Signed pay codes (PP-send-request-11) ───────────────────────────────────────────────────────────────────────
// `identity.qr.mine` signs the caller's own account id; `identity.qr.resolve({ payload })` says who a scanned code pays,
// by account id, whatever their "find me by handle" switch says. A blank signing key is the owner's setting not yet
// made: both refuse `identity.qr_key_unset`. A code that does not verify is `identity.qr_invalid`.

export const PAY_QR_KEY_UNSET = 'identity.qr_key_unset';
export const PAY_QR_INVALID = 'identity.qr_invalid';
export const PAY_QR_PAYEE_UNAVAILABLE = 'identity.qr_payee_unavailable';

const payQrSchema = z.object({ payload: z.string().min(1) });
const payQrPreviewSchema = z.object({ userId: z.string().guid(), handle: z.string().min(1), self: z.boolean() });

export type PayQrOutcome = { kind: 'ok'; payload: string } | { kind: 'unset' } | { kind: 'failed' };

export type PayQrResolveOutcome =
  | { kind: 'found'; userId: string; handle: string; self: boolean }
  | { kind: 'invalid' }
  | { kind: 'payeeUnavailable' }
  | { kind: 'unset' }
  | { kind: 'failed' };

export async function fetchMyPayQr(api: ApiClient, signal?: AbortSignal): Promise<PayQrOutcome> {
  const result = await api.query('identity', 'qr.mine', undefined, payQrSchema, { signal });
  if (result.ok) return { kind: 'ok', payload: result.data.payload };
  return result.code === PAY_QR_KEY_UNSET ? { kind: 'unset' } : { kind: 'failed' };
}

export async function resolvePayQr(api: ApiClient, payload: string, signal?: AbortSignal): Promise<PayQrResolveOutcome> {
  const result = await api.query('identity', 'qr.resolve', { payload }, payQrPreviewSchema, { signal });
  if (result.ok) return { kind: 'found', ...result.data };
  if (result.code === PAY_QR_INVALID) return { kind: 'invalid' };
  if (result.code === PAY_QR_PAYEE_UNAVAILABLE) return { kind: 'payeeUnavailable' };
  return result.code === PAY_QR_KEY_UNSET ? { kind: 'unset' } : { kind: 'failed' };
}
