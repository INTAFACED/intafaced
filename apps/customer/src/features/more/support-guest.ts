import {
  supportGuestCreateInputSchema,
  supportGuestCreateResultSchema,
  supportGuestReplyInputSchema,
  supportGuestReplyResultSchema,
  supportGuestThreadInputSchema,
  supportGuestThreadSchema,
  supportGuestVerifyInputSchema,
  supportGuestVerifyResultSchema,
} from '@intafaced/contracts/support-guest';
import type { ApiResult } from '../../shared/api';
import { contractProcedure } from '../../shared/contract-call';

/** The guest path (SP-tickets-01): public calls, no session. Tokens go in the POST body, never in an address. */
export const guestCreate = contractProcedure('support', 'guestCreate', {
  input: supportGuestCreateInputSchema,
  output: supportGuestCreateResultSchema,
});
export const guestVerify = contractProcedure('support', 'guestVerify', {
  input: supportGuestVerifyInputSchema,
  output: supportGuestVerifyResultSchema,
});
export const guestThread = contractProcedure('support', 'guestThread', {
  input: supportGuestThreadInputSchema,
  output: supportGuestThreadSchema,
});
export const guestReply = contractProcedure('support', 'guestReply', {
  input: supportGuestReplyInputSchema,
  output: supportGuestReplyResultSchema,
});

/** The token a link carries after `#<name>=`, read once; the address bar keeps no token. */
export function takeLinkToken(name: 'token' | 'access'): string {
  const value = new URLSearchParams(location.hash.replace(/^#/, '')).get(name)?.trim() ?? '';
  if (location.hash) history.replaceState(history.state, '', location.pathname);
  return value;
}

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** A link's token, read once from the address and kept in this tab's storage under `slot` (best effort). */
export function keptToken(name: 'token' | 'access', slot: string): string {
  const fromLink = takeLinkToken(name);
  try {
    if (fromLink) sessionStorage.setItem(slot, fromLink);
    return fromLink || (sessionStorage.getItem(slot) ?? '');
  } catch {
    return fromLink;
  }
}

/** The code a refusal names: the service's dotted code, or `vendor.email`. */
export function refusalCode(refusal: Refusal): string | null {
  const named = /\b(?:support|guest)(?:\.[a-z0-9_]+)+|\bvendor\.email\b/.exec(refusal.message)?.[0];
  return named ?? refusal.code ?? null;
}

/**
 * Which plain sentence a refusal of the guest path is said with (every code is also shown as it is), so each guest room
 * says the same words however it draws them: email not connected, or one sentence by its copy key.
 */
export type GuestRefusalWords =
  | { kind: 'not-connected'; code: 'vendor.email' }
  | { kind: 'sentence'; code: string | null; key: 'rateLimited' | 'deliveryUnknown' | 'categoryUnknown' | 'fraudUnset' | 'failed' }
  | { kind: 'sentence'; code: string | null; key: 'unset'; setting: string };

export function guestRefusalWords(refusal: Refusal): GuestRefusalWords {
  const code = refusalCode(refusal);
  if (code === 'vendor.email') return { kind: 'not-connected', code };
  const unset = /support\.guest_(link_ttl|rate_limit|retention|address_key)_unset/.exec(code ?? '');
  if (code === 'support.guest_rate_limited') return { kind: 'sentence', code, key: 'rateLimited' };
  if (unset) return { kind: 'sentence', code, key: 'unset', setting: (/SUPPORT_GUEST_[A-Z_]+/.exec(refusal.message)?.[0] ?? code)! };
  if (code === 'support.guest_delivery_unknown') return { kind: 'sentence', code, key: 'deliveryUnknown' };
  if (code === 'support.category_unknown') return { kind: 'sentence', code, key: 'categoryUnknown' };
  if (code === 'support.fraud_route_unset' || code === 'support.fraud_route_missing') return { kind: 'sentence', code, key: 'fraudUnset' };
  return { kind: 'sentence', code, key: 'failed' };
}
