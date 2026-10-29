/**
 * SIGNED PAY QR (PP-send-request-11): a scan pays the account it names even when people cannot find that account by
 * its handle.
 *
 * - The payload names the payee by their stable account id, never the handle: `v1.<account id>.<signature>`, where the
 *   signature is HMAC-SHA256 under `IDENTITY_PAY_QR_KEY` over a domain-separated string. A handle change or a switch to
 *   "people can't find me" never breaks a code already shared. Sharing the code is the payee's own consent to be paid,
 *   so a resolve answers whatever the discoverability switch says.
 * - Blank key: the owner has not set one, so issuing and resolving both refuse `identity.qr_key_unset`. Nothing is
 *   invented.
 * - A payload that does not verify refuses `identity.qr_invalid` before anything is read: the account id inside an
 *   unverified payload is never looked up, so a forged code learns nothing about who exists.
 * - A key carrying the `local-test:` marker is the local stack's own TEST key, made on that machine. It is refused at
 *   boot unless APP_ENV is exactly dev or test.
 * - Reads only. Nothing here writes a row.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { hasLocalTestMarker, isExplicitDevOrTest } from '@intafaced/config';

export type PayQrCode = 'identity.qr_key_unset' | 'identity.qr_invalid' | 'identity.qr_payee_unavailable' | 'identity.delegated_refused';

export class PayQrError extends Error {
  constructor(
    readonly code: PayQrCode,
    message: string,
  ) {
    super(`${message} [${code}]`);
    this.name = 'PayQrError';
  }
}

export const PAY_QR_KEY_MIN = 32;
const VERSION = 'v1';
const DOMAIN = 'intafaced.pay-qr.v1\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
/** Longest payload accepted: `v1.` + 36 + `.` + 43. Anything longer is refused without parsing. */
export const PAY_QR_PAYLOAD_MAX = 83;

/**
 * The boot reading of `IDENTITY_PAY_QR_KEY`. Blank is null (every call refuses `identity.qr_key_unset`). A key shorter
 * than 32 characters, or a `local-test:` key outside an explicit dev or test process, stops the boot.
 */
export function payQrKeyFromEnv(raw: string | undefined, appEnv: string | undefined): string | null {
  const key = (raw ?? '').trim();
  if (key === '') return null;
  if (key.length < PAY_QR_KEY_MIN) throw new Error(`IDENTITY_PAY_QR_KEY must be at least ${PAY_QR_KEY_MIN} characters.`);
  if (hasLocalTestMarker(key) && !isExplicitDevOrTest(appEnv)) {
    throw new Error('IDENTITY_PAY_QR_KEY is the local stack TEST key (local-test:). It is refused unless APP_ENV is exactly dev or test.');
  }
  return key;
}

function sign(key: string, userId: string): string {
  return createHmac('sha256', key)
    .update(DOMAIN + userId)
    .digest('base64url');
}

/** The account id a payload names, or null when it does not verify under `key`. Reads nothing. */
export function verifyPayQr(key: string, payload: string): string | null {
  if (payload.length > PAY_QR_PAYLOAD_MAX) return null;
  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [version, userId, signature] = parts as [string, string, string];
  if (version !== VERSION || !UUID.test(userId) || !SIGNATURE.test(signature)) return null;
  const expected = Buffer.from(sign(key, userId));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

export interface PayQrActor {
  userId: string;
  apiKey: boolean;
  subAccount: boolean;
}

export interface PayQrPreview {
  userId: string;
  handle: string;
  self: boolean;
}

export class PayQrService {
  constructor(
    private readonly sql: Sql,
    private readonly key: string | null,
  ) {}

  private requireKey(): string {
    if (this.key === null) throw new PayQrError('identity.qr_key_unset', 'Pay codes are not set up');
    return this.key;
  }

  /** The caller's own pay code. Only the account holder's own session, never an API key or a sub-account. */
  mine(actor: PayQrActor): { payload: string } {
    if (actor.apiKey || actor.subAccount)
      throw new PayQrError('identity.delegated_refused', 'Only the account holder can share a pay code');
    const key = this.requireKey();
    const userId = actor.userId.toLowerCase();
    return { payload: `${VERSION}.${userId}.${sign(key, userId)}` };
  }

  /** Who a scanned payload pays. Verified first; only a verified account id is read. */
  async resolve(actor: Pick<PayQrActor, 'userId'>, payload: string): Promise<PayQrPreview> {
    const key = this.requireKey();
    const userId = verifyPayQr(key, payload.trim());
    if (userId === null) throw new PayQrError('identity.qr_invalid', 'This code is not valid');
    const rows = await this.sql<Array<{ id: string; handle: string }>>`
      SELECT id, handle FROM users WHERE id = ${userId}::uuid AND status = 'active' LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new PayQrError('identity.qr_payee_unavailable', 'This account cannot be paid');
    return { userId: row.id, handle: row.handle, self: row.id.toLowerCase() === actor.userId.toLowerCase() };
  }
}
