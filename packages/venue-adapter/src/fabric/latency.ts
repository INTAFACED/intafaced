import type { VenueHealth } from '../source.js';
import {
  isGraded,
  type LatencyGrade,
  type LatencyMeasurement,
  type LatencyObservation,
  type VenueLatencyGrade,
} from '@intafaced/venue-contracts';
import type { StreamPort } from './transport.js';

// The vocabulary lives in `@intafaced/venue-contracts` (`latency.ts`) so that
// `MarketDataAdapter` can declare `latencyGrade()` — an adapter cannot offer a
// grade through an interface with no word for one. Re-exported here because this
// is where callers already look for grading, and a caller should not have to know
// which of the two packages a type happens to be declared in.
export { isGraded, isRestGrade, isWsGrade } from '@intafaced/venue-contracts';
export type {
  GradedVenueLatency,
  LatencyGrade,
  LatencyMeasurement,
  LatencyObservation,
  ObservationOutcome,
  RestLatencyGrade,
  VenueLatencyGrade,
  WsLatencyGrade,
} from '@intafaced/venue-contracts';

/**
 * LATENCY GRADING — §27's "every adapter continuously scored — round-trip, book
 * staleness, reject rates — feeding execution routing weights live".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A GRADE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A venue does not fail cleanly. It gets slow, then it gets slower, then some
 * requests start being rejected, and long before it is "down" it has become the
 * wrong venue to send an order to. Health as a boolean cannot express any of
 * that, so a fabric with only a boolean discovers the degradation by routing
 * into it.
 *
 * The grade is the continuous version of the boolean, and it is deliberately
 * computed from three independent signals, because each catches a failure the
 * others miss:
 *
 *   · **Round-trip p95, not the mean.** The mean is dominated by the fast
 *     majority; the tail is what an order actually experiences when it matters.
 *     A venue with a 30ms mean and a 4s p95 is a venue that will hang on the
 *     one request you cannot afford to have hang.
 *   · **Reject rate.** A venue answering fast and refusing half of what it is
 *     sent is worse than a slow one that works, and pure latency scores it
 *     top of the list.
 *   · **Staleness.** The failure that actually costs money: a venue that has
 *     stopped updating still answers, still quotes, and still looks fine — right
 *     up until the fill comes back at a price from thirty seconds ago.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE STATES, NOT TWO — `ungraded` vs `provisional` vs graded
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These are routinely confused and they are not the same claim:
 *
 *   · **ungraded** (`grade: null`) — NO evidence. Nothing has been observed in
 *     the window. We say so, rather than scoring it. See the `latency.ts` header
 *     in `@intafaced/venue-contracts` for why this is `null` and emphatically
 *     not `'F'`, and for D-S-18, the Accepted ADR that requires it.
 *   · **provisional** — THIN evidence. Two samples do not make a p95, and a
 *     grader that answered "A" on two fast reads would be inventing confidence
 *     the router would then act on. The letter is returned, because an honest
 *     weak signal beats no signal, but it is labelled and it is not allowed to
 *     exclude a venue by itself.
 *   · **graded** — enough evidence for the letter to mean something.
 *
 * A consumer branches on `isGraded` first and `provisional` second. Branching on
 * `provisional` alone silently lumps "never measured" in with "barely measured".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW IT FEEDS ROUTING, WITHOUT BREAKING BEST EXECUTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The grade does NOT adjust prices. `router.ts` ranks on effective price, and
 * `internalPreference` is the ONE documented thumb on that scale; a second,
 * latency-shaped thumb would quietly become a way to prefer whichever venue we
 * happened to be measuring favourably.
 *
 * What it does instead is set `VenueHealth` — `healthy` and `latencyMs` — which
 * the existing router already consumes: an unhealthy venue is EXCLUDED AND
 * REPORTED in `RoutePlan.rejected` (§27's requirement, exactly), and `latencyMs`
 * breaks ties between venues at the same price. That wiring is two functions:
 * `routingWeightFromGrade` (score-feed eligibility — unscored is **zero**) and
 * `healthFromGrade` (turns weight zero into `healthy: false` the router already
 * understands).
 *
 * Producing the grade is this file's job. CONSUMING it — an §28 cost model that
 * requires a graded latency term alongside fees, expected impact and transfer
 * cost — lives in `cost-model.ts` / `planRoute({ costTermsByVenue })`
 * (D26-P1-X3). §28:770 makes the grade ONE INPUT to that model, never a ranking
 * rule of its own, and D-S-06 leaves the bounded, tested 5 bps internal
 * tie-break in `router.ts` as the only permitted preference. A second
 * latency-shaped ranking rule is therefore not a matter of taste here; it is
 * forbidden. Connect's score feed stops at eligibility weight (D26-P1-X2):
 * unscored → 0. Letter→bps scaling stays an owner magnitude (D-S-14), not
 * invented on this surface.
 */

/**
 * Default measurement for a grader that does not say otherwise. See the
 * `latency.ts` header in `@intafaced/venue-contracts` for the full list of
 * what these numbers are NOT — in short: not stream delivery lag (depth-delta
 * travel after the socket is open), not book staleness, not venue-side
 * matching, and not time spent waiting on our own rate-limit governor.
 *
 * REST and WS live on SEPARATE graders. Mixing them in one window would let a
 * consumer read handshake time as HTTP time.
 */
export const REST_MEASUREMENT: LatencyMeasurement = 'rest-round-trip';
export const WS_MEASUREMENT: LatencyMeasurement = 'ws-round-trip';

export interface LatencyThresholds {
  /** p95 round-trip ceilings, in ms, for grades A/B/C/D. Above the last is F. */
  readonly p95Ms: readonly [a: number, b: number, c: number, d: number];
  /** Reject-rate ceilings in bps for grades A/B/C/D. */
  readonly rejectBps: readonly [a: number, b: number, c: number, d: number];
  /** Data older than this is an automatic F, whatever the latency looks like. */
  readonly maxStalenessMs: number;
  /** Below this, the grade is `provisional`. */
  readonly minSamples: number;
}

export const DEFAULT_THRESHOLDS: LatencyThresholds = {
  p95Ms: [150, 400, 1_000, 3_000],
  rejectBps: [50, 200, 1_000, 3_000],
  maxStalenessMs: 5_000,
  minSamples: 10,
};

/**
 * A rolling window of observations for one venue.
 *
 * Bounded by BOTH count and age. Count alone lets a venue that went quiet keep a
 * grade earned an hour ago; age alone lets a busy venue accumulate without
 * limit. Neither bound is optional for that reason.
 */
export class VenueLatencyGrader {
  readonly venueId: string;
  /** Which latency this window holds. Set at construction; never inferred from samples. */
  readonly measurement: LatencyMeasurement;
  readonly #thresholds: LatencyThresholds;
  readonly #maxSamples: number;
  readonly #maxAgeMs: number;
  #window: LatencyObservation[] = [];
  #lastObservedAt: Date | null = null;

  constructor(
    venueId: string,
    options: {
      thresholds?: LatencyThresholds;
      maxSamples?: number;
      maxAgeMs?: number;
      measurement?: LatencyMeasurement;
    } = {},
  ) {
    this.venueId = venueId;
    this.measurement = options.measurement ?? REST_MEASUREMENT;
    this.#thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.#maxSamples = options.maxSamples ?? 200;
    this.#maxAgeMs = options.maxAgeMs ?? 60_000;
  }

  observe(observation: LatencyObservation): void {
    this.#window.push(observation);
    this.#lastObservedAt = observation.at;
    this.#evict(observation.at);
  }

  /** Convenience for the common case: time a call and record the outcome. */
  async time<T>(call: () => Promise<T>, clock: () => number = Date.now): Promise<T> {
    const started = clock();
    try {
      const result = await call();
      this.observe({ roundTripMs: clock() - started, outcome: 'ok', at: new Date(clock()) });
      return result;
    } catch (error) {
      this.observe({ roundTripMs: clock() - started, outcome: 'error', at: new Date(clock()) });
      throw error;
    }
  }

  grade(now: Date = new Date()): VenueLatencyGrade {
    this.#evict(now);

    const samples = this.#window.length;
    const staleMs = this.#lastObservedAt ? now.getTime() - this.#lastObservedAt.getTime() : null;
    const successes = this.#window
      .filter((o) => o.outcome === 'ok')
      .map((o) => o.roundTripMs)
      .sort((a, b) => a - b);
    const rejects = this.#window.filter((o) => o.outcome === 'reject').length;
    const errors = this.#window.filter((o) => o.outcome === 'error').length;

    // ── UNGRADED ────────────────────────────────────────────────────────────
    //
    // No observations in the window is NOT a grade. D-S-18 (Accepted,
    // `docs/adr/2026-08-04-predict-quant-connect-law.md`): "A score for an
    // adapter that has not run is not a low score — it is no score."
    //
    // This returned `'F'` until #1148's second venue made grading mean anything,
    // and `'F'` was wrong in both directions: it asserted a measured property of
    // a venue we may never have contacted, and it was indistinguishable from a
    // venue we DID measure and found unusable. Those two need opposite
    // responses — one is a venue fault, the other is unwired plumbing on our
    // side — so they must not share a representation.
    //
    // Every derived statistic is `null` here for the same reason. A 0% reject
    // rate over zero samples reads as "never once refused us", which is a
    // perfect score awarded for silence. Defaulting p95 to 0ms would be worse:
    // `gradeFor(0, p95Ms)` is **A** — silence scored as fastest.
    //
    // `provisional` is false. The contract word means "thin letter": a letter
    // with too few samples. There is no letter here. Consumers must branch on
    // `isGraded`, not on `provisional`.
    if (samples === 0) {
      return {
        venueId: this.venueId,
        measurement: this.measurement,
        grade: null,
        samples: 0,
        p50Ms: null,
        p95Ms: null,
        rejectRateBps: null,
        errorRateBps: null,
        staleMs,
        provisional: false,
        reasons: ['ungraded — no observations in the window; not measured, so not scored'],
      };
    }

    const rejectRateBps = Math.round((rejects / samples) * 10_000);
    const errorRateBps = Math.round((errors / samples) * 10_000);
    const p50Ms = percentile(successes, 50);
    const p95Ms = percentile(successes, 95);

    const reasons: string[] = [];
    let grade: LatencyGrade = 'A';

    if (staleMs !== null && staleMs > this.#thresholds.maxStalenessMs) {
      reasons.push(`last observation ${staleMs}ms ago, ceiling ${this.#thresholds.maxStalenessMs}ms`);
      grade = 'F';
    }

    if (p95Ms === null) {
      // Answering, but nothing has succeeded. Latency is irrelevant.
      reasons.push('no successful observation in the window');
      grade = 'F';
    } else {
      const latencyGrade = gradeFor(p95Ms, this.#thresholds.p95Ms);
      if (latencyGrade !== 'A') reasons.push(`p95 round-trip ${p95Ms}ms`);
      grade = worse(grade, latencyGrade);
    }

    const rejectGrade = gradeFor(rejectRateBps, this.#thresholds.rejectBps);
    if (rejectGrade !== 'A') reasons.push(`reject rate ${bpsToPercent(rejectRateBps)}`);
    grade = worse(grade, rejectGrade);

    const errorGrade = gradeFor(errorRateBps, this.#thresholds.rejectBps);
    if (errorGrade !== 'A') reasons.push(`error rate ${bpsToPercent(errorRateBps)}`);
    grade = worse(grade, errorGrade);

    return {
      venueId: this.venueId,
      measurement: this.measurement,
      grade,
      samples,
      p50Ms,
      p95Ms,
      rejectRateBps,
      errorRateBps,
      staleMs,
      provisional: samples < this.#thresholds.minSamples,
      reasons,
    };
  }

  #evict(now: Date): void {
    const cutoff = now.getTime() - this.#maxAgeMs;
    this.#window = this.#window.filter((o) => o.at.getTime() >= cutoff);
    if (this.#window.length > this.#maxSamples) {
      this.#window = this.#window.slice(this.#window.length - this.#maxSamples);
    }
  }
}

/**
 * Turn a grade into the `VenueHealth` the router already consumes.
 *
 * This is the entire "feeding routing weights live" wiring, and it is one
 * function on purpose. An `F` becomes `healthy: false`, which the router turns
 * into a `RejectedVenue` with a reason — §27's "excluded and reported", using
 * machinery that already exists rather than a parallel path that could disagree
 * with it.
 *
 * `latencyMs` carries p95, not p50 or the mean. The router uses it to break ties
 * at equal price, and the venue you want at equal price is the one whose SLOW
 * requests are least slow.
 *
 * A `provisional` grade is never allowed to mark a venue unhealthy on its own:
 * excluding a venue on two samples would take real liquidity off the router for
 * no evidence. It can still be F for staleness, which needs no sample count.
 *
 * ── UNGRADED IS NOT PERMISSION TO ROUTE ─────────────────────────────────────
 *
 * The asymmetry in `venue-contracts/latency.ts` is enforced here. An ungraded
 * venue is not given a bad grade, but it is NOT routable either — D-S-18's
 * second clause is "an unscored adapter must not receive routing weight". So
 * `grade: null` produces `healthy: false`, and the two statements coexist
 * without contradiction: we do not claim the venue is slow, we decline to route
 * to a venue we have not measured.
 *
 * ── `UNMEASURED_LATENCY_MS` IS A SENTINEL, AND IT ONLY SORTS ONE WAY ─────────
 *
 * `VenueHealth.latencyMs` is a required `number` (`source.ts`), shared with
 * every other rail in the repo, so "no measurement" has no `null` to use here
 * and something must be written. That is the one place this file cannot follow
 * the refuse-rather-than-fabricate rule to the letter, so the mitigation is
 * directional rather than representational:
 *
 * The sentinel is the MAXIMUM safe integer, and `router.ts` sorts `latencyMs`
 * ASCENDING at its tie-break. An unmeasured venue therefore always loses a tie
 * it participates in — it can never be preferred on a latency it does not have.
 * Being wrong in the conservative direction is the whole of the guarantee.
 *
 * It is emitted in two cases, and only one of them is also `healthy: false`:
 *
 *   · ungraded — no observations at all. Excluded, so it never reaches ranking.
 *   · graded, but with no SUCCESSFUL observation (every call errored). If that
 *     grade is `provisional`, the venue stays healthy on too-few-samples and
 *     does carry the sentinel into ranking — where, per the above, it loses.
 *
 * Both are pinned by tests. If a future change ever flips that sort to
 * descending, or gives the sentinel a small value, an unmeasured venue starts
 * winning tie-breaks on money — so those pins are load-bearing, not decorative.
 */
export const UNMEASURED_LATENCY_MS = Number.MAX_SAFE_INTEGER;

/**
 * Connect score-feed routing weight (D26-P1-X2 / D-S-18).
 *
 * Eligibility is a **measured** round-trip of THIS grade's measurement, not a
 * letter. An adapter that
 * has never run (`grade: null`) contributes **zero**. So does a letter with
 * `p95Ms: null` — answering in errors is not a latency score, and substituting
 * a sentinel number would treat missing as a score (the residual this door
 * exists to close). A graded adapter with a live p95 contributes **one** —
 * eligibility only. Letter scaling belongs to `execution.sor` (§28).
 *
 * Consumers that need a numeric weight MUST call this before using the letter.
 * Returning 0 for null is the safety property; treating null as "no news is
 * good news" is the defect D-S-18 forbids. `healthFromGrade` reads this same
 * gate so weight and routability cannot drift apart.
 */
export function routingWeightFromGrade(grade: VenueLatencyGrade): 0 | 1 {
  if (!isGraded(grade)) return 0;
  // Zero samples is ungraded even if a caller forged a letter. 0ms is grade A;
  // treating silence as 0ms would score the quietest venue as the fastest.
  if (grade.samples === 0) return 0;
  if (grade.p95Ms === null) return 0;
  return 1;
}

/**
 * The live latency score, or `null` when there is none.
 *
 * Public cost-model / score-feed door: missing measurement is **absence**, not
 * `0` (which would win every tie) and not `UNMEASURED_LATENCY_MS` (which is a
 * number a consumer could rank on). Never an estimate.
 */
export function measuredLatencyMs(grade: VenueLatencyGrade): number | null {
  if (routingWeightFromGrade(grade) === 0) return null;
  return grade.p95Ms;
}

export function healthFromGrade(grade: VenueLatencyGrade, lastUpdate: Date): VenueHealth {
  // D26-P1-X2: weight zero and "not healthy" are the same gate. The score feed
  // is consulted first so a future change cannot mark an unscored venue healthy
  // while still advertising weight zero (or the reverse). `isGraded` narrows
  // the graded branch for the type checker.
  const liveMs = measuredLatencyMs(grade);
  if (routingWeightFromGrade(grade) === 0 || liveMs === null || !isGraded(grade)) {
    const why = isGraded(grade) ? 'no live latency score' : 'ungraded';
    return {
      healthy: false,
      latencyMs: UNMEASURED_LATENCY_MS,
      lastUpdate,
      reason: `${why}: ${grade.reasons.join('; ')}`,
    };
  }

  const failing = grade.grade === 'F';
  // A grade built on too little data may not exclude a venue on its own:
  // excluding on two samples takes real liquidity off the router for no
  // evidence. Staleness is the exception: an F whose last observation is past
  // maxStalenessMs excludes with no sample count, so a silent venue cannot
  // stay routable on its old fast p95. The no-samples / no-p95 case never
  // reaches here — it is handled above. `liveMs` is the measured p95, never
  // a substituted sentinel.
  const trusted = !grade.provisional;
  const stale = grade.staleMs !== null && grade.staleMs > DEFAULT_THRESHOLDS.maxStalenessMs;

  return {
    healthy: !(failing && (trusted || stale)),
    latencyMs: liveMs,
    lastUpdate,
    reason: grade.reasons.length > 0 ? `grade ${grade.grade}: ${grade.reasons.join('; ')}` : undefined,
  };
}

/** Every graded venue in one place, so a health endpoint has one thing to read. */
export class LatencyGradeRegistry {
  readonly #graders = new Map<string, VenueLatencyGrader>();
  readonly #options: { thresholds?: LatencyThresholds; maxSamples?: number; maxAgeMs?: number };

  constructor(options: { thresholds?: LatencyThresholds; maxSamples?: number; maxAgeMs?: number } = {}) {
    this.#options = options;
  }

  /**
   * Creates on first use — a venue we have not measured yet still needs somewhere to record.
   *
   * REST and WS are separate keys. `for(id)` is REST, matching every existing
   * caller. `for(id, 'ws-round-trip')` is the handshake window, never mixed.
   */
  for(venueId: string, measurement: LatencyMeasurement = REST_MEASUREMENT): VenueLatencyGrader {
    const key = `${venueId}\0${measurement}`;
    let grader = this.#graders.get(key);
    if (!grader) {
      grader = new VenueLatencyGrader(venueId, { ...this.#options, measurement });
      this.#graders.set(key, grader);
    }
    return grader;
  }

  gradeAll(now: Date = new Date()): VenueLatencyGrade[] {
    return [...this.#graders.values()].map((grader) => grader.grade(now));
  }
}

/**
 * Time `StreamPort.open` (the WebSocket handshake) onto a `ws-round-trip` grader.
 *
 * This is the observe path. Deleting the `observe` calls makes the WS-grade
 * tests fail: the wrapper exists so REST samples cannot be relabelled as WS,
 * and so a fake `StreamPort` in an adapter test still produces a real
 * handshake observation.
 *
 * First-frame / depth-delta travel is NOT timed here. A quiet book would
 * look like a slow stream, which is scoring silence.
 */
export function observeStreamRoundTrip(port: StreamPort, grader: VenueLatencyGrader, clock: () => number = Date.now): StreamPort {
  if (grader.measurement !== WS_MEASUREMENT) {
    throw new Error(`observeStreamRoundTrip records ${WS_MEASUREMENT}; this grader measures ${grader.measurement}`);
  }
  return {
    async open(url) {
      const started = clock();
      try {
        const handle = await port.open(url);
        grader.observe({ roundTripMs: clock() - started, outcome: 'ok', at: new Date(clock()) });
        return handle;
      } catch (error) {
        grader.observe({ roundTripMs: clock() - started, outcome: 'error', at: new Date(clock()) });
        throw error;
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile over a pre-sorted array. `null` when empty. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/** First threshold the value clears. Thresholds are ceilings, ascending. */
function gradeFor(value: number, thresholds: readonly [number, number, number, number]): LatencyGrade {
  if (value <= thresholds[0]) return 'A';
  if (value <= thresholds[1]) return 'B';
  if (value <= thresholds[2]) return 'C';
  if (value <= thresholds[3]) return 'D';
  return 'F';
}

const ORDER: readonly LatencyGrade[] = ['A', 'B', 'C', 'D', 'F'];

/** The worse of two grades. A venue is as good as its weakest signal, not its best. */
function worse(a: LatencyGrade, b: LatencyGrade): LatencyGrade {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
