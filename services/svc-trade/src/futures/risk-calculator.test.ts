import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { initialMargin } from './initial-margin.js';
import { liquidationPriceFor } from './liquidation-price.js';
import { maintenanceBpsFor, type FuturesLadderPolicy } from './maintenance-ladder.js';
import { calculate, riskTiers, tierOf } from './risk-calculator.js';

// The coarse mechanism-test ladder (ladder-policy.test-harness.ts), never an owner table.
const POLICY: FuturesLadderPolicy = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 50 },
    { uptoDepthBps: 2_000, maintenanceBps: 100 },
    { uptoDepthBps: 5_000, maintenanceBps: 250 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};
const a = parseAmount;
const f = (v: bigint | null) => (v === null ? null : formatAmount(v));

describe('riskTiers', () => {
  it('lists every published tier with its notional bound at today’s depth on each side', () => {
    const tiers = riskTiers(POLICY, { long: a('10000'), short: a('4000') });
    expect(tiers.map((t) => [t.tier, t.uptoDepthBps, t.maintenanceBps, f(t.notionalUpto.long), f(t.notionalUpto.short)])).toEqual([
      [1, 500, 50, '500', '200'],
      [2, 2_000, 100, '2000', '800'],
      [3, 5_000, 250, '5000', '2000'],
      [4, null, 500, null, null],
    ]);
  });

  it('an unreadable side leaves its bounds empty rather than guessing a depth', () => {
    const tiers = riskTiers(POLICY, { long: null, short: a('0') });
    expect(tiers.every((t) => t.notionalUpto.long === null && t.notionalUpto.short === null)).toBe(true);
    expect(tiers.map((t) => t.maintenanceBps)).toEqual([50, 100, 250, 500]);
  });

  it('a notional at a tier’s bound is rated in that tier, one unit more in the next', () => {
    const depth = a('10000');
    const [first] = riskTiers(POLICY, { long: depth, short: depth });
    const bound = first!.notionalUpto.long!;
    expect(tierOf(bound, depth, POLICY)).toEqual({ tier: 1, maintenanceBps: 50 });
    expect(tierOf(bound + 1n, depth, POLICY)).toEqual({ tier: 2, maintenanceBps: 100 });
    expect(maintenanceBpsFor(bound + 1n, depth, POLICY)).toBe(100);
  });
});

describe('calculate', () => {
  const base = {
    size: a('1'),
    entryPrice: a('100'),
    leverage: a('10'),
    exitPrice: a('110'),
    takerBps: 5,
    policy: POLICY,
    depthNotional: a('10000'),
  };

  it('a long: margin, tier, maintenance, liquidation price, P&L and fees', () => {
    const r = calculate({ ...base, side: 'long' });
    expect({
      notional: f(r.notional),
      initialMargin: f(r.initialMargin),
      tier: r.tier,
      maintenanceBps: r.maintenanceBps,
      maintenanceMargin: f(r.maintenanceMargin),
      liquidationPrice: f(r.liquidationPrice),
      pnl: f(r.pnl),
      roePercent: f(r.roePercent),
      entryFee: f(r.entryFee),
      exitFee: f(r.exitFee),
      netPnl: f(r.netPnl),
    }).toEqual({
      notional: '100',
      initialMargin: '10',
      tier: 1,
      maintenanceBps: 50,
      maintenanceMargin: '0.5',
      // (1 × 100 − 10) ÷ (1 × (1 − 0.005)), rounded toward the mark.
      liquidationPrice: '90.452261306532663317',
      pnl: '10',
      roePercent: '100',
      entryFee: '0.05',
      exitFee: '0.055',
      netPnl: '9.895',
    });
  });

  it('a short at the same inputs loses as the price rises', () => {
    const r = calculate({ ...base, side: 'short' });
    // (1 × 100 + 10) ÷ (1 × (1 + 0.005)), rounded toward the mark.
    expect(f(r.liquidationPrice)).toBe('109.452736318407960199');
    expect(f(r.pnl)).toBe('-10');
    expect(f(r.roePercent)).toBe('-100');
    expect(f(r.netPnl)).toBe('-10.105');
  });

  it('matches the ladder’s own liquidation price and the preview’s margin for the same inputs', () => {
    for (const side of ['long', 'short'] as const) {
      for (const [size, entry, leverage, depth] of [
        ['0.37', '61234.5', '7', '250000'],
        ['12', '99.99', '3', '800'],
        ['0.001', '30000', '10', '1000000'],
      ] as const) {
        const input = { side, size: a(size), entryPrice: a(entry), leverage: a(leverage), depthNotional: a(depth) };
        const r = calculate({ ...input, exitPrice: null, takerBps: null, policy: POLICY });
        const margin = initialMargin({ size: input.size, entryPrice: input.entryPrice, leverage: input.leverage });
        expect(r.initialMargin).toBe(margin);
        const liq = liquidationPriceFor({ ...input, margin, policy: POLICY });
        expect(r.liquidationPrice).toBe(liq.price);
      }
    }
  });

  it('no published ladder: margin and P&L still show, maintenance and liquidation say why they are empty', () => {
    const r = calculate({ ...base, side: 'long', policy: null });
    expect(f(r.initialMargin)).toBe('10');
    expect(f(r.pnl)).toBe('10');
    expect([r.tier, r.maintenanceMargin, r.liquidationPrice, r.liquidationReason]).toEqual([null, null, null, 'ladder_unset']);
  });

  it('no readable depth: the tier is not guessed', () => {
    expect(calculate({ ...base, side: 'long', depthNotional: null }).liquidationReason).toBe('depth_unknown');
    expect(calculate({ ...base, side: 'long', depthNotional: 0n }).liquidationReason).toBe('depth_unknown');
  });

  it('a long at 1x is never liquidated by price', () => {
    const r = calculate({ ...base, side: 'long', leverage: a('1') });
    expect([r.liquidationPrice, r.liquidationReason]).toEqual([null, 'no_price_above_zero']);
  });

  it('no exit price or no published fee leaves those lines empty', () => {
    const r = calculate({ ...base, side: 'long', exitPrice: null, takerBps: null });
    expect([r.pnl, r.roePercent, r.entryFee, r.exitFee, r.netPnl]).toEqual([null, null, null, null, null]);
  });
});
