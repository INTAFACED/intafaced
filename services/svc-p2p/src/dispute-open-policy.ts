/**
 * Raise a dispute: reason codes, windows and frequency caps
 * (P-disputes-security-01 core, p2p-disputes-security-001/-002/-003).
 *
 * Pure rules only. Wiring into `openDisputeInner` and the new `disputes.policy`
 * read waits on the router mount: a new procedure must first be added to the
 * existing leak sweep, which is an existing-test edit and needs an exception.
 * The late-complaint support path is a separate part of this slice.
 *
 * Owner values follow spec C3 (p2p-disputes-security.md:9): blank fails closed
 * with `p2p.config_unset`, except customer-protecting dispute caps, which C3
 * lets read blank as "rule off" (and the slice test at :26 requires "Given caps
 * unset Then open works with no cap and the policy read says 'no cap set'").
 * - Windows (after creation, after fiat_sent): blank REFUSES `p2p.config_unset`.
 *   An owner who wants no window publishes an explicit `off`.
 * - Caps (per day, per order, resubmission wait): blank = no cap set; `off` too.
 * Every other input fails closed: an unknown reason, a role that is not a
 * party, a status that is not `escrowed` or `fiat_sent`, or a garbled value.
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

/** Owner-published values. `null` = explicit `off` (windows) or no cap set (caps). */
export interface DisputePolicy {
  earliestAfterCreatedSeconds: number | null;
  latestAfterCreatedSeconds: number | null;
  earliestAfterFiatSentSeconds: number | null;
  latestAfterFiatSentSeconds: number | null;
  perDayCap: number | null;
  perOrderCap: number | null;
  resubmissionWaitSeconds: number | null;
}

/** Window keys: blank refuses (C3); only an explicit `off` disables one. */
export const WINDOW_KEYS: readonly (keyof DisputePolicy)[] = [
  'earliestAfterCreatedSeconds',
  'latestAfterCreatedSeconds',
  'earliestAfterFiatSentSeconds',
  'latestAfterFiatSentSeconds',
];

const POLICY_KEYS: readonly (keyof DisputePolicy)[] = [...WINDOW_KEYS, 'perDayCap', 'perOrderCap', 'resubmissionWaitSeconds'];

/**
 * Parse owner values. Blank (undefined, null, '' or whitespace) on a window
 * refuses `p2p.config_unset` naming the key; on a cap it means no cap set.
 * `off` (any case) disables either. Anything else must be a non-negative
 * integer; a garbled value refuses `p2p.config_unset`.
 */
export function parseDisputePolicy(raw: Readonly<Record<string, unknown>>): DisputePolicy {
  const out = {} as Record<keyof DisputePolicy, number | null>;
  for (const key of POLICY_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (WINDOW_KEYS.includes(key)) {
        throw new DisputeOpenError(`Dispute policy value ${key} is not set.`, 'p2p.config_unset');
      }
      out[key] = null;
      continue;
    }
    if (typeof v === 'string' && v.trim().toLowerCase() === 'off') {
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

/** The `disputes.policy` read: what is in force; "rule off" for a window set `off`, "no cap set" for a cap. */
export function describePolicy(policy: DisputePolicy): Record<keyof DisputePolicy, number | 'no cap set' | 'rule off'> {
  const out = {} as Record<keyof DisputePolicy, number | 'no cap set' | 'rule off'>;
  for (const key of POLICY_KEYS) out[key] = policy[key] ?? (WINDOW_KEYS.includes(key) ? 'rule off' : 'no cap set');
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
