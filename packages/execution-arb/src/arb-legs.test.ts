import { describe, expect, it } from 'vitest';
import { ARB_LEGS_ATOMIC, planArbLegs, reduceArbLegGroup, type ArbLegResult } from './arb-legs.js';

function leg(over: Partial<ArbLegResult> & Pick<ArbLegResult, 'outcome'>): ArbLegResult {
  return {
    side: over.side ?? (over.venueId === 'sell-v' ? 'sell' : 'buy'),
    venueId: over.venueId ?? (over.side === 'sell' ? 'sell-v' : 'buy-v'),
    outcome: over.outcome,
  };
}

describe('planArbLegs — non-atomic inventory plan', () => {
  it('plans buy+sell with atomic false', () => {
    const planned = planArbLegs({
      symbol: 'BTC/USDT',
      amount: '1',
      buyVenueId: 'binance',
      sellVenueId: 'bybit',
      inventory: { prePositionedByVenue: { binance: true, bybit: true } },
    });
    expect(planned).toMatchObject({
      ok: true,
      atomic: false,
      expectedLegCount: 2,
      amount: '1',
    });
    expect(ARB_LEGS_ATOMIC).toBe(false);
    if (!planned.ok) return;
    expect(planned.legs.map((l) => `${l.side}:${l.venueId}`)).toEqual(['buy:binance', 'sell:bybit']);
  });

  it('refuses same venue and missing inventory', () => {
    expect(
      planArbLegs({
        symbol: 'BTC/USDT',
        amount: '1',
        buyVenueId: 'binance',
        sellVenueId: 'binance',
        inventory: { prePositionedByVenue: { binance: true } },
      }),
    ).toMatchObject({ ok: false, atomic: false, reason: 'same_venue' });
    expect(
      planArbLegs({
        symbol: 'BTC/USDT',
        amount: '1',
        buyVenueId: 'binance',
        sellVenueId: 'bybit',
        inventory: { prePositionedByVenue: { binance: true, bybit: false } },
      }),
    ).toMatchObject({ ok: false, atomic: false, reason: 'inventory_missing' });
  });

  it('refuses a blank, whitespace, zero, or non-decimal size instead of accepting a plan', () => {
    const inventory = { prePositionedByVenue: { binance: true, bybit: true } };
    for (const amount of ['', '   ', '0', '0.00', '-1', 'not-money', '1e-2']) {
      const planned = planArbLegs({
        symbol: 'BTC/USDT',
        amount,
        buyVenueId: 'binance',
        sellVenueId: 'bybit',
        inventory,
      });
      expect(planned, amount).toMatchObject({ ok: false, atomic: false, reason: 'size_refused' });
      expect(planned).not.toHaveProperty('legs');
    }
  });
});

describe('reduceArbLegGroup — failed/unknown is not group success', () => {
  it('all applied expected legs succeed and stay non-atomic', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [leg({ side: 'buy', venueId: 'binance', outcome: 'APPLIED' }), leg({ side: 'sell', venueId: 'bybit', outcome: 'APPLIED' })],
    });
    expect(result).toMatchObject({ ok: true, atomic: false, outcome: 'APPLIED' });
    if (!result.ok) return;
    expect(result.applied).toHaveLength(2);
    expect(result.refused).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('applied + refused is REFUSED partial — not a successful arb', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [leg({ side: 'buy', venueId: 'binance', outcome: 'APPLIED' }), leg({ side: 'sell', venueId: 'bybit', outcome: 'REFUSED' })],
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, atomic: false, outcome: 'REFUSED', reason: 'partial_legs' });
    if (result.ok) return;
    expect(result.applied).toHaveLength(1);
    expect(result.refused).toHaveLength(1);
  });

  it('applied + unknown is OUTCOME_UNKNOWN — not success, not a refuse-as-reject', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [
        leg({ side: 'buy', venueId: 'binance', outcome: 'APPLIED' }),
        leg({ side: 'sell', venueId: 'bybit', outcome: 'OUTCOME_UNKNOWN' }),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, atomic: false, outcome: 'OUTCOME_UNKNOWN', reason: 'unknown_leg' });
    if (result.ok) return;
    expect(result.applied).toHaveLength(1);
    expect(result.unknown).toHaveLength(1);
  });

  it('unknown beats refused so a hole is not classified as reject', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [
        leg({ side: 'buy', venueId: 'binance', outcome: 'REFUSED' }),
        leg({ side: 'sell', venueId: 'bybit', outcome: 'OUTCOME_UNKNOWN' }),
      ],
    });
    expect(result).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN', reason: 'unknown_leg' });
  });

  it('unwired second leg is REFUSED partial, not group success', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [leg({ side: 'buy', venueId: 'binance', outcome: 'APPLIED' }), leg({ side: 'sell', venueId: 'bybit', outcome: 'UNWIRED' })],
    });
    expect(result).toMatchObject({ ok: false, outcome: 'REFUSED', reason: 'partial_legs' });
  });

  it('a truncated observation of one applied leg is not success', () => {
    const result = reduceArbLegGroup({
      expectedLegCount: 2,
      legs: [leg({ side: 'buy', venueId: 'binance', outcome: 'APPLIED' })],
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, outcome: 'OUTCOME_UNKNOWN', reason: 'incomplete_legs' });
  });

  it('empty or unset expected count cannot invent group success', () => {
    expect(reduceArbLegGroup({ expectedLegCount: 2, legs: [] })).toMatchObject({
      ok: false,
      outcome: 'REFUSED',
      reason: 'empty_legs',
    });
    expect(reduceArbLegGroup({ expectedLegCount: 0, legs: [leg({ outcome: 'APPLIED' })] })).toMatchObject({
      ok: false,
      reason: 'empty_legs',
    });
  });

  it('both legs refused is failed_leg, not APPLIED', () => {
    expect(
      reduceArbLegGroup({
        expectedLegCount: 2,
        legs: [leg({ side: 'buy', outcome: 'REFUSED' }), leg({ side: 'sell', outcome: 'REFUSED' })],
      }),
    ).toMatchObject({ ok: false, outcome: 'REFUSED', reason: 'failed_leg' });
  });
});
