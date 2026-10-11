import { isPublishedDepthLimit } from '../depth-limit.js';
import { DEPTH_VENUE_HALTED, type MatchingTradingResumeEvidence, type DepthMatchingTradingCode } from '../matching-trading.js';
import { withWsSpan } from '../tracing.js';
import type { DepthHub, HubLogger } from './hub.js';
import type { NativeL3Hub } from './l3-hub.js';
import { DepthNoBookError, type DepthSource } from './source.js';

/**
 * THE CLOCK.
 *
 * Everything with a timer in it lives here, so `DepthHub` has none and every
 * one of its behaviours is reachable from a test in a single tick.
 *
 * ── Why this polls ──────────────────────────────────────────────────────────
 *
 * §5.1 gives the engine no outbound depth feed, and the events it does publish
 * cannot rebuild a book: `intafaced.matching.order.accepted` carries
 * `{orderId, marketId, sequence}` — no side, no price, no quantity
 * (packages/events/src/catalog.ts). Deriving depth from the bus would need a
 * wider payload, which is a `packages/events` PR that must land on its own
 * first (§15.2). Until it does, the only complete and correctly-sequenced
 * source of L2 depth in the platform is `GET /markets/:id/depth`. Native L3
 * is a separate `GET /markets/:id/depth/l3` — never synthesized from L2.
 *
 * So: poll it, diff it, and let the sequence do the rest. The cost is bounded
 * and legible — one GET per SUBSCRIBED market per tick. A market nobody is
 * watching is not polled, which is what keeps this from becoming a recorder.
 *
 * ── Why a tick with no change still calls `ingest` ──────────────────────────
 *
 * The hub's lag repair rides on the tick, not on the delta. A client that
 * dropped a frame and then watched the market go quiet must still be repaired,
 * and it can only be repaired on a tick that happens.
 */

/** Private seats with no depth watcher still need matching-down named. */
export interface PrivateMatchingProbe {
  readonly connections: () => number;
  readonly markDown: () => void;
  readonly markUp: () => void;
  /** Venue / board trading status from GET /markets — private-only seats have no depth poll. */
  readonly markTrading?: (marketId: string, code: DepthMatchingTradingCode | null, confirmedOpen?: MatchingTradingResumeEvidence) => void;
}

export interface DepthPollerOptions {
  readonly intervalMs: number;
  /** Owner-published L2 top-N. Unset = unpublished; tick does not invent 50. */
  readonly depthLimit: number | undefined;
  readonly marketsRefreshMs: number;
  readonly probePrivate?: PrivateMatchingProbe;
  /** Native L3 hub — polled via `/depth/l3`, never `snapshot()`. */
  readonly l3Hub?: NativeL3Hub;
}

export class DepthPoller {
  readonly #source: DepthSource;
  readonly #hub: DepthHub;
  readonly #options: DepthPollerOptions;
  readonly #log: HubLogger;

  #timer: ReturnType<typeof setInterval> | null = null;
  #marketsTimer: ReturnType<typeof setInterval> | null = null;
  /** One tick at a time: a slow upstream must not stack overlapping sweeps. */
  #ticking = false;

  constructor(source: DepthSource, hub: DepthHub, options: DepthPollerOptions, log: HubLogger) {
    this.#source = source;
    this.#hub = hub;
    this.#options = options;
    this.#log = log;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs);
    // Neither timer should hold the process open on its own.
    this.#timer.unref?.();
    // `marketsRefreshMs: 0` is the hub's do-not-cache window: every miss
    // refetches. Node turns a delay below 1 into 1, so passing 0 here would
    // call refreshMarkets every turn. Leave the markets timer unset.
    if (this.#options.marketsRefreshMs > 0) {
      this.#marketsTimer = setInterval(() => {
        void this.#hub.refreshMarkets().catch((err: unknown) => {
          this.#log.warn({ err: String(err) }, 'ws: market list refresh failed — serving the last known list');
        });
      }, this.#options.marketsRefreshMs);
      this.#marketsTimer.unref?.();
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#marketsTimer) clearInterval(this.#marketsTimer);
    this.#timer = null;
    this.#marketsTimer = null;
  }

  /** One sweep across every subscribed market. Exposed so tests drive the clock. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const markets = this.#hub.activeMarkets;
      const limit = this.#options.depthLimit;
      // Concurrent, not sequential: with N markets a sequential sweep makes the
      // last book's latency N round trips, and depth latency is the product.
      // Unpublished window: never invent 50. L3 / private probes do not use it.
      if (isPublishedDepthLimit(limit)) {
        await Promise.all(
          markets.map(async (marketId) => {
            try {
              await withWsSpan('ws.depth.poll', { marketId, connections: this.#hub.connections }, async () => {
                const snapshot = await this.#source.snapshot(marketId, limit);
                this.#hub.noteMatchingTrading(
                  marketId,
                  this.#source.trading?.(marketId) ?? null,
                  this.#source.tradingOpenEvidence?.(marketId) ?? false,
                );
                this.#hub.ingest(snapshot);
              });
            } catch (err) {
              // One failed read is not a reason to tear down subscriptions: the
              // clients' last proven book is still valid as of its sequence.
              // 404 = matching is up and the book is absent. Anything else is
              // engine-down and must be named — never a silent empty snapshot.
              if (err instanceof DepthNoBookError) this.#hub.noteMatchingReachable(marketId);
              else this.#hub.markEngineUnavailable(marketId);
              this.#log.warn({ marketId, err: String(err) }, 'ws: depth poll failed');
            }
          }),
        );
      }
      await this.#options.l3Hub?.tick();
      await this.#probePrivateMatching();
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Kill-matching with only a private blotter open never hits a depth snapshot.
   * Probe `GET /markets` so that door still names `orders.engine_unavailable`.
   * Depth subscribers already drive the flip via snapshot fail + hub callback.
   */
  async #probePrivateMatching(): Promise<void> {
    const probe = this.#options.probePrivate;
    if (!probe || probe.connections() === 0) return;
    if (this.#hub.activeMarkets.length > 0) return;
    try {
      const ids = await this.#source.markets();
      probe.markUp();
      if (probe.markTrading) {
        const venueHalted = this.#source.venueHalted?.() === true;
        // One edge. The orders frame for venue halt carries no market id, so
        // repeating DEPTH_VENUE_HALTED per listed market is a second copy.
        probe.markTrading('*', venueHalted ? DEPTH_VENUE_HALTED : null, this.#source.tradingOpenEvidence?.('*') ?? false);
        for (const id of ids) {
          const code = this.#source.trading?.(id) ?? null;
          if (code === DEPTH_VENUE_HALTED) continue;
          probe.markTrading(id, code, this.#source.tradingOpenEvidence?.(id) ?? false);
        }
      }
    } catch (err) {
      probe.markDown();
      this.#log.warn({ err: String(err) }, 'ws: matching probe for private stream failed — disclosing orders.engine_unavailable');
    }
  }
}
