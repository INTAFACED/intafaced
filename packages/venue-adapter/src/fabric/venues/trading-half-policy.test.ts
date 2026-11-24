import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { VenueCredentialsMissingError } from '@intafaced/venue-contracts';
import { PUBLIC_MARKET_DATA_VENUE_IDS, createVenueTradeAdapter } from './factory.js';
import {
  describeTradingHalfPolicy,
  shouldRefuseTradeAdapterConstruction,
  tradeAdapterRegisteredForAllPublicVenues,
} from './trading-half-policy.js';
import * as fabric from '../index.js';
import type { HttpPort, HttpResponse } from '../transport.js';

function snapshotBody(url: string): unknown {
  if (url.includes('/api/v3/depth')) {
    return { lastUpdateId: 1, bids: [['30000.00', '2.00']], asks: [['30002.00', '1.00']] };
  }
  if (url.includes('/v5/market/orderbook')) {
    return {
      retCode: 0,
      retMsg: 'OK',
      result: { s: 'BTCUSDT', b: [['30000.00', '2.00']], a: [['30002.00', '1.00']], ts: 1, u: 1, seq: 9, cts: 1 },
    };
  }
  if (url.includes('/api/v5/market/books')) {
    return {
      code: '0',
      msg: '',
      data: [{ asks: [['30002.10', '1.5', '0', '1']], bids: [['30000.00', '2.0', '0', '1']], ts: '1', seqId: 1 }],
    };
  }
  return {};
}

class GetOnlyHttp implements HttpPort {
  async get(url: string): Promise<HttpResponse> {
    return { status: 200, body: snapshotBody(url), header: () => null };
  }
}

const ORDER = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: parseAmount('1'),
  price: parseAmount('100'),
  clientOrderId: 'abc',
};

const tradeOnly = (venueId: string) => ({
  venueId,
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'] as const,
  ...(venueId === 'okx-spot' ? { passphrase: 'p' } : {}),
});

describe('describeTradingHalfPolicy — venue.aggregation trading half contract', () => {
  it('states factory coverage without inventing venues or credentials', () => {
    const p = describeTradingHalfPolicy();
    expect(p.tradingVenueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    expect(p.tradingVenueIds).toEqual(['binance-spot', 'bybit-spot', 'okx-spot']);
    expect(p.tradeFactoryCoversAllPublicMarketDataVenues).toBe(true);
    expect(p.sameIdsAsPublicMarketData).toBe(true);
    expect(p.unknownVenueIdRefuses).toBe(true);
    expect(p.offNoneFalseRefuses).toBe(true);
    expect(p.inventsCredentials).toBe(false);
    expect(p.inventsVenueList).toBe(false);
    expect(p.inventsAdapterForUnknownId).toBe(false);
    expect(p.liveCredentialsOperatorIssued).toBe(true);
  });
});

describe('trading-half policy enforcement', () => {
  it('registers a trade adapter for every public market-data venue id', () => {
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueTradeAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id)!.venue.id).toBe(id);
    }
  });

  it('refuses unknown / off ids at construction', () => {
    for (const bad of ['', 'off', 'none', 'false', 'not-a-venue', 'ccxt', 'kraken-spot']) {
      expect(shouldRefuseTradeAdapterConstruction(bad)).toBe(true);
    }
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(shouldRefuseTradeAdapterConstruction(id)).toBe(false);
    }
  });

  it('place/cancel/fetch refuse without credentials — never silent success', async () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const trade = createVenueTradeAdapter(id);
      expect(trade).not.toBeNull();
      await expect(trade!.placeOrder(ORDER)).rejects.toThrow(VenueCredentialsMissingError);
      await expect(trade!.cancelOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
      await expect(trade!.fetchOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    }
  });

  it('place/cancel refuse not_ready when signed HTTP port is not wired', async () => {
    const http = new GetOnlyHttp();
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const trade = createVenueTradeAdapter(id, tradeOnly(id), { http, restBase: 'https://rest.test', clock: () => 1, snapshotLimit: 5 });
      expect(trade).not.toBeNull();
      await expect(trade!.placeOrder(ORDER)).rejects.toMatchObject({ reason: 'not_ready' });
      await expect(trade!.cancelOrder('BTC/USDT', 'abc')).rejects.toMatchObject({ reason: 'not_ready' });
    }
  });

  it('fetch refuses without credentials before any HTTP port check', async () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const trade = createVenueTradeAdapter(id, null, { http: new GetOnlyHttp(), restBase: 'https://rest.test' });
      expect(trade).not.toBeNull();
      await expect(trade!.fetchOrder('BTC/USDT', 'abc')).rejects.toThrow(VenueCredentialsMissingError);
    }
  });
});

describe('trading-half-policy public door — fabric export seal', () => {
  it('fabric/index exports the trading-half policy door itself', () => {
    expect(fabric.describeTradingHalfPolicy).toBe(describeTradingHalfPolicy);
    expect(fabric.shouldRefuseTradeAdapterConstruction).toBe(shouldRefuseTradeAdapterConstruction);
    expect(fabric.tradeAdapterRegisteredForAllPublicVenues).toBe(tradeAdapterRegisteredForAllPublicVenues);
    expect(fabric.tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
  });
});
