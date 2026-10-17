import { trace } from '@opentelemetry/api';

/**
 * Signal when a capture is logged as `payment.captured_over_cap`.
 *
 * The durable log stays `pay.control_audit` (written by the capture guard).
 * This adds the two things ops can watch without scanning that table:
 *   - a process-local counter (same shape as the telemetry counters: one
 *     process, resets on restart, Prometheus sums replicas)
 *   - an alert event on the active money span, plus any listener `index.ts`
 *     wires to the service log
 *
 * The merchant in-app feed is a separate door (`recordMerchantNotification`),
 * called by the guard in the same transaction as the audit row.
 *
 * The counter can lead the committed rows by one if the capture transaction
 * rolls back after this runs. The audit row is the durable count.
 */

export interface CapturedOverCapSignal {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly assetCode: string;
  readonly amount: string;
  readonly exceeded: readonly string[];
}

export type CapturedOverCapListener = (signal: CapturedOverCapSignal) => void;

let total = 0;
const listeners = new Set<CapturedOverCapListener>();

/** How many over-cap captures this process has signalled. */
export function capturedOverCapTotal(): number {
  return total;
}

/** Test isolation. Production never resets a counter except by process exit. */
export function resetCapturedOverCapTotalForTests(): void {
  total = 0;
}

/** Returns an unsubscribe. A throwing listener is swallowed by `emitCapturedOverCap`. */
export function onCapturedOverCap(listener: CapturedOverCapListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitCapturedOverCap(signal: CapturedOverCapSignal): void {
  total += 1;
  const span = trace.getActiveSpan();
  span?.addEvent('payment.captured_over_cap', {
    'intafaced.payment_id': signal.paymentId,
    'intafaced.merchant_id': signal.merchantId,
    'intafaced.asset_id': signal.assetCode,
    'intafaced.amount': signal.amount,
    'intafaced.exceeded': signal.exceeded.join(','),
  });
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch {
      // A broken logger must not roll back a capture whose money has already moved.
    }
  }
}
