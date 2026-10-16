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

  it('a repeated place for the same client id does not create a second order', async () => {
    const venue = createMemoryConversionVenue({
      rateScaled: parseAmount('1'),
      expiresAt: (now) => new Date(now.getTime() + 60_000),
      fill: (request) => ({ status: 'filled', filled: request.amount, averagePrice: parseAmount('1') }),
    });
    const request = { symbol: 'USD/USDT', side: 'sell' as const, type: 'market' as const, amount: parseAmount('1'), clientOrderId: 'same' };
    await venue.placeOrder(request);
    await venue.placeOrder(request);
    expect(venue.placeCount()).toBe(2);
    expect(venue.orders.size).toBe(1);
  });
});
