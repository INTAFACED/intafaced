import type { LinkRow } from './schemas';
import type { BusinessPayApi } from '../../pay-api';
import { w3cCopy } from './copy';
import { PAY_MERCHANT_GET_LINK } from '@intafaced/contracts/pay-merchant-procedures';

/** One payment link as the list reads it. */
export type Link = LinkRow;

export function linkState(link: Link, now: number) {
  if (!link.active) return 'inactive';
  if (link.expiresAt === null || !Number.isFinite(Date.parse(link.expiresAt))) return 'unknown';
  if (Date.parse(link.expiresAt) <= now) return 'expired';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'exhausted';
  return 'active';
}

/** What the customer sees after paying, in words. */
export function afterWords(confirmation: { kind: 'message'; message: string } | { kind: 'redirect'; url: string } | undefined): string {
  if (!confirmation) return w3cCopy.t('lk_afterNone');
  return confirmation.kind === 'message'
    ? `${w3cCopy.t('lk_afterMessage')}: “${confirmation.message.trim()}”`
    : `${w3cCopy.t('lk_afterRedirect')}: ${confirmation.url.trim()}`;
}

/**
 * The button code a website can use. The service writes the checkout as a path from its public base (it invents no host),
 * so a path is completed with this site's own address: a button on the business's website must carry the full address.
 */
export function fullSnippet(snippet: string, origin = globalThis.location?.origin ?? ''): string {
  return snippet.replace(/href="\/(?!\/)/, `href="${origin}/`);
}

/**
 * Settle a deactivate whose answer was lost, from the link's own state. The link is read first (a failed read changes
 * nothing). Then the held attempt is cleared: `inactive` means the first request went through; `active` means it did not,
 * and the owner may send it again (deactivating twice does no harm).
 */
export async function settleDeactivate(pay: BusinessPayApi, merchantId: string, linkId: string): Promise<'inactive' | 'active' | 'failed'> {
  const lockId = `${pay.authority?.userId}:link-deactivate:${linkId}`;
  const original = pay.guard.original(lockId);
  if (!original) return 'failed';
  // A read of an outcome that may already exist, so it is not wrapped in definite().
  const read = await pay.queryRecord(PAY_MERCHANT_GET_LINK, { merchantId, linkId });
  if (!read.ok || read.data.id !== linkId) return 'failed';
  if (!(await pay.guard.resolve(lockId, original.raw))) return 'failed';
  return read.data.active ? 'active' : 'inactive';
}
