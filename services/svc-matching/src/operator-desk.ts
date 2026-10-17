/**
 * Founder read of the live book. Counts come from the engine. A missing
 * method is unreadable, not a zero.
 */

export interface MatchingDeskEngine {
  readonly isVenueHalted?: boolean;
  readonly markets?: readonly string[];
  readonly restingOrderCount?: number;
  isHalted?(marketId: string): boolean;
}

export function matchingInFlightRead(engine: MatchingDeskEngine, asOf: string) {
  const venueKnown = typeof engine.isVenueHalted === 'boolean';
  const markets = engine.markets ? [...engine.markets] : null;
  const restingKnown = typeof engine.restingOrderCount === 'number';
  return {
    asOf,
    venueHalted: venueKnown ? engine.isVenueHalted === true : null,
    venueHaltedCode: venueKnown ? null : 'matching.venue_halt_unreadable',
    markets,
    marketsCode: markets === null ? 'matching.markets_unreadable' : null,
    halted: markets === null ? null : markets.filter((id) => engine.isHalted?.(id) === true),
    restingOrders: restingKnown ? engine.restingOrderCount : null,
    restingOrdersCode: restingKnown ? null : 'matching.resting_count_unreadable',
  };
}

export function idempotencyKeyOrNull(raw: unknown): { ok: true; key: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const key = raw.trim();
  if (key.length < 8 || key.length > 200) return { ok: false };
  return { ok: true, key };
}
