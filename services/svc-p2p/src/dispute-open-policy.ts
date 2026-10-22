/**
 * Raise a dispute: reason codes, windows and frequency caps
 * (P-disputes-security-01 core, p2p-disputes-security-001/-002/-003).
 *
 * Pure rules only. Wiring into `openDisputeInner` and the new `disputes.policy`
 * read waits on the router mount: a new procedure must first be added to the
 * existing leak sweep, which is an existing-test edit and needs an exception.
 * The late-complaint support path is a separate part of this slice.
 *
 * Owner values are blank-safe in the direction the spec states: a blank window
 * or cap means "no limit set", and the policy read says so. Every other input
 * fails closed: an unknown reason, a role that is not a party, a status that
 * is not `escrowed` or `fiat_sent`, or an unparseable owner value refuses.
 */

import type { TradeStatus } from './state.js';

export type DisputeOpenCode =
  'p2p.dispute_not_allowed' | 'p2p.dispute_window_closed' | 'p2p.dispute_cap_reached' | 'p2p.reason_invalid' | 'p2p.config_unset';

export class DisputeOpenError extends Error {
  constructor(
    message: string,
    readonly code: DisputeOpenCode,
    /** For `p2p.dispute_cap_reached` and `p2p.dispute_window_closed` (not yet open): when it can be tried again. */
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = 'DisputeOpenError';
  }
}

export type DisputeRole = 'buyer' | 'seller';

/** The closed reason list, by role (spec: buyer and seller lists differ). */
export const DISPUTE_REASONS: Readonly<Record<DisputeRole, readonly string[]>> = {
  buyer: ['seller_did_not_release', 'payment_details_wrong', 'other'],
  seller: ['payment_not_received', 'wrong_amount', 'other'],
};

/** Statuses a dispute may be opened from (ENGINE-SPEC R3, the edges into `disputed`). */
export const DISPUTE_OPENABLE: ReadonlySet<TradeStatus> = new Set<TradeStatus>(['escrowed', 'fiat_sent']);

export function roleOf(trade: { buyerId: string; sellerId: string }, userId: string): DisputeRole {
  if (userId && trade.buyerId === userId) return 'buyer';
  if (userId && trade.sellerId === userId) return 'seller';
  throw new DisputeOpenError('Only a party to the trade can open a dispute.', 'p2p.dispute_not_allowed');
}

export function assertReasonCode(role: DisputeRole, reasonCode: unknown): string {
  if (typeof reasonCode !== 'string' || !DISPUTE_REASONS[role].includes(reasonCode)) {
    throw new DisputeOpenError(`That reason is not available to the ${role}.`, 'p2p.reason_invalid');
  }
  return reasonCode;
}

export function assertOpenable(status: TradeStatus): void {
  if (!DISPUTE_OPENABLE.has(status)) {
    throw new DisputeOpenError(`A ${status} trade cannot be disputed.`, 'p2p.dispute_not_allowed');
  }
}

/** Owner-published values. `null` = not set = no limit. */
export interface DisputePolicy {
  earliestAfterCreatedSeconds: number | null;
  latestAfterCreatedSeconds: number | null;
  earliestAfterFiatSentSeconds: number | null;
  latestAfterFiatSentSeconds: number | null;
  perDayCap: number | null;
  perOrderCap: number | null;
  resubmissionWaitSeconds: number | null;
}

const POLICY_KEYS: readonly (keyof DisputePolicy)[] = [
  'earliestAfterCreatedSeconds',
  'latestAfterCreatedSeconds',
  'earliestAfterFiatSentSeconds',
  'latestAfterFiatSentSeconds',
  'perDayCap',
  'perOrderCap',
  'resubmissionWaitSeconds',
];

/**
 * Parse owner values. Blank (undefined, null, '') = not set. Anything else must
 * be a non-negative integer; a garbled value refuses `p2p.config_unset` rather
 * than silently becoming "no cap".
 */
export function parseDisputePolicy(raw: Readonly<Record<string, unknown>>): DisputePolicy {
  const out = {} as Record<keyof DisputePolicy, number | null>;
  for (const key of POLICY_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      out[key] = null;
      continue;
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new DisputeOpenError(`Dispute policy value ${key} is not a valid number.`, 'p2p.config_unset');
    }
    out[key] = n;
  }
  return out;
}

const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

export function assertWithinWindow(policy: DisputePolicy, trade: { createdAt: Date; fiatSentAt?: Date | null }, now: Date): void {
  const check = (anchor: Date, earliest: number | null, latest: number | null, label: string) => {
    if (earliest !== null && now < plus(anchor, earliest)) {
      throw new DisputeOpenError(
        `A dispute can be opened from ${earliest}s after ${label}.`,
        'p2p.dispute_window_closed',
        plus(anchor, earliest),
      );
    }
    if (latest !== null && now > plus(anchor, latest)) {
      throw new DisputeOpenError(`The dispute window closed ${latest}s after ${label}.`, 'p2p.dispute_window_closed');
    }
  };
  check(trade.createdAt, policy.earliestAfterCreatedSeconds, policy.latestAfterCreatedSeconds, 'the order was created');
  if (policy.earliestAfterFiatSentSeconds !== null || policy.latestAfterFiatSentSeconds !== null) {
    // A fiat_sent window with no fiat_sent time cannot be checked: refuse, never pass.
    if (!trade.fiatSentAt) {
      if (policy.earliestAfterFiatSentSeconds !== null) {
        throw new DisputeOpenError('A dispute can be opened only after payment is marked sent.', 'p2p.dispute_window_closed');
      }
      return;
    }
    check(trade.fiatSentAt, policy.earliestAfterFiatSentSeconds, policy.latestAfterFiatSentSeconds, 'payment was marked sent');
  }
}

/**
 * Caps. `openedByUserLastDay` = this user's dispute opens in the last 24 h
 * (oldest first); `openedOnThisOrder` = prior opens on this order (oldest first).
 */
export function assertUnderCaps(
  policy: DisputePolicy,
  history: { openedByUserLastDay: readonly Date[]; openedOnThisOrder: readonly Date[] },
  now: Date,
): void {
  const day = history.openedByUserLastDay.filter((t) => t.getTime() > now.getTime() - 86_400_000);
  if (policy.perDayCap !== null && day.length >= policy.perDayCap) {
    const oldest = day.reduce((a, b) => (a < b ? a : b), day[0] ?? now);
    throw new DisputeOpenError('Daily dispute limit reached.', 'p2p.dispute_cap_reached', plus(oldest, 86_400));
  }
  const order = history.openedOnThisOrder;
  if (policy.perOrderCap !== null && order.length >= policy.perOrderCap) {
    throw new DisputeOpenError('No more disputes can be opened on this order.', 'p2p.dispute_cap_reached');
  }
  const last = order.reduce<Date | null>((a, b) => (a === null || b > a ? b : a), null);
  if (policy.resubmissionWaitSeconds !== null && last && now < plus(last, policy.resubmissionWaitSeconds)) {
    throw new DisputeOpenError(
      'Wait before opening another dispute on this order.',
      'p2p.dispute_cap_reached',
      plus(last, policy.resubmissionWaitSeconds),
    );
  }
}

/** The `disputes.policy` read: what is in force, with "no cap set" spelled out for blanks. */
export function describePolicy(policy: DisputePolicy): Record<keyof DisputePolicy, number | 'no cap set'> {
  const out = {} as Record<keyof DisputePolicy, number | 'no cap set'>;
  for (const key of POLICY_KEYS) out[key] = policy[key] ?? 'no cap set';
  return out;
}

/** All checks in order, for the open path. Returns the validated reason code. */
export function assertMayOpenDispute(input: {
  policy: DisputePolicy;
  trade: { status: TradeStatus; buyerId: string; sellerId: string; createdAt: Date; fiatSentAt?: Date | null };
  userId: string;
  reasonCode: unknown;
  history: { openedByUserLastDay: readonly Date[]; openedOnThisOrder: readonly Date[] };
  now: Date;
}): { role: DisputeRole; reasonCode: string } {
  const role = roleOf(input.trade, input.userId);
  assertOpenable(input.trade.status);
  const reasonCode = assertReasonCode(role, input.reasonCode);
  assertWithinWindow(input.policy, input.trade, input.now);
  assertUnderCaps(input.policy, input.history, input.now);
  return { role, reasonCode };
}
