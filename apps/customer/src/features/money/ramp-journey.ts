import { decimalSchema, parseAmount } from '../../shared/money';

/** `live` only on a real rail. `none` has no provider at all; `simulated` has a test rail that never reaches a real bank or network. */
export type RampGate = 'none' | 'simulated' | 'live';
export function rampGate(programme: { id: string; simulated: boolean } | null): RampGate {
  if (!programme || programme.id === 'none') return 'none';
  return programme.simulated ? 'simulated' : 'live';
}

export const RAMP_STEPS = ['amount', 'quote', 'review', 'status'] as const;
export type RampStep = (typeof RAMP_STEPS)[number];

export function destinationProblem(ref: string): 'empty' | 'spaces' | 'long' | null {
  const value = ref.trim();
  if (!value) return 'empty';
  if (/\s/.test(value)) return 'spaces';
  if (value.length > 256) return 'long';
  return null;
}

export function offrampAmountProblem(amount: string, available: string | null): 'invalid' | 'zero' | 'exceeds' | null {
  if (!decimalSchema.safeParse(amount).success) return 'invalid';
  if (parseAmount(amount) <= 0n) return 'zero';
  if (available !== null && decimalSchema.safeParse(available).success && parseAmount(amount) > parseAmount(available)) return 'exceeds';
  return null;
}

/** One request id is both the cash-out id and its client reference, so a retried review is the same cash-out. */
export function buildOfframpInput(requestId: string, values: { assetId?: string; amount?: string; destinationRef?: string }) {
  return {
    offrampId: requestId,
    clientRef: requestId,
    assetId: (values.assetId ?? '').trim(),
    amount: (values.amount ?? '').trim(),
    kind: 'crypto' as const,
    destinationRef: (values.destinationRef ?? '').trim(),
  };
}

/** The reply must be the cash-out that was asked for, with the asked-for asset, amount and destination. */
export function offrampMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const row = data as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof input.offrampId === 'string' &&
    row.id.toLowerCase() === input.offrampId.toLowerCase() &&
    row.assetId === input.assetId &&
    row.destinationRef === input.destinationRef &&
    typeof row.amount === 'string' &&
    typeof input.amount === 'string' &&
    decimalSchema.safeParse(row.amount).success &&
    parseAmount(row.amount) === parseAmount(input.amount)
  );
}

/** Where a cash-out stands, in a customer's words. Unknown service words are never guessed at. */
export function rampStatusKey(status: string): 'pending' | 'done' | 'failed' | 'unknown' {
  const word = status.toLowerCase();
  if (['pending', 'processing', 'held', 'submitted', 'created'].includes(word)) return 'pending';
  if (['settled', 'completed', 'complete', 'confirmed', 'paid'].includes(word)) return 'done';
  if (['rejected', 'failed', 'cancelled', 'canceled', 'expired', 'reversed'].includes(word)) return 'failed';
  return 'unknown';
}
