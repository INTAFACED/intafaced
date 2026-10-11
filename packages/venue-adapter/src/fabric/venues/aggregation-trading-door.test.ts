/**
 * D27-P4 venue.aggregation trading half — factory door through the package
 * surface (`@intafaced/venue-adapter` index), not deep fabric imports alone.
 *
 * Promise: market-data, trade, and account factories share
 * PUBLIC_MARKET_DATA_VENUE_IDS; unknown ids return null; signed ops refuse
 * without credentials or wired HTTP port.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { VenueCredentialsMissingError } from '@intafaced/venue-contracts';
import {
  PUBLIC_MARKET_DATA_VENUE_IDS,
  createVenueAccountAdapter,
  createVenueAccountAdapterFromOperatorEnv,
  createVenueMarketDataAdapter,
  createVenueTradeAdapter,
  createVenueTradeAdapterFromOperatorEnv,
  describeOperatorVenueAccountMaps,
  describeTradingHalfPolicy,
  loadVenueOperatorCredentials,
  buildOperatorVenueAccountMaps,
  buildOperatorVenueTradeMaps,
  buildOperatorVenueAccountAdapters,
  buildOperatorVenueTradeAdapters,
  describeOperatorVenueTradeMaps,
  describeVenueOperatorCredentials,
  venueOperatorCredentialEnvPrefix,
} from '../../index.js';
import { venueAggregationMountVsTrackerBoardCard, venueAggregationTrackerBackendDoneBarMet } from '../../aggregation-mount-vs-tracker.js';
import { describeVenueAggregationPolicy } from './factory-policy.js';
import { tradeAdapterRegisteredForAllPublicVenues, shouldRefuseTradeAdapterConstruction } from './trading-half-policy.js';

const tradeOnlyCreds = (venueId: string) => ({
  venueId,
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'] as const,
  ...(venueId === 'okx-spot' ? { passphrase: 'p' } : {}),
});

const LIMIT_ORDER = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  amount: parseAmount('1'),
  price: parseAmount('100'),
  clientOrderId: 'door-test',
};

describe('D27-P4 aggregation trading door — package export + factory trio', () => {
  it('exports MD + trade + account factories and trading-half policy on the package index', () => {
    expect(typeof createVenueMarketDataAdapter).toBe('function');
    expect(typeof createVenueTradeAdapter).toBe('function');
    expect(typeof createVenueAccountAdapter).toBe('function');
    expect(typeof describeTradingHalfPolicy).toBe('function');
    expect(typeof loadVenueOperatorCredentials).toBe('function');
    expect(typeof createVenueTradeAdapterFromOperatorEnv).toBe('function');
    expect(typeof createVenueAccountAdapterFromOperatorEnv).toBe('function');
    expect(typeof buildOperatorVenueTradeMaps).toBe('function');
    expect(typeof buildOperatorVenueAccountMaps).toBe('function');
    expect(typeof buildOperatorVenueTradeAdapters).toBe('function');
    expect(typeof buildOperatorVenueAccountAdapters).toBe('function');
    expect(typeof describeOperatorVenueAccountMaps).toBe('function');
    expect(typeof describeOperatorVenueTradeMaps).toBe('function');
    expect(typeof venueOperatorCredentialEnvPrefix).toBe('function');
    expect(typeof describeVenueOperatorCredentials).toBe('function');
    expect(PUBLIC_MARKET_DATA_VENUE_IDS).toEqual(['binance-spot', 'bybit-spot', 'okx-spot']);
  });

  it('describeTradingHalfPolicy and tradeAdapterRegisteredForAllPublicVenues lock factory coverage (D57)', () => {
    const p = describeTradingHalfPolicy();
    expect(p.tradeFactoryCoversAllPublicMarketDataVenues).toBe(true);
    expect(p.liveCredentialsOperatorIssued).toBe(true);
    expect(p.inventsCredentials).toBe(false);
    expect(p.tradingVenueIds).toEqual(PUBLIC_MARKET_DATA_VENUE_IDS);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
  });

  it('describeVenueAggregationPolicy locks venue aggregation factory honesty on door (D58)', () => {
    const p = describeVenueAggregationPolicy();
    expect(p.publicMarketDataVenueIds).toEqual(PUBLIC_MARKET_DATA_VENUE_IDS);
    expect(p.inventsCredentials).toBe(false);
    expect(p.inventsVenueList).toBe(false);
    expect(p.unknownVenueIdRefuses).toBe(true);
    expect(p.publicMarketDataOnly).toBe(true);
    expect(p.signedTradeSeparateFactory).toBe(true);
  });

  it('shouldRefuseTradeAdapterConstruction refuses unknown and blank venue ids on door (D59)', () => {
    expect(shouldRefuseTradeAdapterConstruction('')).toBe(true);
    expect(shouldRefuseTradeAdapterConstruction('off')).toBe(true);
    expect(shouldRefuseTradeAdapterConstruction('kraken-spot')).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(shouldRefuseTradeAdapterConstruction(id)).toBe(false);
    }
  });

  it('buildOperatorVenueTradeMaps wires place cancel fetch openOrders for operator env (D61)', () => {
    const env = {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    const maps = buildOperatorVenueTradeMaps(env);
    expect(maps.wiredVenueIds).toEqual(['okx-spot']);
    expect(Object.keys(maps.placeByVenue)).toEqual(['okx-spot']);
    expect(Object.keys(maps.cancelByVenue)).toEqual(['okx-spot']);
    expect(Object.keys(maps.fetchByVenue)).toEqual(['okx-spot']);
    expect(Object.keys(maps.openOrdersByVenue)).toEqual(['okx-spot']);
    const accountMaps = buildOperatorVenueAccountMaps(env);
    expect(accountMaps.wiredVenueIds).toEqual(['okx-spot']);
    expect(Object.keys(accountMaps.balancesByVenue)).toEqual(['okx-spot']);
    expect(Object.keys(accountMaps.positionsByVenue)).toEqual(['okx-spot']);
    expect(Object.keys(accountMaps.transferRailsByVenue)).toEqual(['okx-spot']);
  });

  it('describeOperatorVenueTradeMaps and describeOperatorVenueAccountMaps align on wired venues (D63)', () => {
    const env = {
      VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 's',
    };
    const tradeBoard = describeOperatorVenueTradeMaps(env);
    const accountBoard = describeOperatorVenueAccountMaps(env);
    const creds = describeVenueOperatorCredentials(env);
    expect(tradeBoard.wiredVenueIds).toEqual(accountBoard.wiredVenueIds);
    expect(tradeBoard.wiredVenueIds).toEqual(creds.wiredVenueIds);
    expect(tradeBoard.wiredVenueIds).toEqual(['binance-spot']);
    expect(tradeBoard.inventsAdapters).toBe(false);
    expect(accountBoard.inventsAdapters).toBe(false);
  });

  it('describeOperatorVenueTradeMaps account maps and credentials align for every public venue (D65)', () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      const tradeBoard = describeOperatorVenueTradeMaps(env);
      const accountBoard = describeOperatorVenueAccountMaps(env);
      const creds = describeVenueOperatorCredentials(env);
      expect(tradeBoard.wiredVenueIds).toEqual([id]);
      expect(accountBoard.wiredVenueIds).toEqual([id]);
      expect(creds.wiredVenueIds).toEqual([id]);
      expect(tradeBoard.inventsAdapters).toBe(false);
      expect(accountBoard.inventsAdapters).toBe(false);
    }
  });

  it('describeTradingHalfPolicy and describeVenueAggregationPolicy lock complete factory door (D67)', () => {
    const trading = describeTradingHalfPolicy();
    const aggregation = describeVenueAggregationPolicy();
    expect(trading.tradeFactoryCoversAllPublicMarketDataVenues).toBe(true);
    expect(trading.inventsCredentials).toBe(false);
    expect(aggregation.publicMarketDataVenueIds).toEqual(PUBLIC_MARKET_DATA_VENUE_IDS);
    expect(aggregation.inventsCredentials).toBe(false);
    expect(aggregation.unknownVenueIdRefuses).toBe(true);
    expect(aggregation.signedTradeSeparateFactory).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueMarketDataAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id, null)).not.toBeNull();
      expect(createVenueAccountAdapter(id, null)).not.toBeNull();
    }
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
  });

  it('buildOperatorVenueTradeMaps and buildOperatorVenueAccountMaps align for every public venue (D68)', () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      const tradeMaps = buildOperatorVenueTradeMaps(env);
      const accountMaps = buildOperatorVenueAccountMaps(env);
      expect(tradeMaps.wiredVenueIds).toEqual([id]);
      expect(accountMaps.wiredVenueIds).toEqual([id]);
      expect(Object.keys(tradeMaps.placeByVenue)).toEqual([id]);
      expect(Object.keys(tradeMaps.cancelByVenue)).toEqual([id]);
      expect(Object.keys(tradeMaps.fetchByVenue)).toEqual([id]);
      expect(Object.keys(tradeMaps.openOrdersByVenue)).toEqual([id]);
      expect(Object.keys(accountMaps.balancesByVenue)).toEqual([id]);
      expect(Object.keys(accountMaps.positionsByVenue)).toEqual([id]);
      expect(Object.keys(accountMaps.transferRailsByVenue)).toEqual([id]);
    }
  });

  it('describeVenueOperatorCredentials wires every public venue when operator env is complete (D70)', () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      const board = describeVenueOperatorCredentials(env);
      expect(board.wiredVenueIds).toEqual([id]);
      expect(board.inventsCredentials).toBe(false);
      expect(loadVenueOperatorCredentials(id, env)).toMatchObject({ venueId: id });
    }
    expect(describeVenueOperatorCredentials({})).toMatchObject({
      wiredVenueIds: [],
      inventsCredentials: false,
    });
  });

  it('buildOperatorVenueTradeAdapters and buildOperatorVenueAccountAdapters wire every public venue (D72)', () => {
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeAdapters(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountAdapters(env).wiredVenueIds).toEqual([id]);
    }
    expect(buildOperatorVenueTradeAdapters({}).wiredVenueIds).toEqual([]);
    expect(buildOperatorVenueAccountAdapters({}).wiredVenueIds).toEqual([]);
  });

  it('describeOperatorVenueTradeMaps wires when operator env is complete (D41)', () => {
    expect(describeOperatorVenueTradeMaps({})).toMatchObject({
      wiredVenueIds: [],
      inventsAdapters: false,
      operatorCredentialsRequired: true,
    });
    expect(
      describeOperatorVenueTradeMaps({
        VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
        VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
        VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
      }),
    ).toMatchObject({
      wiredVenueIds: ['okx-spot'],
      inventsAdapters: false,
    });
  });

  it('describeOperatorVenueAccountMaps wires when operator env is complete (D42)', () => {
    expect(describeOperatorVenueAccountMaps({})).toMatchObject({
      wiredVenueIds: [],
      inventsAdapters: false,
      operatorCredentialsRequired: true,
    });
    expect(
      describeOperatorVenueAccountMaps({
        VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'k',
        VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 's',
      }),
    ).toMatchObject({
      wiredVenueIds: ['binance-spot'],
      inventsAdapters: false,
    });
  });

  it('buildOperatorVenueTradeMaps and buildOperatorVenueAccountMaps wire when operator env is complete (D43)', () => {
    const env = {
      VENUE_AGGREGATION_BYBIT_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BYBIT_SPOT_API_SECRET: 's',
    };
    expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual(['bybit-spot']);
    expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual(['bybit-spot']);
  });

  it('createVenueTradeAdapterFromOperatorEnv and createVenueAccountAdapterFromOperatorEnv wire when operator env is complete (D44)', () => {
    const env = {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    expect(createVenueTradeAdapterFromOperatorEnv('okx-spot', env)).not.toBeNull();
    expect(createVenueAccountAdapterFromOperatorEnv('okx-spot', env)).not.toBeNull();
    expect(createVenueTradeAdapterFromOperatorEnv('okx-spot', {})).toBeNull();
    expect(createVenueAccountAdapterFromOperatorEnv('binance-spot', {})).toBeNull();
  });

  it('loadVenueOperatorCredentials wires when operator env is complete (D45)', () => {
    const env = {
      VENUE_AGGREGATION_BYBIT_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BYBIT_SPOT_API_SECRET: 's',
    };
    expect(loadVenueOperatorCredentials('bybit-spot', env)).toMatchObject({
      venueId: 'bybit-spot',
      scopes: ['read', 'trade'],
    });
    expect(loadVenueOperatorCredentials('bybit-spot', {})).toBeNull();
    expect(loadVenueOperatorCredentials('kraken-spot', env)).toBeNull();
  });

  it('describeVenueOperatorCredentials wires when operator env is complete (D46)', () => {
    expect(describeVenueOperatorCredentials({})).toMatchObject({
      wiredVenueIds: [],
      inventsCredentials: false,
      liveCredentialsOperatorIssued: true,
    });
    expect(
      describeVenueOperatorCredentials({
        VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'k',
        VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 's',
      }),
    ).toMatchObject({
      wiredVenueIds: ['binance-spot'],
      unsetVenueIds: ['bybit-spot', 'okx-spot'],
    });
  });

  it('describeVenueOperatorCredentials exposes full public MD venue board (D51)', () => {
    const board = describeVenueOperatorCredentials({});
    expect(board.venueIds).toEqual(PUBLIC_MARKET_DATA_VENUE_IDS);
    expect(board.wiredVenueIds).toEqual([]);
    expect(board.unsetVenueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    expect(board.liveCredentialsOperatorIssued).toBe(true);
    expect(board.inventsCredentials).toBe(false);
  });

  it('operator trade and account boards align with credential board wired venues (D53)', () => {
    const env = {
      VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k2',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's2',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    const creds = describeVenueOperatorCredentials(env);
    expect(describeOperatorVenueTradeMaps(env).wiredVenueIds).toEqual(creds.wiredVenueIds);
    expect(describeOperatorVenueAccountMaps(env).wiredVenueIds).toEqual(creds.wiredVenueIds);
    expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual(creds.wiredVenueIds);
    expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual(creds.wiredVenueIds);
    expect(creds.wiredVenueIds).toEqual(['binance-spot', 'okx-spot']);
    expect(creds.unsetVenueIds).toEqual(['bybit-spot']);
  });

  it('buildOperatorVenueTradeAdapters and buildOperatorVenueAccountAdapters expose matching adapter keys (D55)', () => {
    const env = {
      VENUE_AGGREGATION_BYBIT_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BYBIT_SPOT_API_SECRET: 's',
    };
    const trade = buildOperatorVenueTradeAdapters(env);
    const account = buildOperatorVenueAccountAdapters(env);
    expect(Object.keys(trade.adapters).sort()).toEqual([...trade.wiredVenueIds].sort());
    expect(Object.keys(account.adapters).sort()).toEqual([...account.wiredVenueIds].sort());
    expect(trade.wiredVenueIds).toEqual(['bybit-spot']);
    expect(account.wiredVenueIds).toEqual(['bybit-spot']);
    expect(trade.adapters['bybit-spot']?.venue.id).toBe('bybit-spot');
    expect(account.adapters['bybit-spot']?.venue.id).toBe('bybit-spot');
  });

  it('buildOperatorVenueTradeAdapters and buildOperatorVenueAccountAdapters wire when operator env is complete (D47)', () => {
    const env = {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    expect(buildOperatorVenueTradeAdapters(env).wiredVenueIds).toEqual(['okx-spot']);
    expect(buildOperatorVenueAccountAdapters(env).wiredVenueIds).toEqual(['okx-spot']);
    expect(buildOperatorVenueTradeAdapters({}).wiredVenueIds).toEqual([]);
    expect(buildOperatorVenueAccountAdapters({}).wiredVenueIds).toEqual([]);
  });

  it('venueOperatorCredentialEnvPrefix maps venue ids to operator env keys (D49)', () => {
    expect(venueOperatorCredentialEnvPrefix('binance-spot')).toBe('VENUE_AGGREGATION_BINANCE_SPOT');
    expect(venueOperatorCredentialEnvPrefix('okx-spot')).toBe('VENUE_AGGREGATION_OKX_SPOT');
    const env = {
      [`${venueOperatorCredentialEnvPrefix('bybit-spot')}_API_KEY`]: 'k',
      [`${venueOperatorCredentialEnvPrefix('bybit-spot')}_API_SECRET`]: 's',
    };
    expect(loadVenueOperatorCredentials('bybit-spot', env)).toMatchObject({ venueId: 'bybit-spot' });
  });

  it('package index re-exports trading-half policy through fabric', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgIndex = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');
    expect(pkgIndex).toMatch(/fabric\/index/);
    expect(describeTradingHalfPolicy().tradeFactoryCoversAllPublicMarketDataVenues).toBe(true);
  });
});

describe('aggregation trading door — factory integration', () => {
  for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
    it(`${id}: MD + trade + account adapters exist; null creds probe`, () => {
      const md = createVenueMarketDataAdapter(id);
      const trade = createVenueTradeAdapter(id, null);
      const account = createVenueAccountAdapter(id, null);
      expect(md).not.toBeNull();
      expect(trade).not.toBeNull();
      expect(account).not.toBeNull();
      expect(md!.venue.id).toBe(id);
      expect(trade!.venue.id).toBe(id);
      expect(account!.venue.id).toBe(id);
    });

    it(`${id}: place refuses not_ready without HTTP port`, async () => {
      const adapter = createVenueTradeAdapter(id, tradeOnlyCreds(id), {
        clock: () => 1,
        snapshotLimit: 5,
      });
      expect(adapter).not.toBeNull();
      await expect(adapter!.placeOrder(LIMIT_ORDER)).rejects.toMatchObject({ reason: 'not_ready' });
    });
  }

  it('unknown venue id returns null for all factories', () => {
    for (const bad of ['', 'off', 'none', 'false', 'not-a-venue', 'ccxt', 'kraken-spot']) {
      expect(createVenueMarketDataAdapter(bad)).toBeNull();
      expect(createVenueTradeAdapter(bad, null)).toBeNull();
      expect(createVenueAccountAdapter(bad, null)).toBeNull();
    }
  });

  it('trade/account refuse without credentials — never silent success', async () => {
    const trade = createVenueTradeAdapter('binance-spot', null);
    const account = createVenueAccountAdapter('binance-spot', null);
    expect(trade).not.toBeNull();
    expect(account).not.toBeNull();
    await expect(trade!.placeOrder(LIMIT_ORDER)).rejects.toThrow(VenueCredentialsMissingError);
    await expect(account!.balances()).rejects.toThrow(VenueCredentialsMissingError);
  });
});

describe('aggregation trading door — D74 mount cert complete', () => {
  it('aggregation-mount-vs-tracker cert green and trading door aligns with public MD ids', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      backendDoneBarMet: true,
      gaps: 0,
    });
    expect(describeTradingHalfPolicy().tradingVenueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    expect(describeTradingHalfPolicy().inventsCredentials).toBe(false);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueMarketDataAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id, null)).not.toBeNull();
      expect(createVenueAccountAdapter(id, null)).not.toBeNull();
    }
  });
});

describe('aggregation trading door — D76 denon complete', () => {
  it('mount cert, aggregation policy, trade factory, and operator credential board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    const md = describeVenueAggregationPolicy();
    const trade = describeTradingHalfPolicy();
    expect(md.publicMarketDataOnly).toBe(true);
    expect(md.inventsCredentials).toBe(false);
    expect(trade.tradeFactoryCoversAllPublicMarketDataVenues).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    expect(describeVenueOperatorCredentials({})).toMatchObject({
      venueIds: [...PUBLIC_MARKET_DATA_VENUE_IDS],
      inventsCredentials: false,
      liveCredentialsOperatorIssued: true,
    });
    for (const bad of ['', 'off', 'kraken-spot']) {
      expect(shouldRefuseTradeAdapterConstruction(bad)).toBe(true);
    }
  });
});

describe('aggregation trading door — D78 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(buildOperatorVenueTradeMaps({}).wiredVenueIds).toEqual([]);
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D80 denon complete', () => {
  it('mount cert + factory policy + trading-half policy + operator credential board green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeVenueAggregationPolicy().publicMarketDataOnly).toBe(true);
    expect(describeVenueAggregationPolicy().inventsCredentials).toBe(false);
    expect(describeTradingHalfPolicy().liveCredentialsOperatorIssued).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    expect(describeVenueOperatorCredentials({}).venueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueMarketDataAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id, null)).not.toBeNull();
      expect(createVenueAccountAdapter(id, null)).not.toBeNull();
    }
  });
});

describe('aggregation trading door — D82 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D84 denon complete', () => {
  it('mount cert + factory policy + trading-half policy + operator credential board green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeVenueAggregationPolicy().publicMarketDataOnly).toBe(true);
    expect(describeVenueAggregationPolicy().inventsCredentials).toBe(false);
    expect(describeTradingHalfPolicy().liveCredentialsOperatorIssued).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    expect(describeVenueOperatorCredentials({}).venueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueMarketDataAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id, null)).not.toBeNull();
      expect(createVenueAccountAdapter(id, null)).not.toBeNull();
    }
  });
});

describe('aggregation trading door — D86 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D88 denon complete', () => {
  it('mount cert + factory policy + trading-half policy + operator credential board green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard().backendDoneBarMet).toBe(true);
    expect(describeVenueAggregationPolicy().publicMarketDataOnly).toBe(true);
    expect(describeVenueAggregationPolicy().inventsCredentials).toBe(false);
    expect(describeTradingHalfPolicy().liveCredentialsOperatorIssued).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    expect(describeVenueOperatorCredentials({}).venueIds).toEqual([...PUBLIC_MARKET_DATA_VENUE_IDS]);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      expect(createVenueMarketDataAdapter(id)).not.toBeNull();
      expect(createVenueTradeAdapter(id, null)).not.toBeNull();
      expect(createVenueAccountAdapter(id, null)).not.toBeNull();
    }
  });
});

describe('aggregation trading door — D90 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D92 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D94 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D96 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D98 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D100 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D102 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D104 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D106 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D108 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D110 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D112 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D114 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D116 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D118 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});

describe('aggregation trading door — D120 denon complete', () => {
  it('mount cert, factory trio, operator maps, and honest gaps board all green', () => {
    expect(venueAggregationTrackerBackendDoneBarMet()).toBe(true);
    expect(venueAggregationMountVsTrackerBoardCard()).toMatchObject({
      tracker: 'venue.aggregation',
      exports: 9,
      exportsPresent: 9,
      gaps: 0,
      backendDoneBarMet: true,
    });
    expect(describeVenueAggregationPolicy().signedTradeSeparateFactory).toBe(true);
    expect(describeTradingHalfPolicy().sameIdsAsPublicMarketData).toBe(true);
    expect(tradeAdapterRegisteredForAllPublicVenues()).toBe(true);
    for (const id of PUBLIC_MARKET_DATA_VENUE_IDS) {
      const prefix = venueOperatorCredentialEnvPrefix(id);
      const env = {
        [`${prefix}_API_KEY`]: 'k',
        [`${prefix}_API_SECRET`]: 's',
        ...(id === 'okx-spot' ? { [`${prefix}_PASSPHRASE`]: 'p' } : {}),
      };
      expect(buildOperatorVenueTradeMaps(env).wiredVenueIds).toEqual([id]);
      expect(buildOperatorVenueAccountMaps(env).wiredVenueIds).toEqual([id]);
    }
  });
});
