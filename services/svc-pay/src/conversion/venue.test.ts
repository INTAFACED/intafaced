import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { createVenueTradeAdapter } from '@intafaced/venue-adapter';
import { VenueCredentialsMissingError, VenueUnavailableError, type TradeAdapter } from '@intafaced/venue-contracts';
import { assertConversionBoot, conversionVenueFromTrade, createMemoryConversionVenue, openConversionVenue } from './venue.js';

const sandboxKeys = {
  PAY_CONVERSION_MODE: 'sandbox',
  PAY_CONVERSION_VENUE_ID: 'binance-spot',
  PAY_CONVERSION_API_KEY: 'test-key',
  PAY_CONVERSION_API_SECRET: 'test-secret',
  PAY_CONVERSION_REST_BASE: 'https://testnet.binance.vision',
};

describe('conversion boot', () => {
  it('refuses live mode and a REST host that is not a known testnet', () => {
    expect(() => assertConversionBoot({ PAY_CONVERSION_MODE: 'live' })).toThrow(/pay.conversion_live_refused/);
    expect(() => assertConversionBoot({ ...sandboxKeys, PAY_CONVERSION_REST_BASE: 'https://api.binance.com' })).toThrow(
      /pay.conversion_live_refused/,
    );
    expect(() =>
      assertConversionBoot({
        ...sandboxKeys,
        PAY_CONVERSION_VENUE_ID: 'okx-spot',
        PAY_CONVERSION_REST_BASE: 'https://www.okx.com',
        PAY_CONVERSION_API_PASSPHRASE: 'phrase',
      }),
    ).toThrow(/pay.conversion_live_refused/);
  });

  it('refuses keys when mode is off, and boots when sandbox names a testnet host', () => {
    expect(() => assertConversionBoot({ ...sandboxKeys, PAY_CONVERSION_MODE: 'off' })).toThrow(/pay.conversion_live_refused/);
    expect(() => assertConversionBoot({})).not.toThrow();
    expect(() => assertConversionBoot({ PAY_CONVERSION_MODE: 'sandbox' })).not.toThrow();
    expect(() => assertConversionBoot(sandboxKeys)).not.toThrow();
    expect(() =>
      assertConversionBoot({
        ...sandboxKeys,
        PAY_CONVERSION_REST_BASE: 'https://api-testnet.bybit.com',
        PAY_CONVERSION_VENUE_ID: 'bybit-spot',
      }),
    ).not.toThrow();
  });

  it('refuses quote and order when no testnet key is configured', async () => {
    const venue = openConversionVenue({ PAY_CONVERSION_MODE: 'sandbox' });
    const now = new Date('2026-10-16T00:00:00.000Z');
    await expect(venue.quote({ symbol: 'USD/USDT', fromAmount: parseAmount('1'), now })).rejects.toMatchObject({
      code: 'pay.conversion_credentials_unconfigured',
    });
    await expect(
      venue.placeOrder({ symbol: 'USD/USDT', side: 'sell', type: 'market', amount: parseAmount('1'), clientOrderId: 'none' }),
    ).rejects.toMatchObject({ code: 'pay.conversion_credentials_unconfigured' });
  });

  it('refuses a quote when the TTL is not configured, before any book is read', async () => {
    const venue = openConversionVenue(sandboxKeys);
    await expect(
      venue.quote({ symbol: 'USD/USDT', fromAmount: parseAmount('1'), now: new Date('2026-10-16T00:00:00.000Z') }),
    ).rejects.toMatchObject({ code: 'pay.conversion_quote_ttl_unconfigured' });
  });

  it('a trade adapter with no credentials refuses to place', async () => {
    const trade = createVenueTradeAdapter('binance-spot', null);
    expect(trade).not.toBeNull();
    await expect(
      trade!.placeOrder({ symbol: 'USD/USDT', side: 'sell', type: 'market', amount: parseAmount('1'), clientOrderId: 'none' }),
    ).rejects.toBeInstanceOf(VenueCredentialsMissingError);
  });
});

describe('venue order lookup', () => {
  it('treats only a confirmed missing order as absence', async () => {
    const fetchOrder = async () => {
      throw new VenueUnavailableError('binance-spot', 'unreachable', 'fetchOrder Order does not exist.');
    };
    const trade = {
      venue: { id: 'binance-spot' },
      fetchOrder,
      placeOrder: async () => undefined,
      cancelOrder: async () => undefined,
    } as unknown as TradeAdapter;
    const venue = conversionVenueFromTrade(trade, async () => {
      throw new Error('quote not used');
    });
    await expect(venue.fetchOrder('USD/USDT', 'settlement:1')).resolves.toBeNull();

    const unknown = conversionVenueFromTrade(
      {
        ...trade,
        fetchOrder: async () => {
          throw new VenueUnavailableError('binance-spot', 'unreachable', 'fetchOrder timeout');
        },
      } as TradeAdapter,
      async () => {
        throw new Error('quote not used');
      },
    );
    await expect(unknown.fetchOrder('USD/USDT', 'settlement:1')).rejects.toMatchObject({ code: 'pay.conversion_venue_unknown' });
  });

  it('treats a Bybit empty realtime list as a miss and still fails closed on a timeout', async () => {
    const quote = async () => {
      throw new Error('quote not used');
    };
    const empty = conversionVenueFromTrade(
      {
        venue: { id: 'bybit-spot' },
        fetchOrder: async () => {
          throw new VenueUnavailableError('bybit-spot', 'unreachable', 'fetchOrder: realtime list is empty');
        },
        placeOrder: async () => undefined,
        cancelOrder: async () => undefined,
      } as unknown as TradeAdapter,
      quote,
    );
    await expect(empty.fetchOrder('USD/USDT', 'id')).resolves.toBeNull();
    const timeout = conversionVenueFromTrade(
      {
        venue: { id: 'bybit-spot' },
        fetchOrder: async () => {
          throw new VenueUnavailableError('bybit-spot', 'unreachable', 'fetchOrder timeout');
        },
        placeOrder: async () => undefined,
        cancelOrder: async () => undefined,
      } as unknown as TradeAdapter,
      quote,
    );
    await expect(timeout.fetchOrder('USD/USDT', 'id')).rejects.toMatchObject({ code: 'pay.conversion_venue_unknown' });
  });
});

describe('memory conversion venue', () => {
  const request = {
    symbol: 'USD/USDT',
    side: 'sell' as const,
    type: 'limit' as const,
    timeInForce: 'IOC' as const,
    amount: parseAmount('1'),
    price: parseAmount('1'),
    clientOrderId: 'same',
  };

  function venue(fill?: Parameters<typeof createMemoryConversionVenue>[0]['fill']) {
    return createMemoryConversionVenue({
      bid: parseAmount('1'),
      ask: parseAmount('1.01'),
      expiresAt: (now) => new Date(now.getTime() + 60_000),
      fill,
    });
  }

  it('accepts a reused client order id once the first order has filled', async () => {
    const book = venue((order) => ({ status: 'filled', filled: order.amount, averagePrice: parseAmount('1'), feePaid: 0n }));
    await book.placeOrder(request);
    await book.placeOrder(request);
    expect(book.placeCount()).toBe(2);
    expect(book.orders.size).toBe(1);
    expect(book.orders.get('same')?.venueOrderId).toBe('mem-2');
  });

  it('does not open a second order while the first client id is still open', async () => {
    const book = venue(() => ({ status: 'open', filled: 0n, averagePrice: null, feePaid: 0n }));
    const first = await book.placeOrder(request);
    const second = await book.placeOrder(request);
    expect(second.venueOrderId).toBe(first.venueOrderId);
    expect(book.orders.size).toBe(1);
  });

  it('hides a timed-out place behind a lagging miss, then shows it only in history when it is closed', async () => {
    const book = venue((order) => ({ status: 'filled', filled: order.amount, averagePrice: parseAmount('1'), feePaid: 0n }));
    book.armLag(2);
    await expect(book.placeOrder(request)).rejects.toThrow(/venue timeout/);
    expect(book.placeCount()).toBe(1);
    await expect(book.fetchOrder(request.symbol, request.clientOrderId)).resolves.toBeNull();
    await expect(book.fetchClosedOrder(request.symbol, request.clientOrderId)).resolves.toBeNull();
    const closed = await book.fetchClosedOrder(request.symbol, request.clientOrderId);
    expect(closed?.status).toBe('filled');
    await expect(book.fetchOrder(request.symbol, request.clientOrderId)).resolves.toBeNull();
  });

  it('fills a sell at the bid and a buy at the ask, never the mid', async () => {
    const book = venue();
    const sold = await book.placeOrder({ ...request, type: 'market', price: undefined, clientOrderId: 'sell' });
    const bought = await book.placeOrder({
      ...request,
      side: 'buy',
      type: 'market',
      price: undefined,
      clientOrderId: 'buy',
    });
    expect(sold.averagePrice).toBe(parseAmount('1'));
    expect(bought.averagePrice).toBe(parseAmount('1.01'));
  });

  it('keeps an expired partial only on the closed-order query and charges commission', async () => {
    const book = venue(() => ({ status: 'expired', filled: parseAmount('0.4'), averagePrice: parseAmount('1'), feePaid: undefined }));
    const placed = await book.placeOrder(request);
    expect(placed.feePaid).not.toBeNull();
    expect(placed.feePaid! > 0n).toBe(true);
    await expect(book.fetchOrder(request.symbol, request.clientOrderId)).resolves.toBeNull();
    expect((await book.fetchClosedOrder(request.symbol, request.clientOrderId))?.filled).toBe(parseAmount('0.4'));
  });

  it('rejects a client order id longer than 36 characters', async () => {
    const book = venue();
    await expect(book.placeOrder({ ...request, clientOrderId: 'x'.repeat(37) })).rejects.toThrow(/clientOrderId/);
  });
});
