import { describe, expect, it } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  allInCost,
  bpsToPct,
  closeAllPlan,
  fundingEstimate,
  healthOf,
  isStale,
  leveragePresets,
  liquidationDistancePct,
  maxSizeEstimate,
  percentOfSize,
  stableOrder,
  totalsOf,
  worstHealth,
} from './model';

// TEST data only: every figure below is made up for the unit tests and is never shown to a customer.
function position(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'BTC/USDT:USDT',
    timestamp: 1_000,
    datetime: '1970-01-01T00:00:01.000Z',
    side: 'long',
    status: 'open',
    closingReason: null,
    contracts: '0.1',
    contractSize: null,
    entryPrice: '60000',
    markPrice: '59000',
    notional: '5900',
    leverage: '5',
    collateral: '1200',
    initialMargin: '1200',
    maintenanceMargin: '300',
    unrealizedPnl: '-100',
    realizedPnl: null,
    liquidationPrice: '48000',
    marginMode: 'isolated',
    percentage: null,
    ...over,
  };
}

describe('healthOf', () => {
  it('is maintenance over equity, exact', () => {
    const h = healthOf(position());
    expect(h.equity).toBe('1100');
    expect(h.marginRatioPct).toBe('27.27');
    expect(h.band).toBe('ok');
  });
  it('bands at 50 and 80 percent and 100 is liquidatable', () => {
    expect(healthOf(position({ maintenanceMargin: '600' })).band).toBe('watch');
    expect(healthOf(position({ maintenanceMargin: '900' })).band).toBe('danger');
    expect(healthOf(position({ maintenanceMargin: '1100' })).band).toBe('liquidation');
    expect(healthOf(position({ unrealizedPnl: '-1300' })).band).toBe('liquidation');
  });
  it('is unknown, with the reason, when a published field is missing', () => {
    expect(healthOf(position({ maintenanceMargin: null }))).toMatchObject({
      band: 'unknown',
      marginRatioPct: null,
      unknownWhy: 'maintenance',
    });
    expect(healthOf(position({ unrealizedPnl: null }))).toMatchObject({ band: 'unknown', unknownWhy: 'pnl' });
    expect(healthOf(position({ collateral: null }))).toMatchObject({ band: 'unknown', unknownWhy: 'collateral' });
  });
});

describe('liquidationDistancePct', () => {
  it('measures from the mark toward the liquidation price on each side', () => {
    expect(liquidationDistancePct(position())).toBe('18.64');
    expect(liquidationDistancePct(position({ side: 'short', liquidationPrice: '70000' }))).toBe('18.64');
  });
  it('is null when either price is unknown', () => {
    expect(liquidationDistancePct(position({ markPrice: null }))).toBeNull();
    expect(liquidationDistancePct(position({ liquidationPrice: null }))).toBeNull();
  });
});

describe('totalsOf and worstHealth', () => {
  it('sums live positions exactly and ignores closed ones', () => {
    const t = totalsOf([
      position(),
      position({ id: 'p2', collateral: '800.5', unrealizedPnl: '50.25' }),
      position({ id: 'p3', status: 'closed' }),
    ]);
    expect(t).toMatchObject({ count: 2, collateral: '2000.5', unrealizedPnl: '-49.75' });
  });
  it('makes a total unknown, not partial, when one part is unknown', () => {
    expect(totalsOf([position(), position({ id: 'p2', unrealizedPnl: null })]).unrealizedPnl).toBeNull();
  });
  it('picks the highest band, then the highest ratio', () => {
    const w = worstHealth([
      position({ id: 'a' }),
      position({ id: 'b', maintenanceMargin: '900' }),
      position({ id: 'c', maintenanceMargin: '1000' }),
    ]);
    expect(w.positionId).toBe('c');
    expect(w.band).toBe('danger');
  });
});

describe('allInCost', () => {
  it('adds margin and fee and subtracts from the free balance', () => {
    const c = allInCost({ orderValue: '6000', initialMargin: '1200', estimatedFee: '3.6' }, '1500');
    expect(c).toMatchObject({ totalToCommit: '1203.6', freeAfter: '296.4', insufficient: false });
  });
  it('flags insufficient and keeps unknown as null', () => {
    expect(allInCost({ orderValue: '1', initialMargin: '1200', estimatedFee: '3.6' }, '1000').insufficient).toBe(true);
    expect(allInCost({ orderValue: '1', initialMargin: null, estimatedFee: '3.6' }, '1000')).toMatchObject({
      totalToCommit: null,
      freeAfter: null,
      insufficient: null,
    });
    expect(allInCost(null, null).totalToCommit).toBeNull();
  });
});

describe('funding, sizing and presets', () => {
  it('a long pays when the rate is positive, a short receives', () => {
    expect(fundingEstimate(position(), '0.0001')).toBe('-0.59');
    expect(fundingEstimate(position({ side: 'short' }), '0.0001')).toBe('0.59');
    expect(fundingEstimate(position(), null)).toBeNull();
  });
  it('estimates the largest size and truncates a percent of it', () => {
    expect(maxSizeEstimate('1000', '5', '50000')).toBe('0.1');
    expect(maxSizeEstimate('0', '5', '50000')).toBeNull();
    expect(percentOfSize('0.1', 25, 4)).toBe('0.025');
    expect(percentOfSize('0.1', 33, 2)).toBe('0.03');
    expect(percentOfSize('0.1', 101, 2)).toBeNull();
  });
  it('offers only presets at or under the cap, none without a cap', () => {
    expect(leveragePresets('10')).toEqual(['1', '2', '3', '5', '10']);
    expect(leveragePresets(null)).toEqual([]);
  });
});

describe('ordering, staleness and plans', () => {
  it('keeps oldest first so rows do not jump', () => {
    expect(
      stableOrder([position({ id: 'b', timestamp: 5 }), position({ id: 'a', timestamp: 9 }), position({ id: 'c', timestamp: 5 })]).map(
        (p) => p.id,
      ),
    ).toEqual(['b', 'c', 'a']);
  });
  it('treats an unknown age as stale', () => {
    expect(isStale(null, 1_000, 500)).toBe(true);
    expect(isStale(900, 1_000, 500)).toBe(false);
    expect(isStale(100, 1_000, 500)).toBe(true);
  });
  it('close-all sends live positions that have an id, closing ones included', () => {
    const plan = closeAllPlan([
      position({ id: 'a' }),
      position({ id: 'b', status: 'closing' }),
      position({ id: 'c', status: 'closed' }),
      position({ id: null }),
    ]);
    expect(plan.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('turns basis points into percent', () => {
    expect(bpsToPct(6250)).toBe('62.50');
  });
});
