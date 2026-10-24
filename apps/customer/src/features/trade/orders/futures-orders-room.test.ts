import { describe, expect, it } from 'vitest';
import { cancellable } from '../../../screens/trade/futures/OrderStatus';
import { futuresExecutionPageSchema, type FuturesOrder } from '../../../screens/trade/futures/api';
import { readFuturesParams, writeFuturesParams } from './FuturesOrdersRoom';

const order = (over: Partial<FuturesOrder>): FuturesOrder => ({
  orderId: 'o-1',
  marketId: 'm-1',
  side: 'sell',
  type: 'market',
  qty: '1',
  limitPrice: '95',
  markPrice: '100',
  bandLow: '95',
  bandHigh: '105',
  holdAmount: '0',
  filledQty: '0',
  appliedAmount: '0',
  releasedAmount: '0',
  status: 'open',
  refusalCode: null,
  reduceOnly: true,
  positionId: 'p-1',
  bankruptcyPrice: '90',
  ...over,
});

describe('the futures orders room', () => {
  it('keeps its view and filters in the address, and reads an unknown view as open', () => {
    const params = { view: 'history' as const, symbol: 'BTC/USDT:USDT', origin: 'stop', label: 'grid-7', kind: '' };
    expect(writeFuturesParams(params)).toBe('?product=futures&view=history&symbol=BTC%2FUSDT%3AUSDT&origin=stop&label=grid-7');
    expect(readFuturesParams(writeFuturesParams(params))).toEqual(params);
    expect(readFuturesParams('?product=futures&view=everything').view).toBe('open');
    expect(writeFuturesParams(readFuturesParams(''))).toBe('?product=futures');
  });

  it('offers cancel on a live order of the trader’s own, never on a liquidation order or an ended one', () => {
    expect(cancellable(order({ origin: 'user' }))).toBe(true);
    expect(cancellable(order({ origin: 'stop_loss' }))).toBe(true);
    expect(cancellable(order({}))).toBe(true);
    expect(cancellable(order({ origin: 'liquidation' }))).toBe(false);
    expect(cancellable(order({ status: 'filled' }))).toBe(false);
  });
});

describe('futures executions page', () => {
  it('reads a close that realised a loss', () => {
    const page = futuresExecutionPageSchema.safeParse({
      executions: [
        {
          id: 'f-1',
          kind: 'close',
          symbol: 'BTC/USDT:USDT',
          side: 'sell',
          qty: '0.01',
          price: '65100',
          fee: '0.3256',
          feeRole: 'taker',
          realizedPnl: '-0.782',
          orderId: 'o-1',
          origin: 'stop',
          orderLabel: null,
          positionId: 'p-1',
          at: '2026-10-24T06:51:16.059Z',
        },
      ],
      next: null,
    });
    expect(page.success).toBe(true);
  });
});
