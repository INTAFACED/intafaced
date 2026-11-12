/**
 * J-copy-bots-otc-06 #2 to #5: a copied position by average entry, a lead's earnings as fee-share rows only, the level
 * not set while thresholds are blank, and every profit share or maximum ratio refused before anything is read or written.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { allocateCopiedPositions, copiedMarketPositions, type CopiedBuy } from './copied-positions.js';
import { CopyError } from './errors.js';
import {
  LEAD_PROFIT_SHARE_REFUSAL,
  presentLeadEarnings,
  presentLeadLevel,
  refuseLeadMaxRatio,
  refuseLeadProfitShare,
} from './lead-desk.js';

const lot = parseAmount('0.0001');
function buy(n: number, qty: string, cost: string, over: Partial<CopiedBuy> = {}): CopiedBuy {
  return {
    orderId: `order-${n}`,
    leaderFillId: `fill-${n}`,
    symbol: 'BTC/USDT',
    marketId: 'm-btc',
    baseAsset: 'BTC',
    lotSize: lot,
    received: parseAmount(qty),
    live: false,
    placedAt: new Date(Date.UTC(2026, 10, 12, 8, 0, n)),
    entryQty: parseAmount(qty),
    entryCost: parseAmount(cost),
    fills: 1,
    ...over,
  };
}

describe('copiedMarketPositions (average entry)', () => {
  it('averages the entry over the two fills, weighted by what each filled, and says funding is not set', () => {
    const positions = allocateCopiedPositions({
      buys: [buy(1, '0.001', '70'), buy(2, '0.003', '216')],
      targeted: new Map(),
      untargeted: new Map(),
    });
    expect(copiedMarketPositions(positions)).toEqual([
      { market: 'BTC/USDT', fills: 2, filled: '0.004', open: '0.004', averageEntry: '71500', funding: null },
    ]);
  });

  it('a sell lowers what is open and never moves the average entry', () => {
    const positions = allocateCopiedPositions({
      buys: [buy(1, '0.001', '70'), buy(2, '0.001', '72')],
      targeted: new Map(),
      untargeted: new Map([['BTC/USDT', [{ sold: parseAmount('0.0015'), pending: 0n }]]]),
    });
    const [row] = copiedMarketPositions(positions);
    expect(row).toMatchObject({ open: '0.0005', averageEntry: '71000', fills: 2 });
  });

  it('a buy with no fill yet has no average entry, never a zero price', () => {
    const positions = allocateCopiedPositions({
      buys: [buy(1, '0', '0', { live: true, entryQty: 0n, entryCost: 0n, fills: 0 })],
      targeted: new Map(),
      untargeted: new Map(),
    });
    expect(copiedMarketPositions(positions)).toEqual([
      { market: 'BTC/USDT', fills: 0, filled: '0', open: '0', averageEntry: null, funding: null },
    ]);
  });
});

describe('presentLeadEarnings', () => {
  const law = { published: true as const, leaderShareBps: 1000, earningsCapPerFollower: '100', decayRoundTrips: 0, decayShareBps: 1000 };
  const row = (fill: string, amount: string, asset = 'USDT') => ({
    fillId: fill,
    followId: 'f-1',
    assetId: asset,
    feeOnFill: parseAmount('0.07'),
    appliedShareBps: 1000,
    amount: parseAmount(amount),
    at: new Date(Date.UTC(2026, 10, 12, 9)),
  });

  it('shows each fee-share row and its sum per asset, with the profit-share sentence and no profit figure', () => {
    const out = presentLeadEarnings(law, [row('a', '0.007'), row('b', '0.0072'), row('c', '1', 'BTC')]);
    expect(out.profitShare).toBe(LEAD_PROFIT_SHARE_REFUSAL);
    expect(out.leaderShareBps).toBe('1000');
    expect(out.totals).toEqual([
      { assetId: 'BTC', amount: '1' },
      { assetId: 'USDT', amount: '0.0142' },
    ]);
    expect(out.items[0]).toEqual({
      fillId: 'a',
      followId: 'f-1',
      assetId: 'USDT',
      feeOnFill: '0.07',
      appliedShareBps: 1000,
      amount: '0.007',
      at: '2026-11-12T09:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toMatch(/pnl|profitAmount|return|unreali[sz]ed|roi/i);
  });

  it('with no rows there are no totals, never a zero; an unpublished share stays null', () => {
    const out = presentLeadEarnings({ published: false }, []);
    expect(out).toMatchObject({ totals: [], items: [], leaderShareBps: null });
  });
});

describe('the lead level', () => {
  it('is not set while the owner has published no thresholds, and the maximum ratio is never the platform’s', () => {
    expect(presentLeadLevel({ leaderRef: 'L-1', state: 'listed' })).toEqual({
      leaderRef: 'L-1',
      listingState: 'listed',
      level: null,
      levelReason: 'thresholds_unset',
      maxRatio: null,
    });
  });
});

describe('profit share and maximum ratio', () => {
  it.each([
    ['a profit pre-deduction', refuseLeadProfitShare],
    ['a maximum ratio', refuseLeadMaxRatio],
  ])('%s is refused trade.copy_pnl_fee_forbidden', (_name, refuse) => {
    let caught: unknown;
    try {
      refuse();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CopyError);
    expect((caught as CopyError).code).toBe('trade.copy_pnl_fee_forbidden');
  });
});
