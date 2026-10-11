import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW } from './codes.js';
import { runLots, type LotMovement } from './lots.js';

function mv(
  partial: Omit<LotMovement, 'qty' | 'costBasis' | 'proceeds' | 'postedAt'> & {
    qty: string;
    costBasis?: string | null;
    proceeds?: string | null;
    at: string;
  },
): LotMovement {
  return {
    assetId: partial.assetId,
    side: partial.side,
    qty: parseAmount(partial.qty),
    costBasis: partial.costBasis == null ? null : parseAmount(partial.costBasis),
    proceeds: partial.proceeds == null ? null : parseAmount(partial.proceeds),
    postedAt: new Date(partial.at),
    txId: partial.txId,
    reason: partial.reason,
  };
}

describe('runLots', () => {
  const twoAcquiresThenDispose: LotMovement[] = [
    mv({ assetId: 'BTC', side: 'acquire', qty: '2', costBasis: '20000', txId: 'a1', reason: 'deposit', at: '2024-01-01T00:00:00.000Z' }),
    mv({ assetId: 'BTC', side: 'acquire', qty: '1', costBasis: '30000', txId: 'a2', reason: 'deposit', at: '2024-06-01T00:00:00.000Z' }),
    mv({
      assetId: 'BTC',
      side: 'dispose',
      qty: '1',
      proceeds: '25000',
      txId: 'd1',
      reason: 'trade.fill',
      at: '2024-12-01T00:00:00.000Z',
    }),
  ];

  it('FIFO disposes the oldest lot', () => {
    const out = runLots(twoAcquiresThenDispose, 'FIFO');
    expect(out.lotsClosed).toHaveLength(1);
    expect(out.lotsClosed[0]?.acquireTxId).toBe('a1');
    expect(out.lotsClosed[0]?.qty).toBe('1');
    expect(out.lotsClosed[0]?.realized).toBe('15000');
    expect(out.realized).toBe('15000');
    expect(out.lotsOpen).toHaveLength(2);
  });

  it('LIFO disposes the newest lot', () => {
    const out = runLots(twoAcquiresThenDispose, 'LIFO');
    expect(out.lotsClosed[0]?.acquireTxId).toBe('a2');
    expect(out.lotsClosed[0]?.realized).toBe('-5000');
  });

  it('HIFO disposes the highest cost lot', () => {
    const out = runLots(twoAcquiresThenDispose, 'HIFO');
    expect(out.lotsClosed[0]?.acquireTxId).toBe('a2');
    expect(out.lotsClosed[0]?.costBasis).toBe('30000');
  });

  it('missing cost is never treated as 0 — realized stays null', () => {
    const out = runLots(
      [
        mv({ assetId: 'ETH', side: 'acquire', qty: '1', txId: 'a', reason: 'deposit', at: '2024-01-01T00:00:00.000Z' }),
        mv({ assetId: 'ETH', side: 'dispose', qty: '1', txId: 'd', reason: 'trade.fill', at: '2024-02-01T00:00:00.000Z' }),
      ],
      'FIFO',
    );
    expect(out.lotsClosed).toEqual([]);
    expect(out.lotsOpen).toHaveLength(1);
    expect(out.lotsOpen[0]?.costBasis).toBeNull();
    expect(out.realized).toBeNull();
    expect(out.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    expect(out.residuals).not.toContain(TAX_LOT_UNDERFLOW);
  });

  it('does not invent a FIFO/LIFO/HIFO pairing when any open lot lacks basis', () => {
    const mixed: LotMovement[] = [
      mv({ assetId: 'BTC', side: 'acquire', qty: '1', txId: 'unknown', reason: 'deposit', at: '2024-01-01T00:00:00.000Z' }),
      mv({
        assetId: 'BTC',
        side: 'acquire',
        qty: '1',
        costBasis: '40000',
        txId: 'known',
        reason: 'deposit',
        at: '2024-02-01T00:00:00.000Z',
      }),
      mv({
        assetId: 'BTC',
        side: 'dispose',
        qty: '1',
        proceeds: '50000',
        txId: 'd',
        reason: 'trade.fill',
        at: '2024-03-01T00:00:00.000Z',
      }),
    ];
    for (const method of ['FIFO', 'LIFO', 'HIFO'] as const) {
      const out = runLots(mixed, method);
      expect(out.lotsClosed, method).toEqual([]);
      expect(out.lotsOpen).toHaveLength(2);
      expect(out.realized).toBeNull();
      expect(out.residuals).toContain(TAX_COST_BASIS_UNAVAILABLE);
    }
  });

  it('empty movements are empty, not a $0 PnL', () => {
    const out = runLots([], 'FIFO');
    expect(out.lotsClosed).toEqual([]);
    expect(out.lotsOpen).toEqual([]);
    expect(out.realized).toBeNull();
    expect(out.unrealized).toBeNull();
  });

  it('blank market price leaves unrealized null, not the open cost basis', () => {
    const out = runLots(
      [
        mv({
          assetId: 'BTC',
          side: 'acquire',
          qty: '2',
          costBasis: '20000',
          txId: 'a1',
          reason: 'deposit',
          at: '2024-01-01T00:00:00.000Z',
        }),
        mv({
          assetId: 'BTC',
          side: 'acquire',
          qty: '1',
          costBasis: '30000',
          txId: 'a2',
          reason: 'deposit',
          at: '2024-06-01T00:00:00.000Z',
        }),
      ],
      'FIFO',
    );
    expect(out.lotsOpen).toHaveLength(2);
    expect(out.lotsOpen[0]?.costBasis).toBe('20000');
    expect(out.lotsOpen[1]?.costBasis).toBe('30000');
    expect(out.unrealized).toBeNull();
  });

  it('dispose beyond open lots is a named underflow, not a negative invent', () => {
    const out = runLots(
      [mv({ assetId: 'BTC', side: 'dispose', qty: '1', txId: 'd', reason: 'trade.fill', at: '2024-01-01T00:00:00.000Z' })],
      'FIFO',
    );
    expect(out.lotsClosed).toEqual([]);
    expect(out.residuals).toContain(TAX_LOT_UNDERFLOW);
    expect(out.realized).toBeNull();
  });
});
