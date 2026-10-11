import { describe, expect, it } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import type { TradeAdapter, VenueOrder } from '@intafaced/venue-contracts';
import type { SubmitRequest } from '@intafaced/venue-adapter';
import { tradeAdapterSubmit, venueOrderToExecution } from './oms-trade-submit.js';

const now = new Date('2026-08-17T12:00:00.000Z');

function request(): SubmitRequest {
  return {
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: parseAmount('1'),
    limitPrice: parseAmount('100'),
    clientOrderId: 'oms-street',
  };
}

function order(over: Partial<VenueOrder>): VenueOrder {
  return {
    venueId: 'street',
    venueOrderId: 'v-1',
    clientOrderId: 'oms-street',
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    price: parseAmount('100'),
    amount: parseAmount('1'),
    filled: parseAmount('1'),
    remaining: parseAmount('0'),
    averagePrice: parseAmount('100'),
    status: 'filled',
    feePaid: parseAmount('0.1'),
    feeAsset: 'USDT',
    createdAt: now,
    observedAt: now,
    ...over,
  };
}

function adapter(next: VenueOrder | (() => Promise<VenueOrder>)): TradeAdapter {
  return {
    venue: { id: 'street', displayName: 'Street', kind: 'external-cex', sequencedDepth: true },
    placeOrder: async () => (typeof next === 'function' ? next() : next),
    cancelOrder: async () => order({ status: 'canceled', filled: ZERO, remaining: parseAmount('1'), averagePrice: null }),
    fetchOrder: async () => (typeof next === 'function' ? next() : next),
    openOrders: async () => [],
  };
}

describe('venueOrderToExecution', () => {
  it('maps filled → filled with venue average and fee', () => {
    const ex = venueOrderToExecution(order({}), request());
    expect(ex.status).toBe('filled');
    expect(ex.filledAmount).toBe(parseAmount('1'));
    expect(ex.averagePrice).toBe(parseAmount('100'));
    expect(ex.feeAmount).toBe(parseAmount('0.1'));
    expect(ex.feeAsset).toBe('USDT');
    expect(ex.venueOrderId).toBe('v-1');
  });

  it('maps partially_filled and open → partial using filled from the order', () => {
    const partial = venueOrderToExecution(
      order({ status: 'partially_filled', filled: parseAmount('0.4'), remaining: parseAmount('0.6'), averagePrice: parseAmount('99') }),
      request(),
    );
    expect(partial.status).toBe('partial');
    expect(partial.filledAmount).toBe(parseAmount('0.4'));

    const open = venueOrderToExecution(
      order({ status: 'open', filled: parseAmount('0.2'), remaining: parseAmount('0.8'), averagePrice: parseAmount('100') }),
      request(),
    );
    expect(open.status).toBe('partial');
    expect(open.filledAmount).toBe(parseAmount('0.2'));
  });

  it('maps rejected, canceled, expired → rejected', () => {
    for (const status of ['rejected', 'canceled', 'expired'] as const) {
      const ex = venueOrderToExecution(
        order({ status, filled: ZERO, remaining: parseAmount('1'), averagePrice: null, feePaid: null, feeAsset: null }),
        request(),
      );
      expect(ex.status).toBe('rejected');
      expect(ex.filledAmount).toBe(ZERO);
      expect(ex.feeAmount).toBe(ZERO);
      expect(ex.averagePrice).toBeNull();
    }
  });

  it('does not report a cancel or expiry that already filled some size as a failed execution', () => {
    for (const status of ['canceled', 'expired'] as const) {
      const ex = venueOrderToExecution(
        order({
          status,
          filled: parseAmount('0.4'),
          remaining: parseAmount('0.6'),
          averagePrice: parseAmount('99'),
          feePaid: parseAmount('0.01'),
          feeAsset: 'USDT',
        }),
        request(),
      );
      expect(ex.status).toBe('partial');
      expect(ex.filledAmount).toBe(parseAmount('0.4'));
      expect(ex.averagePrice).toBe(parseAmount('99'));
    }

    const rejected = venueOrderToExecution(
      order({
        status: 'rejected',
        filled: parseAmount('0.4'),
        remaining: parseAmount('0.6'),
        averagePrice: parseAmount('99'),
      }),
      request(),
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.filledAmount).toBe(parseAmount('0.4'));
  });

  it('does not substitute request.limitPrice when averagePrice is null (rejected/canceled/open filled=0)', () => {
    const req = request();
    for (const status of ['rejected', 'canceled', 'open'] as const) {
      const ex = venueOrderToExecution(order({ status, filled: ZERO, remaining: parseAmount('1'), averagePrice: null }), req);
      expect(ex.averagePrice).toBeNull();
      expect(ex.averagePrice).not.toBe(req.limitPrice);
      expect(ex.averagePrice).not.toBe(ZERO);
    }
  });

  it('keeps unfilled open averagePrice null — not a successful partial at price 0', () => {
    const ex = venueOrderToExecution(order({ status: 'open', filled: ZERO, remaining: parseAmount('1'), averagePrice: null }), request());
    expect(ex.status).toBe('partial');
    expect(ex.filledAmount).toBe(ZERO);
    expect(ex.averagePrice).toBeNull();
  });

  it('throws on pending instead of fabricating an execution', () => {
    expect(() =>
      venueOrderToExecution(order({ status: 'pending', venueOrderId: null, filled: ZERO, averagePrice: null }), request()),
    ).toThrow(/pending/);
  });

  it('throws when a fill has null averagePrice — does not invent', () => {
    expect(() => venueOrderToExecution(order({ filled: parseAmount('1'), remaining: ZERO, averagePrice: null }), request())).toThrow(
      /averagePrice/,
    );
  });
});

describe('tradeAdapterSubmit', () => {
  it('places a limit at the submit limitPrice and returns the mapped execution', async () => {
    let placed: unknown;
    const submit = tradeAdapterSubmit({
      ...adapter(order({})),
      placeOrder: async (req) => {
        placed = req;
        return order({});
      },
    });
    const ex = await submit(request());
    expect(placed).toMatchObject({
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: parseAmount('1'),
      price: parseAmount('100'),
      clientOrderId: 'oms-street',
    });
    expect(ex.status).toBe('filled');
    expect(ex.venueId).toBe('street');
  });
});
