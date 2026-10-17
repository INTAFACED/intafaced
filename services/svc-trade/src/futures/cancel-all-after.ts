import type { Amount } from '@intafaced/ledger-client';

/**
 * Cancel-all-after (CRITPT-0004).
 *
 * The allowed timeouts are the owner's published set. This file does not
 * invent 10 or 120. Timeout 0 disarms the countdown and cancels nothing,
 * including when the session has already dropped.
 */

export const CANCEL_ALL_AFTER_REJECTED = 'trade.cancel_all_after_rejected' as const;

export type CancelAllAfterOrder = {
  readonly orderId: string;
  readonly callerId: string;
  readonly status: 'open' | 'cancelled';
  readonly holdAmount: Amount;
};

export type ArmedCancelAllAfter = {
  readonly countdownId: string;
  readonly callerId: string;
  readonly timeoutSec: number;
  readonly deadlineMs: number;
};

export function armCancelAllAfter(input: {
  readonly callerId: string;
  readonly timeoutSec: number;
  readonly publishedTimeouts: readonly number[];
  readonly nowMs: number;
  readonly countdownId: string;
}):
  | { readonly ok: true; readonly armed: ArmedCancelAllAfter | null }
  | { readonly ok: false; readonly code: typeof CANCEL_ALL_AFTER_REJECTED } {
  if (!input.publishedTimeouts.includes(input.timeoutSec)) {
    return { ok: false, code: CANCEL_ALL_AFTER_REJECTED };
  }
  if (input.timeoutSec === 0) return { ok: true, armed: null };
  if (input.timeoutSec < 0) return { ok: false, code: CANCEL_ALL_AFTER_REJECTED };
  return {
    ok: true,
    armed: {
      countdownId: input.countdownId,
      callerId: input.callerId,
      timeoutSec: input.timeoutSec,
      deadlineMs: input.nowMs + input.timeoutSec * 1000,
    },
  };
}

export function expireCancelAllAfter(input: {
  readonly armed: ArmedCancelAllAfter | null;
  readonly nowMs: number;
  readonly orders: readonly CancelAllAfterOrder[];
  readonly alreadyExpiredIds: ReadonlySet<string>;
}): { readonly orders: readonly CancelAllAfterOrder[]; readonly cancelledIds: readonly string[]; readonly releasedHold: Amount } {
  const untouched = {
    orders: input.orders,
    cancelledIds: [] as const,
    releasedHold: 0n as Amount,
  };
  if (input.armed == null || input.armed.timeoutSec === 0) return untouched;
  if (input.alreadyExpiredIds.has(input.armed.countdownId)) return untouched;
  if (input.nowMs < input.armed.deadlineMs) return untouched;
  const cancelledIds: string[] = [];
  let released = 0n;
  const orders = input.orders.map((order) => {
    if (order.callerId !== input.armed!.callerId || order.status !== 'open') return order;
    cancelledIds.push(order.orderId);
    released += order.holdAmount;
    return { ...order, status: 'cancelled' as const, holdAmount: 0n as Amount };
  });
  return { orders, cancelledIds, releasedHold: released as Amount };
}
