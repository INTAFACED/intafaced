import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW } from './codes.js';
import { lotIdOf, runLotEngine, type EngineMovement } from './lot-engine.js';

// Every figure here is hand-computed TEST data, not a real balance.
const at = (n: number) => new Date(Date.UTC(2026, 9, n));
const buy = (txId: string, day: number, qty: string, cost: string | null, source: 'trade' | 'deposit' = 'trade'): EngineMovement => ({
  side: 'acquire',
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  qty: amt(qty),
  costUsd: cost === null ? null : amt(cost),
  source,
  reason: source === 'trade' ? 'trade.fill' : 'deposit.credited',
  valuedAt: null,
});
const sell = (txId: string, day: number, qty: string, proceeds: string): EngineMovement => ({
  side: 'dispose',
  txId,
  postedAt: at(day),
  assetId: 'BTC',
  qty: amt(qty),
  proceedsUsd: amt(proceeds),
});
const s = (v: bigint | null) => (v === null ? null : formatAmount(v));

describe('runLotEngine', () => {
  // TEST lots of 1 at 100 and 1 at 200, then a sale of 1 for 300.
  const two = [buy('b1', 1, '1', '100'), buy('b2', 2, '1', '200'), sell('s1', 3, '1', '300')];

  it.each([
    ['FIFO', '200', '200'],
    ['LIFO', '100', '100'],
    ['HIFO', '100', '100'],
    ['AVERAGE', '150', '150'],
  ] as const)('%s: realised %s, and the coin left carries %s', (method, realised, left) => {
    const run = runLotEngine(two, method);
    expect(s(run.sales[0]!.realizedUsd)).toBe(realised);
    const open = run.lots.filter((l) => l.remaining > 0n);
    expect(open).toHaveLength(1);
    expect(s(open[0]!.remainingCostUsd)).toBe(left);
    // Closed plus open equals what arrived less what left.
    expect(run.lots.reduce((sum, l) => sum + l.remaining, 0n)).toBe(amt('1'));
  });

  it('AVERAGE: a sale leaves the average unchanged, a later buy moves it', () => {
    // 1 at 100 + 1 at 200 = 150 each; sell 1 (cost 150); buy 2 at 300 each: 150 + 600 over 3 = 250 each; sell 3 for 900.
    const run = runLotEngine([...two, buy('b3', 4, '2', '600'), sell('s2', 5, '3', '900')], 'AVERAGE');
    const last = run.sales.find((x) => x.txId === 's2')!;
    expect(s(last.costUsd)).toBe('750');
    expect(s(last.realizedUsd)).toBe('150');
    expect(run.lots.every((l) => l.remaining === 0n)).toBe(true);
  });

  it('lot ids come from the arrival and the coin, so the same history gives the same ids', () => {
    const run = runLotEngine(two, 'FIFO');
    expect(run.lots.map((l) => l.id)).toEqual([lotIdOf('b1', 'BTC'), lotIdOf('b2', 'BTC')]);
    expect(run.sales[0]!.matches).toEqual([
      { lotId: 'lot:b1:BTC', qty: amt('1'), costUsd: amt('100'), proceedsUsd: amt('300'), realizedUsd: amt('200'), customerEntered: false },
    ]);
  });

  it('a sale drawing on a lot with no basis is unknown for that part; a sale on a bought lot keeps its figures', () => {
    // 1 deposited (no basis) on day 1, 1 bought at 200 on day 2, sell 1 for 300 on day 3.
    const history = [buy('d1', 1, '1', null, 'deposit'), buy('b2', 2, '1', '200'), sell('s1', 3, '1', '300')];
    const fifo = runLotEngine(history, 'FIFO');
    expect(fifo.sales[0]).toMatchObject({ unmatchedQty: 0n, costUsd: null, realizedUsd: null });
    expect(fifo.sales[0]!.matches[0]).toMatchObject({ lotId: 'lot:d1:BTC', costUsd: null, realizedUsd: null });
    expect(fifo.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    const lifo = runLotEngine(history, 'LIFO');
    expect(s(lifo.sales[0]!.realizedUsd)).toBe('100');
    // The deposited lot is still open, with its basis unknown, never zero.
    expect(lifo.lots.find((l) => l.id === 'lot:d1:BTC')).toMatchObject({ remaining: amt('1'), remainingCostUsd: null });
  });

  it('HIFO cannot rank a lot with no basis, so the sale is unknown as a whole; AVERAGE too', () => {
    const history = [buy('d1', 1, '1', null, 'deposit'), buy('b2', 2, '1', '200'), sell('s1', 3, '1', '300')];
    expect(runLotEngine(history, 'HIFO').sales[0]).toMatchObject({ costUsd: null, realizedUsd: null });
    expect(runLotEngine(history, 'AVERAGE').sales[0]).toMatchObject({ costUsd: null, realizedUsd: null });
  });

  it('HIFO with a lot of unknown basis still draws the quantity: open quantity is bought minus sold, and what is left has no basis', () => {
    // TEST: 1 bought at 100, 1 deposited with no basis, 1 bought at 300; sell 2.
    const run = runLotEngine(
      [buy('b1', 1, '1', '100'), buy('d1', 2, '1', null, 'deposit'), buy('b3', 3, '1', '300'), sell('s1', 4, '2', '400')],
      'HIFO',
    );
    expect(run.sales[0]).toMatchObject({ unmatchedQty: 0n, costUsd: null, realizedUsd: null });
    expect(run.sales[0]!.matches.reduce((sum, x) => sum + x.qty, 0n)).toBe(amt('2'));
    expect(run.lots.reduce((sum, l) => sum + l.remaining, 0n)).toBe(amt('1'));
    expect(run.lots.filter((l) => l.remaining > 0n).every((l) => l.remainingCostUsd === null)).toBe(true);
    expect(run.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(run.residuals).not.toContain(TAX_LOT_UNDERFLOW);
  });

  it('a sale bigger than every open lot names the shortfall', () => {
    const run = runLotEngine([buy('b1', 1, '1', '100'), sell('s1', 2, '3', '600')], 'FIFO');
    expect(run.sales[0]).toMatchObject({ unmatchedQty: amt('2'), costUsd: null, realizedUsd: null });
    expect(run.residuals).toContain(TAX_LOT_UNDERFLOW);
  });

  it('a partial sale splits the lot cost and keeps the rest on the lot', () => {
    // 4 bought for 100; sell 1 for 40: cost 25, realised 15, 3 left at 75.
    const run = runLotEngine([buy('b1', 1, '4', '100'), sell('s1', 2, '1', '40')], 'FIFO');
    expect(s(run.sales[0]!.costUsd)).toBe('25');
    expect(s(run.sales[0]!.realizedUsd)).toBe('15');
    expect(run.lots[0]).toMatchObject({ remaining: amt('3'), remainingCostUsd: amt('75'), costUsd: amt('100') });
  });

  it('two arrivals of one coin in one transaction get distinct, repeatable ids', () => {
    const run = runLotEngine([buy('t1', 1, '1', null, 'deposit'), buy('t1', 1, '2', null, 'deposit')], 'FIFO');
    expect(run.lots.map((l) => l.id).sort()).toEqual(['lot:t1:BTC', 'lot:t1:BTC:2']);
  });

  it('AVERAGE: many small sales never make the cost left drift from the pool', () => {
    // TEST: 3 bought for 100 (33.33... each), then ten sales of 0.1 for 10 each.
    const sales = Array.from({ length: 10 }, (_, i) => sell(`s${i}`, 3 + i, '0.1', '10'));
    const run = runLotEngine([buy('b1', 1, '1', '10'), buy('b2', 2, '2', '90'), ...sales], 'AVERAGE');
    const taken = run.sales.reduce((sum, x) => sum + (x.costUsd ?? 0n), 0n);
    const left = run.lots.reduce((sum, l) => sum + (l.remainingCostUsd ?? 0n), 0n);
    expect(taken + left).toBe(amt('100'));
    expect(run.lots.reduce((sum, l) => sum + l.remaining, 0n)).toBe(amt('2'));
  });
});
