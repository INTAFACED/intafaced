import type { RailAdapter, SettlementInstruction } from './rails/rail-adapter.js';

/**
 * Marker written in the same committed transaction as the hold's journal,
 * before `adapter.payout`. `idempotencyKey` is the provider key that call uses.
 * A later resume that still has this row and no rail answer must not treat a
 * refusal as proof the send never happened.
 */
export function dispatchedMarker(
  idempotencyKey: string,
  holdIdempotencyKey: string,
): { state: 'dispatched'; idempotencyKey: string; holdIdempotencyKey: string } {
  return { state: 'dispatched', idempotencyKey, holdIdempotencyKey };
}

export function readDispatchedKey(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const key = (payload as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === 'string' && key.trim() !== '' ? key : null;
}

/** The key `adapter.payout` will send under, or null when the rail does not name one. */
export function payoutRailKey(adapter: RailAdapter, instruction: SettlementInstruction): string | null {
  if (typeof adapter.payoutIdempotencyKey !== 'function') return null;
  const key = adapter.payoutIdempotencyKey(instruction);
  return typeof key === 'string' && key.trim() !== '' ? key : null;
}
