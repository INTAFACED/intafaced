import { describe, expect, it } from 'vitest';
import type { VenueFill } from '../../../features/trade/venue-api';
import { billsOf } from './venue-account-logic';

const fill = (over: Partial<VenueFill>): VenueFill => ({
  fillId: 'f-1',
  venueClientOrderId: null,
  symbol: 'XBIL-PERP',
  side: 'buy',
  price: '100.1',
  amount: '0.2',
  role: 'taker',
  venueFee: '0.009009',
  builderFee: '0.001001',
  feeAsset: 'USDC',
  realisedPnl: null,
  filledAt: '2026-11-18T10:00:00.000Z',
  ...over,
});

describe('billsOf (J-derivatives-12 #4)', () => {
  it("lists funding, a close and a liquidation with the venue's ids, and our builder fee on each fill with its ledger id", () => {
    const bills = billsOf({
      funding: [
        {
          paymentId: 'fund-1',
          symbol: 'XBIL-PERP',
          side: 'long',
          size: '0.2',
          markPrice: '100',
          rate: '0.0000125',
          amount: '-0.00025',
          asset: 'USDC',
          periodAt: '2026-11-18T10:01:00.000Z',
        },
      ],
      fills: [
        fill({}),
        fill({ fillId: 'f-2', side: 'sell', amount: '0.1', realisedPnl: '-0.02', filledAt: '2026-11-18T10:02:00.000Z' }),
        fill({ fillId: 'f-3', builderFee: '0', filledAt: '2026-11-18T10:03:00.000Z' }),
      ],
      liquidations: [
        {
          liquidationId: 'liq-1',
          symbol: 'XBIL-PERP',
          side: 'long',
          state: 'done',
          startedAt: '2026-11-18T10:04:00.000Z',
          parts: [{ partId: 'liq-1-1', size: '0.1', price: '80', fee: '0.08', feeAsset: 'USDC', liquidatedAt: '2026-11-18T10:04:00.000Z' }],
        },
      ],
      builderFees: [
        {
          fillId: 'f-1',
          amount: '0.001001',
          asset: 'USDC',
          filledAt: '2026-11-18T10:00:00.000Z',
          status: 'posted',
          refusalCode: null,
          ledgerTxId: 'tx-1',
        },
      ],
    });
    expect(bills.map((b) => [b.kind, b.venueRef, b.amount])).toEqual([
      ['builder_fee', 'f-1', '0.001001'],
      ['funding', 'fund-1', '-0.00025'],
      ['close', 'f-2', '-0.02'],
      ['builder_fee', 'f-2', '0.001001'],
      ['liquidation', 'liq-1-1', '0.08'],
    ]);
    expect(bills[0]).toMatchObject({ ledgerTxId: 'tx-1', ledgerStatus: 'posted' });
    // A fill whose fee is not yet recorded shows no ledger id, never a made-up one.
    expect(bills[3]).toMatchObject({ ledgerTxId: null, ledgerStatus: null });
    expect(bills[4]).toMatchObject({ liquidationId: 'liq-1' });
  });
});
