/**
 * Late complaint path for a finished order (P-disputes-security-01, the
 * agent-queue part).
 *
 * A released or cancelled trade cannot be disputed; the order page offers
 * "Report a problem with a finished order" instead, which becomes a support
 * ticket with category `p2p` and the trade id. This module builds and checks
 * that request only. Not wired: svc-support does not have the `p2p` category or
 * the trade reference yet (contracts PR, then the svc-support lane), and the
 * agent queue is P-disputes-security-05. No cross-service call is made here.
 *
 * A resolved dispute is covered: a ruling moves the trade `disputed ->
 * released | cancelled` (state.ts EDGES), and the spec (p2p-disputes-security.md:24)
 * offers the finished-order report for any released or cancelled order, so a
 * party can still report a problem after a resolved dispute. While the dispute
 * is open (`disputed`) the dispute itself is the channel, so the route is `none`.
 */

import { DISPUTE_OPENABLE } from './dispute-open-policy.js';
import { TERMINAL_STATUSES, type TradeStatus } from './state.js';

export type LateComplaintCode =
  'p2p.dispute_not_allowed' | 'p2p.late_complaint_not_allowed' | 'p2p.description_required' | 'p2p.description_too_long';

/** Upper bound on the complaint text this builder will emit (characters, after trim). */
export const LATE_COMPLAINT_MAX_DESCRIPTION = 2000;

export class LateComplaintError extends Error {
  constructor(
    message: string,
    readonly code: LateComplaintCode,
  ) {
    super(message);
    this.name = 'LateComplaintError';
  }
}

/** What the order page should offer for a party, by trade status. */
export function complaintRoute(status: TradeStatus): 'dispute' | 'late_complaint' | 'none' {
  if (DISPUTE_OPENABLE.has(status)) return 'dispute';
  if (TERMINAL_STATUSES.has(status)) return 'late_complaint';
  return 'none';
}

export interface LateComplaintRequest {
  category: 'p2p';
  tradeId: string;
  reporterId: string;
  description: string;
  /** Idempotency: one late complaint per reporter per trade. */
  idempotencyKey: string;
}

export function buildLateComplaint(input: {
  trade: { id: string; status: TradeStatus; buyerId: string; sellerId: string };
  reporterId: string;
  description: string;
}): LateComplaintRequest {
  const { trade, reporterId } = input;
  if (!reporterId || (reporterId !== trade.buyerId && reporterId !== trade.sellerId)) {
    throw new LateComplaintError('Only a party to the trade can report a problem with it.', 'p2p.late_complaint_not_allowed');
  }
  const route = complaintRoute(trade.status);
  if (route === 'dispute') {
    throw new LateComplaintError('This order is still open: raise a dispute instead.', 'p2p.late_complaint_not_allowed');
  }
  if (route === 'none') {
    throw new LateComplaintError(`A ${trade.status} order has no complaint path.`, 'p2p.late_complaint_not_allowed');
  }
  const description = input.description.trim();
  if (!description) throw new LateComplaintError('Describe the problem.', 'p2p.description_required');
  if ([...description].length > LATE_COMPLAINT_MAX_DESCRIPTION) {
    throw new LateComplaintError(`Keep the description to ${LATE_COMPLAINT_MAX_DESCRIPTION} characters.`, 'p2p.description_too_long');
  }
  return {
    category: 'p2p',
    tradeId: trade.id,
    reporterId,
    description,
    idempotencyKey: `p2p:late-complaint:${trade.id}:${reporterId}`,
  };
}
