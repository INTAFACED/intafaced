/**
 * The support desk's read of one customer's routed order (J-cex-spot-18 #1 #2, row d115: orders by role, every read
 * logged where the customer sees it). A routed order is one our door placed on the outside venue from the customer's own
 * venue account: INTAFACED holds none of it, so the order, its fills and its state are read from the venue itself, by the
 * customer's address, never from a book of ours.
 *
 * The customer's address is the one their own signed action placed the order from (`PreparedActionStore.placedOrder`):
 * an operator never types an address, and another person's order under the same id is never this customer's. The read
 * names the account it was asked for, so a support agent reads only the customer the ticket is about.
 *
 * The reject reason is the venue's own refusal of the order when our door's send was refused (the venue never held it),
 * the venue's own cancel reason or trigger failure when it ended there, or none recorded.
 *
 * Every read that found the customer's order writes one append-only audit row (`venue_orders.get`) with the operator, the
 * customer and the time, before the venue is asked, so a lookup is logged even when the venue is down. The customer reads
 * that row in their own access list (`staffAccess.mine`). With the user-venue door off the read refuses
 * `trade.user_venue_off`: the blocker, never an empty order.
 */
import type { Principal } from '@intafaced/auth';
import {
  VenueRefusalError,
  encodeVenueWire,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueFill,
  type UserVenueOrder,
  type VenueRefusal,
} from '@intafaced/venue-contracts';
import type { PreparedActionStore, StoredVenueAction } from '../venue/prepared-action-store.js';
import { TradeOpsError, requireOperator, type AuditWrite } from './common.js';

export const VENUE_ORDER_READ_KIND = 'venue_orders.get';

/** A venue client order id: `0x` and 32 hex. */
const CLOID = /^0x[0-9a-f]{32}$/;

/** How far before our record of the order the venue's fills are read from: the venue's clock and ours may differ. */
const FILLS_LEAD_MS = 60_000;

export interface VenueOrderReadDeps {
  /** Writes one append-only operator audit row at `at` and returns its id (`writeOperatorAudit` on trade's database). */
  readonly audit: (row: AuditWrite, at: Date) => Promise<string>;
  /** The user-venue door's venue; null when the door is off. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly store: PreparedActionStore;
  readonly now: () => Date;
}

/** What our door knows of its send of the order: the venue took it, refused it, or gave no definite answer yet. */
export type VenueOrderSent = 'accepted' | 'refused' | 'unknown';

/** The reject reason, where one is recorded: whose words they are, the code and the words. */
export interface VenueOrderReject {
  readonly source: 'venue_refusal' | 'venue_cancel' | 'trigger_failure';
  readonly code: string;
  readonly detail: string;
}

export interface VenueOrderRead {
  readonly accountId: string;
  readonly venueId: string;
  /** The customer's own venue account address the order was placed from. */
  readonly owner: string;
  readonly subAccount: string | null;
  readonly venueClientOrderId: string;
  /** When our door stored the customer's order (before it was signed and sent). */
  readonly recordedAt: Date;
  readonly sent: VenueOrderSent;
  /** The order as the venue reports it now; null when the venue holds no such order (a refused send, say). */
  readonly order: UserVenueOrder | null;
  /** The venue's own fills of this order, oldest first. */
  readonly fills: readonly UserVenueFill[];
  readonly reject: VenueOrderReject | null;
  /** The venue's as-of time of the order read. */
  readonly asOf: Date;
  /** The audit row this read wrote. */
  readonly auditId: string;
}

function sentOf(row: StoredVenueAction): { sent: VenueOrderSent; refusal: VenueRefusal | null } {
  const outcome = row.lastOutcome;
  if (outcome?.definite && !outcome.accepted) return { sent: 'refused', refusal: outcome.refusal };
  if (outcome?.definite && outcome.accepted) return { sent: 'accepted', refusal: null };
  return { sent: 'unknown', refusal: null };
}

/** The reject reason in the venue's own words, or null when none is recorded. */
export function rejectOf(refusal: VenueRefusal | null, order: UserVenueOrder | null): VenueOrderReject | null {
  if (refusal) return { source: 'venue_refusal', code: refusal.code, detail: refusal.detail };
  if (order?.status === 'rejected' && order.trigger?.failure)
    return { source: 'trigger_failure', code: 'trigger_failed', detail: order.trigger.failure };
  if ((order?.status === 'canceled' || order?.status === 'rejected') && order.cancelReason)
    return { source: 'venue_cancel', code: order.cancelReason, detail: order.cancelReason };
  return null;
}

export async function readVenueOrder(
  deps: VenueOrderReadDeps,
  principal: Principal,
  input: { accountId: string; venueClientOrderId: string },
): Promise<VenueOrderRead> {
  requireOperator(principal);
  const cloid = input.venueClientOrderId.trim().toLowerCase();
  if (!CLOID.test(cloid))
    throw new TradeOpsError('venue_order_id_invalid', 'a routed order id is the venue client order id (0x and 32 hex)');
  const accountId = input.accountId.trim();
  if (!accountId) throw new TradeOpsError('venue_order_account_required', 'name the customer whose order this is');
  if (!deps.venue)
    throw new TradeOpsError('trade.user_venue_off', 'the user-venue door is off: routed orders cannot be read from the venue');
  const row = await deps.store.placedOrder(accountId, cloid);
  if (!row) throw new TradeOpsError('venue_order_not_found', `this customer placed no routed order ${cloid} through INTAFACED`);
  const p = row.prepared;
  const account: UserVenueAccount = { venueId: p.venueId, owner: p.account.owner.toLowerCase(), subAccount: p.account.subAccount ?? null };
  const auditId = await deps.audit(
    {
      kind: VENUE_ORDER_READ_KIND,
      operatorId: principal.userId,
      accountId,
      objectId: cloid,
      approverId: null,
      reason: null,
      detail: { venueId: account.venueId, owner: account.owner, subAccount: account.subAccount },
    },
    deps.now(),
  );
  const { sent, refusal } = sentOf(row);
  try {
    const venue = await deps.venue();
    if (venue.venue.id !== account.venueId)
      throw new TradeOpsError('venue_order_other_venue', `this order was routed to ${account.venueId}, which the door does not reach now`);
    const read = await venue.orderByClientId(account, cloid);
    const order = read.value;
    const fills = order
      ? (await venue.fills(account, new Date(row.createdAt.getTime() - FILLS_LEAD_MS))).value
          .filter((f) => f.venueClientOrderId?.toLowerCase() === cloid)
          .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId))
      : [];
    return {
      accountId,
      venueId: account.venueId,
      owner: account.owner,
      subAccount: account.subAccount,
      venueClientOrderId: cloid,
      recordedAt: row.createdAt,
      sent,
      order,
      fills,
      reject: rejectOf(refusal, order),
      asOf: read.asOf,
      auditId,
    };
  } catch (err) {
    if (err instanceof VenueRefusalError) throw new TradeOpsError(`trade.venue.${err.refusal.code}`, err.refusal.detail);
    throw err;
  }
}

/** The read on the wire: every amount a decimal string, every time an ISO string. */
export const venueOrderReadWire = (read: VenueOrderRead) => encodeVenueWire(read) as Record<string, unknown>;
