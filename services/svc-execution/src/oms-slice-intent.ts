import { parseAmount } from '@intafaced/ledger-client';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { EmsOrderEvidence } from './oms-ems-store.js';

export function hasRetainedSliceIntent(evidence: EmsOrderEvidence): boolean {
  try {
    const terms: unknown = JSON.parse(evidence.requestFingerprint ?? '');
    return !!terms && typeof terms === 'object' && 'kind' in terms && terms.kind === 'slice';
  } catch {
    return false;
  }
}

/** Terminal evidence for the new slice contract; older command fingerprints are unchanged. */
export function hasTerminalSliceEvidence(evidence: EmsOrderEvidence): boolean {
  return (
    hasRetainedSliceIntent(evidence) &&
    (evidence.state === 'CANCELED' ||
      evidence.state === 'REJECTED' ||
      evidence.state === 'UNWIRED' ||
      evidence.execution?.status === 'filled')
  );
}

/** Bind new slice observations to their retained terms. Older fingerprint contracts are unchanged. */
export function matchesRetainedSliceIntent(evidence: EmsOrderEvidence, order: VenueOrder): boolean {
  let terms: unknown;
  try {
    terms = JSON.parse(evidence.requestFingerprint ?? '');
  } catch {
    return true;
  }
  if (!terms || typeof terms !== 'object' || !('kind' in terms) || terms.kind !== 'slice') return true;
  const original = terms as Record<string, unknown>;
  if (typeof original.amount !== 'string' || typeof original.limitPrice !== 'string') return false;
  try {
    const amount = parseAmount(original.amount);
    return (
      original.parentClientOrderId === evidence.parentClientOrderId &&
      original.venueId === evidence.venueId &&
      order.venueId === original.venueId &&
      order.clientOrderId === evidence.clientOrderId &&
      order.symbol === original.symbol &&
      order.side === original.side &&
      order.type === 'limit' &&
      order.amount === amount &&
      order.price === parseAmount(original.limitPrice) &&
      order.filled >= 0n &&
      order.filled <= amount &&
      order.remaining >= 0n &&
      order.remaining <= amount &&
      (order.filled === 0n || order.averagePrice !== null)
    );
  } catch {
    return false;
  }
}
