import type { ApiResult } from '../../shared/api';
import { takeLinkToken } from './support-guest';
import type { guestCopy } from './support-guest-copy';

/** What a guest's support link pages share (SP-tickets-01): GuestVerify.tsx and the guest rooms in SupportGuest.tsx. */
export type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

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

type GuestT = ReturnType<typeof guestCopy.useCopy>['t'];

/** The plain sentence for a refusal of the guest path that is not the email sender being off. */
export function guestRefusalSentence(refusal: Refusal, code: string | null, t: GuestT): string {
  const unset = /support\.guest_(link_ttl|rate_limit|retention|address_key)_unset/.exec(code ?? '');
  return code === 'support.guest_rate_limited'
    ? t('rateLimited')
    : unset
      ? t('unset', { setting: (/SUPPORT_GUEST_[A-Z_]+/.exec(refusal.message)?.[0] ?? code)! })
      : code === 'support.guest_delivery_unknown'
        ? t('deliveryUnknown')
        : code === 'support.category_unknown'
          ? t('categoryUnknown')
          : code === 'support.fraud_route_unset' || code === 'support.fraud_route_missing'
            ? t('fraudUnset')
            : t('failed');
}
