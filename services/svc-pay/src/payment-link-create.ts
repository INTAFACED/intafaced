import { fingerprintRequest } from './rest-idempotency.js';

/** Same cap as the public REST Idempotency-Key. Not a new product limit. */
const LINK_CREATE_KEY_MAX = 255;

/**
 * Blank and oversized keys refuse before any row is written. Undefined means
 * the caller sent no key; each call then mints a new link.
 */
export function paymentLinkCreateKey(raw: string | undefined): { ok: true; key: string | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, key: undefined };
  const key = raw.trim();
  if (!key || key.length > LINK_CREATE_KEY_MAX) return { ok: false };
  return { ok: true, key };
}

/**
 * The body the caller asked for, not the expiry the service stored.
 * An omitted expiry is the literal `default`, so a retry does not conflict
 * just because the clock moved. An explicit date is the instant they named,
 * before the lifetime cap is applied.
 */
export function paymentLinkCreateFingerprint(input: {
  merchantId: string;
  label: string;
  profileId: string | null;
  amount: string | null;
  currency: string | null;
  expiresAt: string;
  maxUses: number | null;
  /**
   * Present only when the caller sent a confirmation. Omitted keeps the
   * fingerprint of links created before confirmation existed.
   */
  confirmation?: string;
}): string {
  const body: Record<string, unknown> = {
    merchantId: input.merchantId.toLowerCase(),
    label: input.label,
    profileId: input.profileId === null ? null : input.profileId.toLowerCase(),
    amount: input.amount,
    currency: input.currency,
    expiresAt: input.expiresAt,
    maxUses: input.maxUses,
  };
  if (input.confirmation !== undefined) body.confirmation = input.confirmation;
  return fingerprintRequest('POST', 'merchant.createLink', body);
}

/**
 * Path the hosted page already serves. No host: an unset public origin is not
 * invented. `basePath` is the edge prefix (`PAY_PUBLIC_BASE_PATH`), or empty
 * when the service was not given one.
 */
export function checkoutUrlFor(token: string, basePath: string): string {
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  return `${base}/checkout?token=${encodeURIComponent(token)}`;
}
