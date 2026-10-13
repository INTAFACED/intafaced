import type { FastifyInstance } from 'fastify';

/**
 * What `GET /health` reads from the engine. Structural so the route can be
 * mounted in a test without booting `index.ts` (which connects JetStream at
 * module scope).
 */
export interface HealthEngine {
  readonly isEnabled: boolean;
  readonly isVenueHalted: boolean;
  readonly markets: readonly unknown[];
  readonly restingOrderCount: number;
}

export interface HealthJournal {
  readonly length: number;
}

export interface MatchingHealthBody {
  readonly ok: true;
  readonly service: string;
  readonly enabled: boolean;
  /**
   * Venue halt-all, read live from the engine. svc-edge refuses every NEW trade
   * order when MATCHING_URL is set and this field is missing or not a boolean
   * (`optionalVenueHalted` in svc-edge `matching-venue-halt.ts`).
   */
  readonly venueHalted: boolean;
  readonly markets: number;
  readonly restingOrders: number;
  readonly journalRecords: number;
}

export function matchingHealthBody(service: string, engine: HealthEngine, journal: HealthJournal): MatchingHealthBody {
  return {
    ok: true,
    service,
    enabled: engine.isEnabled,
    venueHalted: engine.isVenueHalted === true,
    markets: engine.markets.length,
    restingOrders: engine.restingOrderCount,
    journalRecords: journal.length,
  };
}

/**
 * `restingOrders` is on here because "the engine came back up" and "the engine
 * came back up still working N orders that may have nothing funding them" read
 * identically on every other field.
 *
 * The journal outlives a database reset. On the dev fleet on 2026-08-03 this
 * engine was holding books for 10 market ids, not one of which still existed in
 * `trade.markets`. Nobody could see that without a shell in the container. The
 * count of orders the engine believes are live is the number an operator needs
 * before anything is allowed to trade against them.
 */
export function registerHealth(app: FastifyInstance, service: string, engine: HealthEngine, journal: HealthJournal): void {
  app.get('/health', async () => matchingHealthBody(service, engine, journal));
}
