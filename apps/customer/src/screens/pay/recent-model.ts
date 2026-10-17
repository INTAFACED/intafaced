import type { ActivityItem } from './deps';
import { contactLabel, type Contact } from './deps';

/** Sent from Send after a payment is confirmed, so the left side of the page reads again straight away. */
export const PAY_SENT_EVENT = 'intafaced:pay-sent';

/** How many rows each list shows. */
export const RECENT_PAYMENTS = 5;
export const RECENT_RECIPIENTS = 6;

/** A payment between two people on INTAFACED: the ledger lines the bank files as a transfer in or out. */
export const isPersonalTransfer = (item: ActivityItem): boolean => item.kind === 'transfer_in' || item.kind === 'transfer_out';

/** The newest transfers, in the order the bank returned them (newest first). Nothing is sorted or invented here. */
export function recentPayments(items: readonly ActivityItem[], limit = RECENT_PAYMENTS): ActivityItem[] {
  const seen = new Set<string>();
  const rows: ActivityItem[] = [];
  for (const item of items) {
    if (!isPersonalTransfer(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(item);
    if (rows.length >= limit) break;
  }
  return rows;
}

/** The receipt for a payment: the existing transaction page. */
export const receiptHref = (item: Pick<ActivityItem, 'id'>): string => `/money/activity/${encodeURIComponent(item.id)}`;

/** Who a payment was with. A handle when the bank gave one, otherwise null (the screen says "Another account"). */
export const counterpartyHandle = (item: ActivityItem): string | null => item.counterparty?.handle ?? null;

export interface Recipient {
  /** What the chip says: `@handle`, or the start of an Account ID. */
  label: string;
  /** What Send is opened with: a handle or an Account ID. */
  to: string;
}

/**
 * People the customer has paid, most recent first. Two real sources, merged without repeats:
 * the transfers they sent that the bank lists, and the payments this device remembers sending.
 */
export function recentRecipients(items: readonly ActivityItem[], remembered: readonly Contact[], limit = RECENT_RECIPIENTS): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const add = (label: string, to: string, key: string) => {
    if (seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ label, to });
  };
  for (const item of items) {
    if (item.kind !== 'transfer_out') continue;
    const handle = counterpartyHandle(item);
    if (handle) add(`@${handle}`, handle, handle.toLowerCase());
  }
  for (const contact of remembered) {
    const key = contact.handle ? contact.handle.toLowerCase() : contact.userId.toLowerCase();
    add(contactLabel(contact), contact.handle ?? contact.userId, key);
  }
  return out;
}

/**
 * What an empty payments list may honestly say. `older`: none among what has been read, but older entries exist.
 * `none`: everything was read and there is no payment.
 */
export const paymentsEmpty = (hasMore: boolean): 'older' | 'none' => (hasMore ? 'older' : 'none');
