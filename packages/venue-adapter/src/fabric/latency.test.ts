import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { type MarketDataAdapter, VenueUnavailableError } from '@intafaced/venue-contracts';
import {
  healthFromGrade,
  isGraded,
  LatencyGradeRegistry,
  measuredLatencyMs,
  observeStreamRoundTrip,
  REST_MEASUREMENT,
  routingWeightFromGrade,
  UNMEASURED_LATENCY_MS,
  VenueLatencyGrader,
  WS_MEASUREMENT,
} from './latency.js';
import { isRoutable, type LiquiditySource, type VenueHealth } from '../source.js';
import { planRoute } from '../router.js';
import { webSocketStreamPort, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from './transport.js';
import { BINANCE_SPOT_RATE_LIMIT, BinanceSpotMarketData } from './venues/binance-spot.js';
import { BybitSpotMarketData } from './venues/bybit-spot.js';
import { RateLimitGovernor } from './rate-limit.js';

const T0 = new Date('2026-07-30T12:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function feed(
  grader: VenueLatencyGrader,
  count: number,
  roundTripMs: number,
  outcome: 'ok' | 'reject' | 'error' = 'ok',
  startAt = 0,
): void {
  for (let i = 0; i < count; i += 1) grader.observe({ roundTripMs, outcome, at: at(startAt + i) });
}

describe('VenueLatencyGrader', () => {
  it('reads an unmeasured venue as UNGRADED — no score, not a low score', () => {
    const grade = new VenueLatencyGrader('v').grade(T0);

    // D-S-18: "a score for an adapter that has not run is not a low score — it
    // is no score". `null`, the fabric's existing word for a refused answer.
    expect(grade.grade).toBeNull();
    expect(isGraded(grade)).toBe(false);
    expect(grade.samples).toBe(0);
    expect(grade.reasons[0]).toContain('ungraded');
  });

  it('invents no statistic for a venue it has never measured', () => {
    const grade = new VenueLatencyGrader('v').grade(T0);

    // Not 0. A 0% reject rate over zero samples reads as "never once refused
    // us", which is a perfect score awarded for silence.
    expect(grade.rejectRateBps).toBeNull();
    expect(grade.errorRateBps).toBeNull();
    expect(grade.p50Ms).toBeNull();
    expect(grade.p95Ms).toBeNull();
    expect(grade.staleMs).toBeNull();
    // Ungraded is not a thin letter. `provisional` means evidence too thin to
    // trust the letter; there is no letter.
    expect(grade.provisional).toBe(false);
  });

  it('fails if silence is scored as fast', () => {
    // D26-P1-X1 done-bar (3). Defaulting missing p95 to 0ms would grade A
    // (`gradeFor(0, p95Ms)` is A) and win every equal-price tie.
    const grade = new VenueLatencyGrader('silent').grade(T0);
    const health = healthFromGrade(grade, T0);

    expect(grade.grade).toBeNull();
    expect(grade.grade).not.toBe('A');
    expect(grade.p50Ms).not.toBe(0);
    expect(grade.p95Ms).not.toBe(0);
    expect(measuredLatencyMs(grade)).toBeNull();
    expect(measuredLatencyMs(grade)).not.toBe(0);
    expect(routingWeightFromGrade(grade)).toBe(0);
    expect(health.healthy).toBe(false);
    expect(health.latencyMs).toBe(UNMEASURED_LATENCY_MS);
    expect(health.latencyMs).not.toBe(0);
  });

  it('computes the letter from recorded samples only', () => {
    const grader = new VenueLatencyGrader('v');
    expect(grader.grade(T0).grade).toBeNull();
    expect(grader.grade(T0).samples).toBe(0);

    feed(grader, 20, 2_000);
    const measured = grader.grade(at(100));
    expect(measured.samples).toBe(20);
    expect(measured.p95Ms).toBe(2_000);
    expect(measured.grade).toBe('D');
    expect(measured.grade).not.toBe('A');
  });

  it('distinguishes ungraded from a measured F — the two need opposite responses', () => {
    const never = new VenueLatencyGrader('never-called');
    const awful = new VenueLatencyGrader('measured-and-awful');
    feed(awful, 20, 30_000);

    const ungraded = never.grade(T0);
    const failing = awful.grade(at(100));

    // The whole point of this row. If both were 'F' an operator could not tell
    // "this venue times out" (a venue fault) from "nothing ever called this
    // venue" (unwired plumbing on our side).
    expect(ungraded.grade).toBeNull();
    expect(failing.grade).toBe('F');
    expect(ungraded.grade).not.toBe(failing.grade);
    expect(isGraded(ungraded)).toBe(false);
    expect(isGraded(failing)).toBe(true);
  });

  it('names the measurement, so a consumer cannot read round-trip as stream lag', () => {
    const grader = new VenueLatencyGrader('v');
    expect(grader.grade(T0).measurement).toBe('rest-round-trip');
    feed(grader, 5, 10);
    // Stated on the ungraded grade too — which measurement is missing is itself
    // information, and it does not change once observations arrive.
    expect(grader.grade(at(50)).measurement).toBe('rest-round-trip');
  });

  it('grades a slow venue worse than a fast one on identical sample counts', () => {
    const fast = new VenueLatencyGrader('fast');
    const slow = new VenueLatencyGrader('slow');
    feed(fast, 20, 40);
    feed(slow, 20, 2_000);

    const fastGrade = fast.grade(at(100));
    const slowGrade = slow.grade(at(100));

    expect(fastGrade.grade).toBe('A');
    expect(slowGrade.grade).toBe('D');
    expect(slowGrade.p95Ms).toBeGreaterThan(fastGrade.p95Ms!);
    // Ordered on the scale, not merely different.
    expect(['A', 'B', 'C', 'D', 'F'].indexOf(slowGrade.grade!)).toBeGreaterThan(['A', 'B', 'C', 'D', 'F'].indexOf(fastGrade.grade!));
  });

  it('grades a fast, clean venue A', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 40);
    const grade = grader.grade(at(100));
    expect(grade.grade).toBe('A');
    expect(grade.p50Ms).toBe(40);
    expect(grade.p95Ms).toBe(40);
    expect(grade.provisional).toBe(false);
    expect(grade.reasons).toEqual([]);
  });

  it('grades on the p95 TAIL, not the mean — the tail is what an order experiences', () => {
    const grader = new VenueLatencyGrader('v');
    // 90 fast reads and 10 four-second ones. Mean ≈ 418ms (a C); p95 is 4000ms.
    feed(grader, 90, 20, 'ok', 0);
    feed(grader, 10, 4_000, 'ok', 90);

    const grade = grader.grade(at(200));
    expect(grade.p50Ms).toBe(20);
    expect(grade.p95Ms).toBe(4_000);
    expect(grade.grade).toBe('F');
    expect(grade.reasons.join(' ')).toContain('p95 round-trip 4000ms');
  });

  it('takes the WORSE of the signals — a venue is as good as its weakest', () => {
    const grader = new VenueLatencyGrader('v');
    // Fast (A on latency) and refusing a fifth of everything (D on rejects).
    feed(grader, 80, 30, 'ok', 0);
    feed(grader, 20, 30, 'reject', 80);

    const grade = grader.grade(at(200));
    expect(grade.rejectRateBps).toBe(2_000);
    expect(grade.grade).toBe('D');
    expect(grade.reasons.join(' ')).toContain('reject rate 20.00%');
  });

  it('grades a venue that answers fast and never succeeds F', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 5, 'error');
    const grade = grader.grade(at(100));
    expect(grade.p95Ms).toBeNull();
    expect(grade.grade).toBe('F');
    expect(grade.reasons.join(' ')).toContain('no successful observation');
  });

  it('grades a venue that has gone quiet F, however fast it used to be', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 10);
    // Well inside the 60s window, well past the 5s staleness ceiling.
    const grade = grader.grade(at(30_000));
    expect(grade.staleMs).toBe(29_981);
    expect(grade.grade).toBe('F');
    expect(grade.reasons.join(' ')).toContain('ceiling 5000ms');
  });

  it('marks a grade built on too few samples provisional', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 2, 10);
    const grade = grader.grade(at(50));
    expect(grade.samples).toBe(2);
    expect(grade.provisional).toBe(true);
  });

  it('evicts by age, so a venue cannot coast on a grade earned an hour ago', () => {
    const grader = new VenueLatencyGrader('v', { maxAgeMs: 1_000 });
    feed(grader, 20, 10, 'ok', 0);
    expect(grader.grade(at(500)).samples).toBe(20);
    expect(grader.grade(at(5_000)).samples).toBe(0);
  });

  it('a stale observation does not count as current — and does not keep its old grade', () => {
    const grader = new VenueLatencyGrader('v', { maxAgeMs: 1_000 });
    feed(grader, 20, 10, 'ok', 0);

    // Inside the window: a genuine A, earned on 20 fast reads.
    expect(grader.grade(at(500)).grade).toBe('A');

    // Once those same observations age out, the A does not persist. A grade
    // computed from a measurement taken an hour ago is a claim about the past
    // presented as the present.
    const after = grader.grade(at(5_000));
    expect(after.grade).toBeNull();
    expect(after.grade).not.toBe('A');
    expect(isGraded(after)).toBe(false);
    expect(after.samples).toBe(0);
    // And it is excluded rather than trusted, so ageing out is safe.
    expect(healthFromGrade(after, at(5_000)).healthy).toBe(false);
  });

  it('an observation inside the window but past the staleness ceiling is F, not ungraded', () => {
    // The two absences are different: evidence that has aged OUT of the window
    // leaves nothing to grade (ungraded); evidence still IN the window whose
    // newest member is old is a measured venue that has gone quiet (F).
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 10);
    const grade = grader.grade(at(30_000));
    expect(grade.grade).toBe('F');
    expect(isGraded(grade)).toBe(true);
    expect(grade.samples).toBe(20);
  });

  it('evicts by count, so a busy venue does not grow without limit', () => {
    const grader = new VenueLatencyGrader('v', { maxSamples: 10 });
    feed(grader, 50, 10);
    expect(grader.grade(at(100)).samples).toBe(10);
  });

  it('times a call and records the outcome, including a throw', async () => {
    const grader = new VenueLatencyGrader('v');
    let clockValue = T0.getTime();
    const clock = () => clockValue;

    await grader.time(async () => {
      clockValue += 25;
      return 'ok';
    }, clock);
    expect(grader.grade(new Date(clockValue)).p95Ms).toBe(25);

    await expect(
      grader.time(async () => {
        clockValue += 900;
        throw new Error('venue said no');
      }, clock),
    ).rejects.toThrow('venue said no');

    const grade = grader.grade(new Date(clockValue));
    expect(grade.samples).toBe(2);
    expect(grade.errorRateBps).toBe(5_000);
  });
});

describe('routingWeightFromGrade — D26-P1-X2 score feed', () => {
  it('an unscored adapter gets ZERO routing weight — not a default, not a low score', () => {
    const grade = new VenueLatencyGrader('never-called').grade(T0);

    expect(isGraded(grade)).toBe(false);
    expect(grade.grade).toBeNull();
    // The public door. If this ever returns non-zero for null, an execution
    // consumer can treat "unmeasured" as eligible and D-S-18 is broken.
    expect(routingWeightFromGrade(grade)).toBe(0);
    expect(measuredLatencyMs(grade)).toBeNull();
  });

  it('ungraded latency cannot invent routing bps — weight is 0|1 eligibility, never a letter map', () => {
    const ungraded = new VenueLatencyGrader('never-called').grade(T0);
    expect(routingWeightFromGrade(ungraded)).toBe(0);
    expect(measuredLatencyMs(ungraded)).toBeNull();

    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 40);
    const live = grader.grade(at(100));
    const weight = routingWeightFromGrade(live);
    expect(weight).toBe(1);
    // A letter→bps invent would return 5 / 10 / 25 / … here. Eligibility only.
    expect(weight).not.toBe(5);
    expect(weight).not.toBe(live.p95Ms);
  });

  it('a letter with no p95 is still weight zero — missing score is not a number', () => {
    const grader = new VenueLatencyGrader('errors-only');
    feed(grader, 2, 5, 'error');
    const grade = grader.grade(at(50));

    expect(isGraded(grade)).toBe(true);
    expect(grade.p95Ms).toBeNull();
    expect(routingWeightFromGrade(grade)).toBe(0);
    expect(measuredLatencyMs(grade)).toBeNull();
    expect(measuredLatencyMs(grade)).not.toBe(UNMEASURED_LATENCY_MS);
  });

  it('a graded adapter gets positive eligibility weight (letter scaling is §28)', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 40);
    const grade = grader.grade(at(100));

    expect(isGraded(grade)).toBe(true);
    expect(routingWeightFromGrade(grade)).toBe(1);
  });

  it('is reachable through MarketDataAdapter.latencyGrade — the type consumers hold', () => {
    const adapters: MarketDataAdapter[] = [new BinanceSpotMarketData(), new BybitSpotMarketData()];

    for (const adapter of adapters) {
      const grade = adapter.latencyGrade!(T0);
      // Fresh adapters have measured nothing. Weight must be zero through the
      // contract surface, not only when the caller already holds a grader.
      expect(routingWeightFromGrade(grade)).toBe(0);
    }
  });
});

describe('healthFromGrade — the whole wiring into routing', () => {
  it('an F on real evidence marks the venue unhealthy, with the reason attached', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 10_000);
    const health = healthFromGrade(grader.grade(at(100)), at(100));

    expect(health.healthy).toBe(false);
    expect(health.latencyMs).toBe(10_000);
    // The router puts this straight into `RoutePlan.rejected` — excluded AND
    // reported, which is §27's requirement, using machinery that already exists.
    expect(health.reason).toContain('grade F');
  });

  it('a provisional F does NOT exclude a venue — two samples are not evidence', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 2, 10_000);
    expect(healthFromGrade(grader.grade(at(50)), at(50)).healthy).toBe(true);
  });

  it('a provisional F from silence is not routable — staleness needs no sample count', () => {
    const grader = new VenueLatencyGrader('v');
    // Two fast reads are a provisional A if graded now. Silence past the 5s
    // ceiling, still inside the 60s window, is an F with that same p95.
    feed(grader, 2, 10);
    const when = at(30_000);
    const grade = grader.grade(when);

    expect(grade.grade).toBe('F');
    expect(grade.provisional).toBe(true);
    expect(grade.samples).toBe(2);
    expect(grade.p95Ms).toBe(10);
    expect(grade.staleMs).toBe(29_999);

    const health = healthFromGrade(grade, when);
    expect(health.healthy).toBe(false);
    // The measured p95 stays the measurement. It does not keep the venue healthy.
    expect(health.latencyMs).toBe(10);

    const source = {
      id: 'v',
      kind: 'external-cex' as const,
      capabilities: ['quote'] as const,
      health: () => health,
      markets: async () => [],
      quote: async () => null,
      orderBook: async () => ({}) as never,
      submit: async () => ({}) as never,
    };
    expect(isRoutable(source, when)).toBe(false);
  });

  it('an unmeasured venue IS excluded — ungraded is not permission to route', () => {
    const grade = new VenueLatencyGrader('v').grade(T0);
    const health = healthFromGrade(grade, T0);

    // The asymmetry: we do not claim the venue is slow, and we still decline to
    // route to it. D-S-18: "an unscored adapter must not receive routing weight."
    expect(routingWeightFromGrade(grade)).toBe(0);
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('ungraded');
    // And it does not masquerade as a bad measurement either.
    expect(health.reason).not.toContain('grade F');
  });

  it('carries p95 as latencyMs, which is what the router breaks ties on', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 90, 20, 'ok', 0);
    feed(grader, 10, 300, 'ok', 90);
    const health = healthFromGrade(grader.grade(at(200)), at(200));
    // Not 20. At equal price you want the venue whose SLOW requests are least slow.
    expect(health.latencyMs).toBe(300);
  });

  it('feeds the existing router gate: an unhealthy venue is not routable', () => {
    const grader = new VenueLatencyGrader('v');
    feed(grader, 20, 10_000);
    const health = healthFromGrade(grader.grade(at(100)), at(100));

    const source = {
      id: 'v',
      kind: 'external-cex' as const,
      capabilities: ['quote'] as const,
      health: () => health,
      markets: async () => [],
      quote: async () => null,
      orderBook: async () => ({}) as never,
      submit: async () => ({}) as never,
    };

    expect(isRoutable(source, at(100))).toBe(false);
  });
});

describe('planRoute — unscored adapter receives ZERO routed amount (D26-P1-X2)', () => {
  function source(id: string, health: VenueHealth, price: string): LiquiditySource {
    return {
      id,
      kind: 'external-cex',
      capabilities: ['quote'],
      health: () => health,
      markets: async () => [],
      quote: async (req) => ({
        venueId: id,
        symbol: req.symbol,
        side: req.side,
        amount: parseAmount('1'),
        price: parseAmount(price),
        feeBps: 10,
        expiresAt: at(60_000),
      }),
      orderBook: async () => ({}) as never,
      submit: async () => ({}) as never,
    };
  }

  it('does not route to an unscored venue even when its quote is cheaper', async () => {
    // Load-bearing proof: latency only breaks equal-price ties. If weight-zero
    // were treated as healthy (or ignored), a null-grade venue with a better
    // price would WIN the route. That is exactly "routing on null grade".
    const scored = new VenueLatencyGrader('scored');
    feed(scored, 20, 40);
    const unscored = new VenueLatencyGrader('unscored');

    const scoredGrade = scored.grade(at(100));
    const unscoredGrade = unscored.grade(at(100));

    expect(routingWeightFromGrade(unscoredGrade)).toBe(0);
    expect(routingWeightFromGrade(scoredGrade)).toBe(1);

    const scoredHealth = healthFromGrade(scoredGrade, at(100));
    const unscoredHealth = healthFromGrade(unscoredGrade, at(100));

    const plan = await planRoute(
      { symbol: 'BTC/USDT', side: 'buy', amount: parseAmount('1') },
      [
        // Cheaper, but unscored — must not appear in legs.
        source('unscored', unscoredHealth, '29000'),
        source('scored', scoredHealth, '30000'),
      ],
      { now: at(100) },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['scored']);
    expect(plan.legs.reduce((sum, leg) => sum + leg.amount, 0n)).toBe(parseAmount('1'));
    expect(plan.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ venueId: 'unscored', reason: 'unhealthy' })]));
    // Zero routing weight → zero fill. Not a partial, not a tie-break loss.
    expect(plan.legs.find((leg) => leg.venueId === 'unscored')).toBeUndefined();
  });

  it('routes nothing at all when every adapter is unscored', async () => {
    const a = healthFromGrade(new VenueLatencyGrader('a').grade(T0), T0);
    const b = healthFromGrade(new VenueLatencyGrader('b').grade(T0), T0);

    expect(routingWeightFromGrade(new VenueLatencyGrader('a').grade(T0))).toBe(0);

    const plan = await planRoute(
      { symbol: 'BTC/USDT', side: 'buy', amount: parseAmount('1') },
      [source('a', a, '30000'), source('b', b, '29900')],
      { now: T0 },
    );

    expect(plan.legs).toEqual([]);
    expect(plan.routedAmount).toBe(0n);
    expect(plan.unfilledAmount).toBe(parseAmount('1'));
    expect(plan.rejected.every((r) => r.reason === 'unhealthy')).toBe(true);
  });
});

describe('LatencyGradeRegistry', () => {
  it('creates a grader on first use and grades every venue at once', () => {
    const registry = new LatencyGradeRegistry();
    feed(registry.for('a'), 20, 10);
    feed(registry.for('b'), 20, 5_000);

    const grades = registry.gradeAll(at(100));
    expect(grades.map((g) => `${g.venueId}:${g.grade}`).sort()).toEqual(['a:A', 'b:F']);
  });

  it('returns the same grader for a venue rather than resetting its window', () => {
    const registry = new LatencyGradeRegistry();
    feed(registry.for('a'), 5, 10);
    feed(registry.for('a'), 5, 10, 'ok', 5);
    expect(registry.for('a').grade(at(50)).samples).toBe(10);
  });

  it('reports ungraded for a registered venue that has never answered', () => {
    const registry = new LatencyGradeRegistry();
    registry.for('registered-never-called');
    feed(registry.for('busy'), 20, 10);

    const grades = registry.gradeAll(at(100));
    const byId = new Map(grades.map((g) => [g.venueId, g]));

    // Registration is not measurement. A venue appears in the report because we
    // know about it, and it reads `null` until it has actually answered us.
    expect(byId.get('registered-never-called')!.grade).toBeNull();
    expect(byId.get('busy')!.grade).toBe('A');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REACHABILITY
//
// The grade being correct is not the bar. Seven guards in this repo were correct
// in isolation and unreachable in place, each with a comment asserting the
// property the code lacked. These tests hold the adapters through the
// `MarketDataAdapter` INTERFACE — the type every consumer actually has, since
// `createVenueMarketDataAdapter` returns `MarketDataAdapter | null` — and read
// the grade through it. If `latencyGrade` were declared only on the concrete
// classes, none of this would compile.
//
// No live network: fake HTTP transports only. `venue.aggregation` residual (4)
// records that there is no live-network CI, and adding one is a separate call.
// ════════════════════════════════════════════════════════════════════════════

describe('latency grading is reachable through MarketDataAdapter', () => {
  /** A venue that answers one REST call, at a controllable cost in ms. */
  function fakeHttp(body: unknown, costMs: number, clock: { now: number }, status = 200): HttpPort {
    return {
      async get(): Promise<HttpResponse> {
        clock.now += costMs;
        return { status, body, header: () => null };
      },
    };
  }

  const exchangeInfo = { symbols: [] };
  const bybitInfo = { retCode: 0, result: { list: [] } };

  it('exposes the grade on both venues through the interface, not just the class', () => {
    const binance: MarketDataAdapter = new BinanceSpotMarketData();
    const bybit: MarketDataAdapter = new BybitSpotMarketData();

    // Reachable through the contract. This is the assertion that would have
    // caught the guard being exported and consumed by nothing.
    expect(typeof binance.latencyGrade).toBe('function');
    expect(typeof bybit.latencyGrade).toBe('function');
    expect(binance.latencyGrade!().venueId).toBe('binance-spot');
    expect(bybit.latencyGrade!().venueId).toBe('bybit-spot');
  });

  it('reads UNGRADED before the adapter has made a single call', () => {
    const adapters: MarketDataAdapter[] = [new BinanceSpotMarketData(), new BybitSpotMarketData()];

    for (const adapter of adapters) {
      const grade = adapter.latencyGrade!(T0);
      // A freshly constructed adapter has measured nothing. It must not read as
      // an A (a venue we have proven fast) and must not read as an F (a venue we
      // have proven slow). It reads as unmeasured.
      expect(grade.grade).toBeNull();
      expect(grade.samples).toBe(0);
      expect(grade.measurement).toBe('rest-round-trip');
    }
  });

  it('becomes graded once real calls have been observed, on an injected clock', async () => {
    const clock = { now: T0.getTime() };
    const adapter: MarketDataAdapter = new BinanceSpotMarketData({
      http: fakeHttp(exchangeInfo, 40, clock),
      clock: () => clock.now,
      restBase: 'https://rest.test',
    });

    expect(adapter.latencyGrade!(new Date(clock.now)).grade).toBeNull();

    await adapter.markets();

    const grade = adapter.latencyGrade!(new Date(clock.now));
    expect(grade.samples).toBe(1);
    expect(grade.grade).toBe('A');
    expect(grade.p95Ms).toBe(40);
    // One call is not a p95. The letter is offered and labelled, not trusted.
    expect(grade.provisional).toBe(true);
  });

  it('grades the slower of two real adapters worse — the comparison #1148 made possible', async () => {
    const fastClock = { now: T0.getTime() };
    const slowClock = { now: T0.getTime() };

    const fast: MarketDataAdapter = new BinanceSpotMarketData({
      http: fakeHttp(exchangeInfo, 30, fastClock),
      clock: () => fastClock.now,
      restBase: 'https://rest.test',
    });
    const slow: MarketDataAdapter = new BybitSpotMarketData({
      http: fakeHttp(bybitInfo, 2_500, slowClock),
      clock: () => slowClock.now,
      restBase: 'https://rest.test',
    });

    await fast.markets();
    await slow.markets();

    const fastGrade = fast.latencyGrade!(new Date(fastClock.now));
    const slowGrade = slow.latencyGrade!(new Date(slowClock.now));

    expect(fastGrade.grade).toBe('A');
    expect(slowGrade.grade).toBe('D');
    expect(slowGrade.p95Ms!).toBeGreaterThan(fastGrade.p95Ms!);
  });

  it('does not charge a venue for a delay OUR rate limiter imposed', async () => {
    const clock = { now: T0.getTime() };
    // A governor with almost nothing to spend refuses before the request is made
    // (`markets()` costs weight 20).
    const governor = new RateLimitGovernor({ ...BINANCE_SPOT_RATE_LIMIT, capacity: 2 }, clock.now);
    const adapter: MarketDataAdapter = new BinanceSpotMarketData({
      http: fakeHttp(exchangeInfo, 10, clock),
      clock: () => clock.now,
      restBase: 'https://rest.test',
      governor,
    });

    await expect(adapter.markets()).rejects.toThrow(VenueUnavailableError);

    // Still ungraded. Timing our own refusal would make our throttling look like
    // the venue degrading, and the grade would then argue for routing away from
    // a venue that did nothing wrong.
    const grade = adapter.latencyGrade!(new Date(clock.now));
    expect(grade.grade).toBeNull();
    expect(grade.samples).toBe(0);
  });
});

describe('an unmeasured venue cannot win a routing tie-break', () => {
  it('gets zero weight — missing p95 is not a sentinel score that still routes', async () => {
    // Residual this deepen closes: a provisional F with no successful RTT used
    // to stay healthy and carry UNMEASURED_LATENCY_MS into ranking. That is a
    // missing score treated as a number. Score-feed weight is now 0, so the
    // venue is excluded rather than "losing the tie".
    const measured = new VenueLatencyGrader('measured');
    feed(measured, 20, 250);
    const unmeasured = new VenueLatencyGrader('unmeasured');
    feed(unmeasured, 2, 5, 'error');

    const measuredGrade = measured.grade(at(100));
    const unmeasuredGrade = unmeasured.grade(at(100));
    const measuredHealth = healthFromGrade(measuredGrade, at(100));
    const unmeasuredHealth = healthFromGrade(unmeasuredGrade, at(100));

    expect(routingWeightFromGrade(unmeasuredGrade)).toBe(0);
    expect(measuredLatencyMs(unmeasuredGrade)).toBeNull();
    expect(measuredHealth.healthy).toBe(true);
    expect(unmeasuredHealth.healthy).toBe(false);
    expect(unmeasuredHealth.latencyMs).toBe(UNMEASURED_LATENCY_MS);

    const source = (id: string, health: VenueHealth): LiquiditySource => ({
      id,
      kind: 'external-cex',
      capabilities: ['quote'],
      health: () => health,
      markets: async () => [],
      quote: async (req) => ({
        venueId: id,
        symbol: req.symbol,
        side: req.side,
        amount: parseAmount('1'),
        price: parseAmount('30000'),
        feeBps: 10,
        expiresAt: at(60_000),
      }),
      orderBook: async () => ({}) as never,
      submit: async () => ({}) as never,
    });

    const plan = await planRoute(
      { symbol: 'BTC/USDT', side: 'buy', amount: parseAmount('1') },
      [source('unmeasured', unmeasuredHealth), source('measured', measuredHealth)],
      { now: at(100) },
    );

    expect(plan.legs.map((leg) => leg.venueId)).toEqual(['measured']);
    expect(plan.rejected).toEqual(expect.arrayContaining([expect.objectContaining({ venueId: 'unmeasured', reason: 'unhealthy' })]));
  });
});

describe('ws-round-trip — handshake grade, not REST relabelled', () => {
  function openPort(open: StreamPort['open']): StreamPort {
    return { open };
  }

  it('names ws-round-trip on an ungraded WS window — silence is not a letter', () => {
    const ws = new VenueLatencyGrader('v', { measurement: WS_MEASUREMENT });
    const grade = ws.grade(T0);

    expect(ws.measurement).toBe('ws-round-trip');
    expect(grade.measurement).toBe('ws-round-trip');
    expect(grade.grade).toBeNull();
    expect(grade.grade).not.toBe('A');
    expect(grade.grade).not.toBe('F');
    expect(grade.samples).toBe(0);
    expect(routingWeightFromGrade(grade)).toBe(0);
    expect(measuredLatencyMs(grade)).toBeNull();
  });

  it('does not mix REST samples into a WS grade, or the reverse', () => {
    const rest = new VenueLatencyGrader('v');
    const ws = new VenueLatencyGrader('v', { measurement: WS_MEASUREMENT });
    feed(rest, 20, 40);

    expect(rest.grade(at(100)).measurement).toBe(REST_MEASUREMENT);
    expect(rest.grade(at(100)).samples).toBe(20);
    expect(ws.grade(at(100)).measurement).toBe(WS_MEASUREMENT);
    expect(ws.grade(at(100)).samples).toBe(0);
    expect(ws.grade(at(100)).grade).toBeNull();
    expect(routingWeightFromGrade(ws.grade(at(100)))).toBe(0);

    feed(ws, 20, 80);
    expect(ws.grade(at(100)).measurement).toBe('ws-round-trip');
    expect(ws.grade(at(100)).p95Ms).toBe(80);
    expect(rest.grade(at(100)).p95Ms).toBe(40);
    expect(rest.grade(at(100)).measurement).toBe('rest-round-trip');
  });

  it('records StreamPort.open onto the WS grader — deleting observe fails this', async () => {
    const clock = { now: T0.getTime() };
    const ws = new VenueLatencyGrader('v', { measurement: WS_MEASUREMENT });
    const inner = openPort(async () => {
      clock.now += 35;
      return {
        messages: (async function* () {})(),
        close: async () => undefined,
      } satisfies StreamHandle;
    });

    const timed = observeStreamRoundTrip(inner, ws, () => clock.now);
    await timed.open('wss://ws.test/stream');

    const grade = ws.grade(new Date(clock.now));
    expect(grade.measurement).toBe('ws-round-trip');
    expect(grade.samples).toBe(1);
    expect(grade.p95Ms).toBe(35);
    expect(grade.grade).not.toBeNull();
    expect(routingWeightFromGrade(grade)).toBe(1);
  });

  it('records a failed handshake as error, still ws-round-trip, weight 0 without p95', async () => {
    const clock = { now: T0.getTime() };
    const ws = new VenueLatencyGrader('v', { measurement: WS_MEASUREMENT });
    const inner = openPort(async () => {
      clock.now += 12;
      throw new Error('websocket closed before it opened');
    });

    await expect(observeStreamRoundTrip(inner, ws, () => clock.now).open('wss://ws.test')).rejects.toThrow(/closed before it opened/);

    const grade = ws.grade(new Date(clock.now));
    expect(grade.measurement).toBe('ws-round-trip');
    expect(grade.samples).toBe(1);
    expect(grade.p95Ms).toBeNull();
    expect(grade.errorRateBps).toBe(10_000);
    expect(routingWeightFromGrade(grade)).toBe(0);
  });

  it('REFUSES to hang WS observations on a REST grader', () => {
    const rest = new VenueLatencyGrader('v');
    expect(() =>
      observeStreamRoundTrip(
        openPort(async () => ({ messages: (async function* () {})(), close: async () => undefined })),
        rest,
      ),
    ).toThrow(/ws-round-trip/);
  });

  it('holds REST and WS separately in the registry', () => {
    const registry = new LatencyGradeRegistry();
    feed(registry.for('v'), 20, 40);
    feed(registry.for('v', WS_MEASUREMENT), 20, 2_000);

    const grades = registry.gradeAll(at(100));
    const rest = grades.find((g) => g.measurement === 'rest-round-trip');
    const ws = grades.find((g) => g.measurement === 'ws-round-trip');

    expect(rest?.p95Ms).toBe(40);
    expect(ws?.p95Ms).toBe(2_000);
    expect(rest?.venueId).toBe('v');
    expect(ws?.venueId).toBe('v');
    expect(registry.for('v').grade(at(100)).measurement).toBe('rest-round-trip');
  });

  it('times the real StreamPort handshake — not a REST sample relabelled', async () => {
    class FakeSocket {
      static last: FakeSocket | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        setTimeout(() => this.onopen?.(), 0);
      }
      send(): void {}
      close(): void {
        this.onclose?.();
      }
    }

    const slot = globalThis as { WebSocket?: unknown };
    const original = slot.WebSocket;
    slot.WebSocket = FakeSocket;
    try {
      const ws = new VenueLatencyGrader('v', { measurement: WS_MEASUREMENT });
      const rest = new VenueLatencyGrader('v');
      const port = observeStreamRoundTrip(webSocketStreamPort(), ws);
      const handle = await port.open('wss://ws.test/stream');
      expect(FakeSocket.last?.url).toBe('wss://ws.test/stream');

      const grade = ws.grade(new Date());
      expect(grade.measurement).toBe('ws-round-trip');
      expect(grade.samples).toBe(1);
      expect(grade.grade).not.toBeNull();
      expect(rest.grade(new Date()).samples).toBe(0);
      expect(routingWeightFromGrade(rest.grade(new Date()))).toBe(0);
      await handle.close();
    } finally {
      if (original === undefined) delete slot.WebSocket;
      else slot.WebSocket = original;
    }
  });

  it('is reachable through MarketDataAdapter.streamLatencyGrade after a real stream open', async () => {
    const stream: StreamPort = {
      async open() {
        return { messages: (async function* () {})(), close: async () => undefined };
      },
    };
    const adapter: MarketDataAdapter = new BinanceSpotMarketData({
      stream,
      restBase: 'https://rest.test',
      clock: () => T0.getTime(),
    });

    expect(typeof adapter.streamLatencyGrade).toBe('function');
    const before = adapter.streamLatencyGrade!(T0);
    expect(before.measurement).toBe('ws-round-trip');
    expect(before.grade).toBeNull();
    expect(routingWeightFromGrade(before)).toBe(0);
    expect(adapter.latencyGrade!(T0).measurement).toBe('rest-round-trip');

    await adapter.streamBook('BTC/USDT');

    const after = adapter.streamLatencyGrade!(T0);
    expect(after.measurement).toBe('ws-round-trip');
    expect(after.samples).toBe(1);
    expect(after.grade).not.toBeNull();
    expect(adapter.latencyGrade!(T0).samples).toBe(0);
  });
});
