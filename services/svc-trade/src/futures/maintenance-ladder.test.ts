import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatAmount, mul, mulBps, parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import {
  DEPTH_UNKNOWN,
  FuturesLadderError,
  LADDER_POLICY_INCOHERENT,
  assertLadderPolicyCoherent,
  depthRatioBps,
  healthRatioBps,
  maintenanceBpsFor,
  mayLiquidateFromExpiredMarginCallGrace,
  mayStartMarginCallGrace,
  planLadderLiquidation,
  planLadderRung,
  summarizeLadder,
  type FuturesLadderPolicy,
  type LadderRung,
} from './maintenance-ladder.js';
import { DEFAULT_FUTURES_LADDER_POLICY } from './ladder-policy.test-harness.js';
import type { LiquidationPosition } from './liquidation-planner.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SCALE = 10n ** 18n;

function position(over: Partial<LiquidationPosition> = {}): LiquidationPosition {
  return {
    positionId: 'pos-1',
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'), // 10× on a notional of 1 000
    marginAsset: 'USDT',
    ...over,
  };
}

/** A deep book: the default table's first tier requires notional ≤ 5% of it. */
const DEEP = amt('1000000');

/**
 * A POLICY THAT PRODUCES UNCAPPED PARTIAL RUNGS, AND WHY ONE IS NEEDED.
 *
 * Under `DEFAULT_FUTURES_LADDER_POLICY` a 10× position in a deep book has an
 * initial margin of 1 000 bps of notional and a maintenance requirement of 50.
 * The whole solvent-but-liquidatable band is therefore the sliver of price where
 * equity sits between 0 and 60 bps of notional — and restoring 1.5× the
 * requirement from inside it always asks for more than `maxTrancheBps`, so every
 * rung there is tranche-capped.
 *
 * That is a true and intended property of a 20:1 gap between initial and
 * maintenance margin, not a defect, and the capped case is covered on its own
 * below. But a test that only ever sees capped rungs never exercises the closed
 * form. This policy widens the maintenance band and lifts the ceiling so the
 * SIZING is what is under test rather than the cap.
 */
const WIDE_POLICY: FuturesLadderPolicy = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 500 },
    { uptoDepthBps: 5_000, maintenanceBps: 800 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 1_500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Policy coherence
// ─────────────────────────────────────────────────────────────────────────────

describe('assertLadderPolicyCoherent', () => {
  it('accepts the shipped default', () => {
    expect(() => assertLadderPolicyCoherent(DEFAULT_FUTURES_LADDER_POLICY)).not.toThrow();
  });

  it('refuses a table with no catch-all tier — the largest positions would never liquidate', () => {
    const policy: FuturesLadderPolicy = {
      ...DEFAULT_FUTURES_LADDER_POLICY,
      tiers: [
        { uptoDepthBps: 500, maintenanceBps: 50 },
        { uptoDepthBps: 5_000, maintenanceBps: 250 },
      ],
    };
    expect(() => assertLadderPolicyCoherent(policy)).toThrowError(expect.objectContaining({ code: LADDER_POLICY_INCOHERENT }) as never);
  });

  it('refuses maintenance that FALLS as a position grows relative to depth', () => {
    const policy: FuturesLadderPolicy = {
      ...DEFAULT_FUTURES_LADDER_POLICY,
      tiers: [
        { uptoDepthBps: 500, maintenanceBps: 250 },
        { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 50 },
      ],
    };
    expect(() => assertLadderPolicyCoherent(policy)).toThrowError(/must not fall/);
  });

  it('refuses a margin call AT the liquidation threshold — that is a receipt, not a warning', () => {
    expect(() => assertLadderPolicyCoherent({ ...DEFAULT_FUTURES_LADDER_POLICY, marginCallBps: 10_000 })).toThrowError(
      /a warning at the liquidation threshold is a receipt/,
    );
  });

  it('refuses a target at or below the margin call — the rung would fire again on the next mark', () => {
    expect(() => assertLadderPolicyCoherent({ ...DEFAULT_FUTURES_LADDER_POLICY, targetBps: 12_000 })).toThrowError(/still in margin call/);
  });

  it('refuses a tranche cap outside (0, 10 000]', () => {
    expect(() => assertLadderPolicyCoherent({ ...DEFAULT_FUTURES_LADDER_POLICY, maxTrancheBps: 0 })).toThrow();
    expect(() => assertLadderPolicyCoherent({ ...DEFAULT_FUTURES_LADDER_POLICY, maxTrancheBps: 10_001 })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Depth — the thing DIRECTION §1 says the ladder must reference
// ─────────────────────────────────────────────────────────────────────────────

describe('depthRatioBps', () => {
  it('refuses a non-positive depth rather than treating an unreadable book as a deep one', () => {
    expect(() => depthRatioBps(amt('1000'), 0n)).toThrowError(expect.objectContaining({ code: DEPTH_UNKNOWN }) as never);
    expect(() => depthRatioBps(amt('1000'), -1n)).toThrowError(FuturesLadderError);
  });

  it('rounds UP, so a position exactly on a boundary is rated into the higher tier', () => {
    // 500 of a 10 000 book is exactly 500 bps.
    expect(depthRatioBps(amt('500'), amt('10000'))).toBe(500);
    // One attounit more must not still read as 500.
    expect(depthRatioBps(amt('500') + 1n, amt('10000'))).toBe(501);
  });

  it('saturates rather than overflowing on an unbounded ratio', () => {
    expect(depthRatioBps(amt('1000000000000'), 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('maintenanceBpsFor', () => {
  it('picks the tier at the exact boundary, and the next tier one attounit past it', () => {
    // Depth 10 000 → the 500 bps bound is a notional of exactly 500.
    expect(maintenanceBpsFor(amt('500'), amt('10000'), DEFAULT_FUTURES_LADDER_POLICY)).toBe(50);
    expect(maintenanceBpsFor(amt('500') + 1n, amt('10000'), DEFAULT_FUTURES_LADDER_POLICY)).toBe(100);
  });

  it('reaches the catch-all tier for a position larger than the book it must be sold into', () => {
    expect(maintenanceBpsFor(amt('50000'), amt('10000'), DEFAULT_FUTURES_LADDER_POLICY)).toBe(500);
  });

  /**
   * THE PROPERTY THE ROW IS ABOUT. If someone re-flattened the ladder to a
   * constant — which is exactly what `liquidation-planner.ts` still does — this
   * is the assertion that catches it.
   */
  it('never requires LESS margin from a thinner book (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        (notional, d1, d2) => {
          const thin = d1 < d2 ? d1 : d2;
          const deep = d1 < d2 ? d2 : d1;
          const mmThin = maintenanceBpsFor(notional, thin, DEFAULT_FUTURES_LADDER_POLICY);
          const mmDeep = maintenanceBpsFor(notional, deep, DEFAULT_FUTURES_LADDER_POLICY);
          expect(mmThin).toBeGreaterThanOrEqual(mmDeep);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('healthRatioBps', () => {
  it('reports no equity as 0, not as a negative ratio', () => {
    expect(healthRatioBps(0n, amt('5'))).toBe(0);
    expect(healthRatioBps(amt('-5'), amt('5'))).toBe(0);
  });

  it('reports a zero requirement with positive equity as saturated, mirroring ltvBps', () => {
    expect(healthRatioBps(amt('1'), 0n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('floors — equity one attounit short of 2× the requirement is not 20 000 bps', () => {
    expect(healthRatioBps(amt('10'), amt('5'))).toBe(20_000);
    expect(healthRatioBps(amt('10') - 1n, amt('5'))).toBe(19_999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rung
// ─────────────────────────────────────────────────────────────────────────────

describe('planLadderRung', () => {
  it('refuses rather than valuing when the mark is not a price', () => {
    expect(
      planLadderRung({ position: position(), markPrice: 0n, depthNotional: DEEP, policy: DEFAULT_FUTURES_LADDER_POLICY }),
    ).toMatchObject({
      action: 'refuse',
      reason: 'invalid_mark',
    });
  });

  it('refuses an empty position', () => {
    expect(
      planLadderRung({
        position: position({ size: 0n }),
        markPrice: amt('100'),
        depthNotional: DEEP,
        policy: DEFAULT_FUTURES_LADDER_POLICY,
      }),
    ).toMatchObject({ action: 'refuse', reason: 'empty_position' });
  });

  it('propagates the depth refusal rather than rating against a book it could not read', () => {
    expect(() =>
      planLadderRung({ position: position(), markPrice: amt('100'), depthNotional: 0n, policy: DEFAULT_FUTURES_LADDER_POLICY }),
    ).toThrowError(expect.objectContaining({ code: DEPTH_UNKNOWN }) as never);
  });

  it('leaves a healthy position alone', () => {
    const rung = planLadderRung({
      position: position(),
      markPrice: amt('100'),
      depthNotional: DEEP,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    expect(rung.action).toBe('none');
  });

  /**
   * BOUNDARY: health exactly at each threshold. Built by choosing the margin that
   * makes equity land on the figure, so the comparison is tested at the tick
   * where it flips rather than somewhere in the middle of a band.
   */
  it('treats health exactly at the margin-call threshold as healthy, and one bp below as a call', () => {
    // notional 1 000 at mark 100 on size 10; deep book → mm 50 bps → required 5.
    const required = mulBps(amt('1000'), 50, 'ceil');
    const atCall = (required * BigInt(DEFAULT_FUTURES_LADDER_POLICY.marginCallBps)) / 10_000n;

    const flat = { markPrice: amt('100'), depthNotional: DEEP, policy: DEFAULT_FUTURES_LADDER_POLICY };
    // entry == mark → riskPnl 0 → equity == margin.
    expect(planLadderRung({ position: position({ margin: atCall }), ...flat }).action).toBe('none');
    expect(planLadderRung({ position: position({ margin: atCall - 1n }), ...flat }).action).toBe('margin-call');
  });

  it('treats health exactly at 10 000 bps as a margin call, not a liquidation', () => {
    const required = mulBps(amt('1000'), 50, 'ceil');
    const flat = { markPrice: amt('100'), depthNotional: DEEP, policy: DEFAULT_FUTURES_LADDER_POLICY };
    expect(planLadderRung({ position: position({ margin: required }), ...flat }).action).toBe('margin-call');
    expect(planLadderRung({ position: position({ margin: required - 1n }), ...flat }).action).toBe('liquidate');
  });

  it('closes PART of the position, not all of it, when the position is still solvent', () => {
    // Long 10 @ 100, margin 100. Mark 93 → riskPnl −70 → equity 30, requirement
    // 46.5 (500 bps of a 930 notional) → health 6 451 bps.
    const rung = planLadderRung({ position: position(), markPrice: amt('93'), depthNotional: DEEP, policy: WIDE_POLICY });
    expect(rung.action).toBe('liquidate');
    const liq = rung as Extract<LadderRung, { action: 'liquidate' }>;
    expect(liq.bankrupt).toBe(false);
    expect(liq.trancheCapped).toBe(false);
    expect(liq.closesPosition).toBe(false);
    expect(liq.sizeToClose).toBeGreaterThan(0n);
    expect(liq.sizeToClose).toBeLessThan(position().size);
  });

  it('closes in FULL, uncapped, once equity is gone — a tranche ceiling on a bankrupt position is a bet', () => {
    // Mark 89 → riskPnl −110 → equity −10.
    const rung = planLadderRung({
      position: position(),
      markPrice: amt('89'),
      depthNotional: DEEP,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    }) as Extract<LadderRung, { action: 'liquidate' }>;
    expect(rung.action).toBe('liquidate');
    expect(rung.bankrupt).toBe(true);
    expect(rung.trancheCapped).toBe(false);
    expect(rung.sizeToClose).toBe(position().size);
    expect(rung.closesPosition).toBe(true);
  });

  it('treats equity of exactly zero as bankrupt — no fraction of the position meets a positive requirement', () => {
    // Long 10 @ 100 margin 100: mark 90 → riskPnl −100 → equity exactly 0.
    const rung = planLadderRung({
      position: position(),
      markPrice: amt('90'),
      depthNotional: DEEP,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    }) as Extract<LadderRung, { action: 'liquidate' }>;
    expect(rung.equity).toBe(0n);
    expect(rung.bankrupt).toBe(true);
    expect(rung.closesPosition).toBe(true);
  });

  it('caps a rung at maxTrancheBps and says so', () => {
    // A thin book pushes the position into the catch-all tier (mm 500 bps), which
    // asks for far more than 25% of the size in one go.
    const rung = planLadderRung({
      position: position(),
      markPrice: amt('93'),
      depthNotional: amt('100'),
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    }) as Extract<LadderRung, { action: 'liquidate' }>;
    expect(rung.action).toBe('liquidate');
    expect(rung.trancheCapped).toBe(true);
    expect(rung.sizeToClose).toBe(mulBps(position().size, DEFAULT_FUTURES_LADDER_POLICY.maxTrancheBps, 'floor'));
  });

  it('refuses to liquidate a position that is in PROFIT, however the trigger arose', () => {
    // A maintenance requirement above the position's own initial margin fraction
    // is a policy incoherence, not a market event — and everything downstream
    // realises losses only.
    const policy: FuturesLadderPolicy = {
      ...DEFAULT_FUTURES_LADDER_POLICY,
      tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 9_000 }],
    };
    const rung = planLadderRung({ position: position(), markPrice: amt('101'), depthNotional: DEEP, policy });
    expect(rung).toMatchObject({ action: 'refuse', reason: 'refused_profitable_liquidation' });
  });

  it('rates a SHORT with the sign reversed — the same move that saves a long sinks it', () => {
    const short = position({ side: 'short' });
    expect(planLadderRung({ position: short, markPrice: amt('93'), depthNotional: DEEP, policy: WIDE_POLICY }).action).toBe('none');
    expect(planLadderRung({ position: short, markPrice: amt('107'), depthNotional: DEEP, policy: WIDE_POLICY }).action).toBe('liquidate');
  });

  it('handles the largest representable size without overflowing or throwing', () => {
    // trade.positions is numeric(38, 18) — 10^20 whole units itself does not fit (#4425 made parseAmount refuse it),
    // so the largest representable size is 10^20 - 1 whole units.
    const huge = amt('99999999999999999999');
    const rung = planLadderRung({
      position: position({ size: huge, entryPrice: amt('100'), margin: mul(huge, amt('10'), 'floor') }),
      markPrice: amt('93'),
      depthNotional: mul(huge, amt('10000'), 'floor'),
      policy: WIDE_POLICY,
    });
    expect(rung.action).toBe('liquidate');
    const liq = rung as Extract<LadderRung, { action: 'liquidate' }>;
    expect(liq.sizeToClose).toBeGreaterThan(0n);
    expect(liq.sizeToClose).toBeLessThanOrEqual(huge);
    expect(liq.closesPosition).toBe(false);
  });

  it('reports a rung that would close nothing as a margin call rather than looping on it', () => {
    // One attounit of size: every tranche figure floors to zero.
    const dust = position({ size: 1n, entryPrice: amt('100'), margin: 1n });
    const rung = planLadderRung({ position: dust, markPrice: amt('99'), depthNotional: DEEP, policy: DEFAULT_FUTURES_LADDER_POLICY });
    expect(['margin-call', 'liquidate']).toContain(rung.action);
    if (rung.action === 'liquidate') expect(rung.sizeToClose).toBeGreaterThan(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Recipes
// ─────────────────────────────────────────────────────────────────────────────

describe('planLadderLiquidation', () => {
  it('posts a realised loss and NO margin release on a partial rung', () => {
    const decision = planLadderLiquidation({
      liquidationId: 'liq-1',
      position: position(),
      markPrice: amt('93'),
      depthNotional: DEEP,
      policy: WIDE_POLICY,
    });
    expect(decision.liquidate).toBe(true);
    if (!decision.liquidate) return;
    expect(decision.reason).toBe('ladder_partial');
    expect(decision.residualRelease).toBe(0n);
    expect(decision.marginRemaining).toBe(position().margin - decision.fromMargin);
    expect(decision.recipes.map((r) => r.reason)).toEqual(['futures.loss.realized']);
  });

  it('releases residual margin only on a rung that closes the position', () => {
    // Small loss, forced full close by a policy whose tranche cap is the whole size.
    const policy: FuturesLadderPolicy = { ...DEFAULT_FUTURES_LADDER_POLICY, maxTrancheBps: 10_000 };
    const decision = planLadderLiquidation({
      liquidationId: 'liq-2',
      position: position(),
      markPrice: amt('89'), // bankrupt → full close
      depthNotional: DEEP,
      policy,
    });
    if (!decision.liquidate) throw new Error('expected a rung');
    expect(decision.closesPosition).toBe(true);
    expect(decision.marginRemaining).toBe(0n);
    // Loss 110 > margin 100 → margin fully consumed, nothing to release, 10 from insurance.
    expect(decision.fromMargin).toBe(amt('100'));
    expect(decision.fromInsurance).toBe(amt('10'));
    expect(decision.residualRelease).toBe(0n);
  });

  it('draws the shortfall from insurance and NEVER more than the margin from margin', () => {
    const decision = planLadderLiquidation({
      liquidationId: 'liq-3',
      position: position({ margin: amt('5') }),
      markPrice: amt('50'),
      depthNotional: DEEP,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    if (!decision.liquidate) throw new Error('expected a rung');
    expect(decision.fromMargin).toBe(amt('5'));
    expect(decision.fromMargin + decision.fromInsurance).toBe(decision.loss);
    expect(decision.fromInsurance).toBe(decision.loss - amt('5'));
  });

  it('keys the loss off the attempt id so a replayed rung dedupes in the ledger', () => {
    const decision = planLadderLiquidation({
      liquidationId: 'liq:pos-1:2026-08-08T00:00',
      position: position(),
      markPrice: amt('93'),
      depthNotional: DEEP,
      policy: WIDE_POLICY,
    });
    if (!decision.liquidate) throw new Error('expected a rung');
    // Partial rungs must include closed size in the loss id — same lifecycle
    // liquidationId re-used across rungs would otherwise ledger-dedupe and
    // leave margin stranded while size shrinks. Full close keeps `:loss` alone.
    if (decision.closesPosition) {
      expect(decision.recipes[0]!.idempotencyKey).toBe('futures.loss:liq:pos-1:2026-08-08T00:00:loss');
    } else {
      expect(decision.recipes[0]!.idempotencyKey).toBe(
        `futures.loss:liq:pos-1:2026-08-08T00:00:loss:partial:${formatAmount(decision.sizeClosed)}:${formatAmount(position().size)}`,
      );
    }
    const replay = planLadderLiquidation({
      liquidationId: 'liq:pos-1:2026-08-08T00:00',
      position: position(),
      markPrice: amt('93'),
      depthNotional: DEEP,
      policy: WIDE_POLICY,
    });
    if (!replay.liquidate) throw new Error('expected replay rung');
    expect(replay.recipes[0]!.idempotencyKey).toBe(decision.recipes[0]!.idempotencyKey);
  });

  it('summarises a skip and a rung distinguishably', () => {
    const healthy = planLadderLiquidation({
      liquidationId: 'liq-4',
      position: position(),
      markPrice: amt('100'),
      depthNotional: DEEP,
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    expect(summarizeLadder(healthy)).toContain('skip');
    const rung = planLadderLiquidation({
      liquidationId: 'liq-5',
      position: position(),
      markPrice: amt('93'),
      depthNotional: DEEP,
      policy: WIDE_POLICY,
    });
    expect(summarizeLadder(rung)).toContain('ladder_partial');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Properties — these are the tests that fail if the maths breaks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Positions in ranges a real market produces. Deliberately NOT attounit dust:
 * the flooring in a closed-form tranche is exact to within a couple of attounits,
 * and a generator that spends its budget on 1-wei positions proves that rounding
 * exists rather than that the algebra holds. Dust is covered by the explicit
 * boundary cases above.
 */
const positionArb = fc.record({
  side: fc.constantFrom<'long' | 'short'>('long', 'short'),
  sizeUnits: fc.integer({ min: 1, max: 10_000 }),
  entryUnits: fc.integer({ min: 10, max: 100_000 }),
  leverage: fc.integer({ min: 2, max: 10 }),
  markPermille: fc.integer({ min: 500, max: 1_500 }),
  depthMultiple: fc.integer({ min: 1, max: 5_000 }),
});

type PositionCase = { position: LiquidationPosition; markPrice: Amount; depthNotional: Amount };

function buildCase(raw: {
  side: 'long' | 'short';
  sizeUnits: number;
  entryUnits: number;
  leverage: number;
  markPermille: number;
  depthMultiple: number;
}): PositionCase {
  const size = amt(String(raw.sizeUnits));
  const entryPrice = amt(String(raw.entryUnits));
  const notional = mul(size, entryPrice, 'ceil');
  const margin = notional / BigInt(raw.leverage);
  const markPrice = (entryPrice * BigInt(raw.markPermille)) / 1_000n;
  return {
    position: position({ side: raw.side, size, entryPrice, margin }),
    markPrice: markPrice > 0n ? markPrice : 1n,
    depthNotional: notional * BigInt(raw.depthMultiple),
  };
}

/**
 * `WIDE_POLICY` here for the reason given where it is defined: under the shipped
 * default almost every liquidatable case is either tranche-capped or already
 * bankrupt, and the properties below are about the closed form. The conservation
 * property runs against BOTH tables, because that one must hold whatever the
 * numbers are.
 */
const liquidatableCases = positionArb.map(buildCase).filter((c) => {
  const rung = planLadderRung({ ...c, policy: WIDE_POLICY });
  return rung.action === 'liquidate';
});

describe('ladder properties', () => {
  /**
   * EQUITY IS INVARIANT UNDER A CLOSE AT THE MARK.
   *
   * The central claim of the file header, asserted rather than assumed. If a rung
   * ever moved equity, a liquidation would be transferring value between the
   * trader and the platform at a price nobody quoted.
   *
   * The bound is two attounits, not zero, and the reason is stated in the header:
   * the tranche's loss is CHARGED with rounding toward zero while the remainder's
   * PnL is MEASURED with rounding away from it, so the two figures can each be
   * off by one unit. A bound of zero here would be a test asserting that a deliberate
   * asymmetry does not exist.
   */
  it('never moves equity (bound: 2 attounits, and the direction favours the trader)', () => {
    fc.assert(
      fc.property(liquidatableCases, (c) => {
        const decision = planLadderLiquidation({ ...c, liquidationId: 'p', policy: WIDE_POLICY });
        if (!decision.liquidate) return;
        if (decision.closesPosition) return; // nothing remains to have an equity

        const remaining: LiquidationPosition = {
          ...c.position,
          size: c.position.size - decision.sizeClosed,
          margin: decision.marginRemaining,
        };
        const after = planLadderRung({ ...c, position: remaining, policy: WIDE_POLICY });
        const drift = after.equity - decision.rung.equity;
        expect(drift <= 2n && drift >= -2n).toBe(true);
      }),
      { numRuns: 1_500 },
    );
  });

  /**
   * A RUNG THAT WAS NOT CAPPED RESTORES THE POSITION.
   *
   * This is `DIRECTION` §1's "close the minimum that restores maintenance margin"
   * as an executable claim. A capped rung is explicitly allowed not to restore —
   * that is what the cap is for, and the next tick takes another rung.
   */
  it('restores a position above the liquidation threshold whenever the rung was not tranche-capped', () => {
    fc.assert(
      fc.property(liquidatableCases, (c) => {
        const decision = planLadderLiquidation({ ...c, liquidationId: 'p', policy: WIDE_POLICY });
        if (!decision.liquidate) return;
        if (decision.closesPosition || decision.rung.trancheCapped) return;

        const remaining: LiquidationPosition = {
          ...c.position,
          size: c.position.size - decision.sizeClosed,
          margin: decision.marginRemaining,
        };
        const after = planLadderRung({ ...c, position: remaining, policy: WIDE_POLICY });
        expect(after.healthBps).toBeGreaterThanOrEqual(10_000);
        expect(after.action).not.toBe('liquidate');
      }),
      { numRuns: 1_500 },
    );
  });

  /**
   * AND IT IS THE MINIMUM — TO THE ATTOUNIT.
   *
   * Keeping one attounit MORE than the rung leaves must fail the target, or the
   * ladder is selling a position that did not need selling and no posting gives
   * it back.
   *
   * THIS IS THE ASSERTION THAT FOUND THE ONLY REAL DEFECT IN THIS FILE. The first
   * implementation solved the closed form once, against the position's CURRENT
   * maintenance tier, and called the surplus conservative. But the tier is keyed
   * on notional relative to depth, and closing shrinks notional — so a rung that
   * dropped the position into a cheaper tier over-closed. `largestRestoringKeep`
   * enumerates the tier ceilings as well as the per-tier solutions because of this
   * test.
   *
   * The feasibility check below is written out from `maintenanceBpsFor` rather
   * than calling the search, so it cannot inherit the assumption it is testing.
   */
  it('closes the smallest size that reaches the target (keeping one attounit more misses it)', () => {
    fc.assert(
      fc.property(liquidatableCases, (c) => {
        const decision = planLadderLiquidation({ ...c, liquidationId: 'p', policy: WIDE_POLICY });
        if (!decision.liquidate) return;
        if (decision.closesPosition || decision.rung.trancheCapped) return;

        const keptPlusOne = c.position.size - decision.sizeClosed + 1n;
        if (keptPlusOne >= c.position.size) return;

        // The requirement at the larger kept size, at whatever tier IT lands in.
        const notional = mul(keptPlusOne, c.markPrice, 'ceil');
        const required = mulBps(notional, maintenanceBpsFor(notional, c.depthNotional, WIDE_POLICY), 'ceil');
        // Equity is invariant under the close, so it is the rung's own equity that
        // has to fall short of the target at the larger size.
        expect(decision.rung.equity * 10_000n).toBeLessThan(BigInt(WIDE_POLICY.targetBps) * required);
      }),
      { numRuns: 2_000 },
    );
  });

  /**
   * MARGIN IS NEVER OVER-DRAWN, AND EVERY UNIT OF LOSS IS ACCOUNTED FOR.
   *
   * `fromMargin + fromInsurance === loss` is the ledger's balance condition
   * restated at the planner, and `fromMargin + residualRelease <= margin` is what
   * stops a rung posting more out of the collateral pot than the pot holds.
   */
  it('never draws more than the position holds, and splits every unit of loss', () => {
    fc.assert(
      fc.property(liquidatableCases, (c) => {
        const decision = planLadderLiquidation({ ...c, liquidationId: 'p', policy: DEFAULT_FUTURES_LADDER_POLICY });
        if (!decision.liquidate) return;
        expect(decision.fromMargin).toBeLessThanOrEqual(c.position.margin);
        expect(decision.fromMargin + decision.fromInsurance).toBe(decision.loss);
        expect(decision.fromMargin + decision.residualRelease).toBeLessThanOrEqual(c.position.margin);
        expect(decision.sizeClosed).toBeGreaterThan(0n);
        expect(decision.sizeClosed).toBeLessThanOrEqual(c.position.size);
        if (!decision.closesPosition) expect(decision.residualRelease).toBe(0n);
        // Insurance is only ever reached once margin is exhausted.
        if (decision.fromInsurance > 0n) expect(decision.fromMargin).toBe(c.position.margin);
      }),
      { numRuns: 2_000 },
    );
  });

  /**
   * EQUITY MOVES THE RIGHT WAY WITH THE MARK. A long marked lower never has more
   * equity, and a short marked higher never has more. Trivially true of correct
   * arithmetic, and the first thing a sign error breaks.
   *
   * NOTE WHAT THIS DELIBERATELY DOES NOT CLAIM. `healthBps` is NOT monotonic in
   * the mark, and asserting that it was is a test this file failed before it was
   * corrected. The requirement is a fraction of NOTIONAL, and notional moves with
   * the mark, so a falling mark shrinks the denominator as well as the numerator —
   * and crossing a depth-tier boundary steps it down discontinuously. A long can
   * therefore be marked lower and read healthier, at the tick where its notional
   * drops it out of a tier.
   *
   * That is a property of every tiered maintenance table, not of this one, and it
   * is written down here rather than smoothed over: the position genuinely IS
   * easier to close once it is a smaller fraction of the book it must be sold
   * into, which is the entire reason `DIRECTION` §1 asks for depth-referenced
   * tiers. What it costs is that "health always falls with the mark" is not an
   * invariant anyone may rely on.
   */
  it('never reports more equity at a worse mark (property)', () => {
    fc.assert(
      fc.property(positionArb, fc.integer({ min: 1, max: 500 }), (raw, moveBps) => {
        const c = buildCase(raw);
        const delta = (c.markPrice * BigInt(moveBps)) / 10_000n;
        const worse = raw.side === 'long' ? c.markPrice - delta : c.markPrice + delta;
        if (worse <= 0n) return;
        const at = planLadderRung({ ...c, policy: WIDE_POLICY });
        const after = planLadderRung({ ...c, markPrice: worse, policy: WIDE_POLICY });
        expect(after.equity).toBeLessThanOrEqual(at.equity);
      }),
      { numRuns: 1_500 },
    );
  });

  /**
   * CONSERVATION HOLDS WHATEVER THE NUMBERS ARE. Run against the SHIPPED default
   * as well, because that is the table production would use, and the one whose
   * rungs are almost always tranche-capped or bankrupt.
   */
  it('never draws more than the position holds, under the shipped default table too', () => {
    const defaultCases = positionArb.map(buildCase).filter((c) => {
      return planLadderRung({ ...c, policy: DEFAULT_FUTURES_LADDER_POLICY }).action === 'liquidate';
    });
    fc.assert(
      fc.property(defaultCases, (c) => {
        const decision = planLadderLiquidation({ ...c, liquidationId: 'p', policy: DEFAULT_FUTURES_LADDER_POLICY });
        if (!decision.liquidate) return;
        expect(decision.fromMargin).toBeLessThanOrEqual(c.position.margin);
        expect(decision.fromMargin + decision.fromInsurance).toBe(decision.loss);
        expect(decision.fromMargin + decision.residualRelease).toBeLessThanOrEqual(c.position.margin);
        expect(decision.sizeClosed).toBeLessThanOrEqual(c.position.size);
        if (decision.rung.bankrupt) expect(decision.closesPosition).toBe(true);
      }),
      { numRuns: 1_500 },
    );
  });
});

/** Kept out of the assertions above: proves the fixtures are the size we think. */
describe('fixture sanity', () => {
  it('the default position is a 10× long on a notional of 1 000', () => {
    expect(formatAmount(mul(position().size, position().entryPrice, 'ceil'))).toBe('1000');
    expect(mul(position().margin, amt('10'), 'floor')).toBe(mul(position().size, position().entryPrice, 'ceil'));
    expect(SCALE).toBe(10n ** 18n);
  });
});

/**
 * C15 / unit 9 — undelivered margin call never starts grace or seizes "from grace".
 *
 * Product today has no grace clock (honest: no transport). These pure seals pin
 * the law so a future grace field cannot open a seizure path without delivery.
 * Fails if someone adds grace-without-delivery by bypassing these helpers.
 */
describe('C15 margin-call delivery before grace / seizure', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  const past = new Date('2026-08-09T11:00:00.000Z');
  const future = new Date('2026-08-09T13:00:00.000Z');

  it('undelivered notice must not start grace', () => {
    expect(mayStartMarginCallGrace({ delivered: false })).toBe(false);
    expect(mayStartMarginCallGrace({ delivered: true })).toBe(true);
  });

  it('undelivered → never liquidate from "grace", even with a past expiry stamped', () => {
    // The bug class: graceExpiresAt written without delivery, then seizure.
    expect(
      mayLiquidateFromExpiredMarginCallGrace({
        delivered: false,
        graceExpiresAt: past,
        now,
      }),
    ).toBe(false);
  });

  it('delivered but no grace clock started → never seize from grace (current product)', () => {
    expect(
      mayLiquidateFromExpiredMarginCallGrace({
        delivered: true,
        graceExpiresAt: null,
        now,
      }),
    ).toBe(false);
    expect(
      mayLiquidateFromExpiredMarginCallGrace({
        delivered: true,
        graceExpiresAt: undefined,
        now,
      }),
    ).toBe(false);
  });

  it('delivered + grace still running → do not seize yet', () => {
    expect(
      mayLiquidateFromExpiredMarginCallGrace({
        delivered: true,
        graceExpiresAt: future,
        now,
      }),
    ).toBe(false);
  });

  it('delivered + grace expired → may seize (future path only; duration is owner D3)', () => {
    expect(
      mayLiquidateFromExpiredMarginCallGrace({
        delivered: true,
        graceExpiresAt: past,
        now,
      }),
    ).toBe(true);
  });

  it('margin-call rung plans no recipes (ladder never liquidates from the call alone)', () => {
    // Health under marginCallBps but still ≥ 10_000 → action margin-call, not liquidate.
    const required = mulBps(amt('1000'), 50, 'ceil');
    const atCall = (required * BigInt(DEFAULT_FUTURES_LADDER_POLICY.marginCallBps)) / 10_000n;
    const decision = planLadderLiquidation({
      liquidationId: 'mc-seal',
      position: position({ margin: atCall - 1n }),
      markPrice: amt('100'),
      depthNotional: amt('1000000'),
      policy: DEFAULT_FUTURES_LADDER_POLICY,
    });
    expect(decision.liquidate).toBe(false);
    expect(decision.rung.action).toBe('margin-call');
  });
});
