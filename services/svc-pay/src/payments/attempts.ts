/**
 * One rail try, read from a `rail.authorize` event. The payment's own status
 * stays the column: a later capture is not a new attempt, and deriving the
 * shown payment status from the latest attempt would hide it.
 *
 * `mapsTo` is the fixed map used only while the payment is still at the attempt
 * (pending stays created, authorized stays authorized, a decline is failed).
 */
export const ATTEMPT_STATUS_MAP = {
  pending: 'created',
  authorized: 'authorized',
  failed: 'failed',
} as const;

export type PaymentAttemptStatus = keyof typeof ATTEMPT_STATUS_MAP;

export interface PaymentAttemptView {
  id: string;
  at: string;
  status: PaymentAttemptStatus;
  railRef: string | null;
  mapsTo: (typeof ATTEMPT_STATUS_MAP)[PaymentAttemptStatus];
}

export function attemptFromRailAuthorize(event: { id: string; ts: Date; payload: unknown }): PaymentAttemptView | null {
  if (!event.id || Number.isNaN(event.ts.getTime())) return null;
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const railRef = typeof payload.railRef === 'string' && payload.railRef.length > 0 ? payload.railRef : null;
  let status: PaymentAttemptStatus;
  if (payload.ok === false) status = 'failed';
  else if (payload.status === 'pending') status = 'pending';
  else if (payload.ok === true) status = 'authorized';
  else return null;
  return {
    id: event.id,
    at: event.ts.toISOString(),
    status,
    railRef,
    mapsTo: ATTEMPT_STATUS_MAP[status],
  };
}
