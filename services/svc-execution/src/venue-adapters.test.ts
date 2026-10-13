import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseAmount, ZERO } from '@intafaced/ledger-client';
import { createVenueTradeAdapter } from '@intafaced/venue-adapter';
import {
  assertTradeOnly,
  VenueCredentialScopeError,
  VenueCredentialsMissingError,
  type TradeAdapter,
  type VenueCredentials,
  type VenueOrder,
} from '@intafaced/venue-contracts';
import {
  buildExecutionVenueTradeMaps,
  buildExecutionVenueTradeMapsWithOperatorSupplement,
  describeExecutionVenueCredentialSources,
  ExecutionVenueCredentialsUnsetError,
  ExecutionVenueUnknownError,
  executionVenueCredentialEnvPrefix,
  loadExecutionVenueCredentials,
  parseExecutionVenueIds,
  wireExecutionVenueTradeAdapter,
} from './venue-adapters.js';

const now = new Date('2026-08-17T12:00:00.000Z');

function order(over: Partial<VenueOrder> = {}): VenueOrder {
  return {
    venueId: 'binance-spot',
    venueOrderId: 'v-1',
    clientOrderId: 'oms-street',
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    price: parseAmount('100'),
    amount: parseAmount('1'),
    filled: parseAmount('1'),
    remaining: ZERO,
    averagePrice: parseAmount('100'),
    status: 'filled',
    feePaid: ZERO,
    feeAsset: 'USDT',
    createdAt: now,
    observedAt: now,
    ...over,
  };
}

function fakeTradeAdapter(id = 'binance-spot'): TradeAdapter {
  return {
    venue: { id, displayName: id, kind: 'external-cex', sequencedDepth: true },
    placeOrder: async () => order({ venueId: id }),
    cancelOrder: async () => order({ venueId: id, status: 'canceled', filled: ZERO, remaining: parseAmount('1') }),
    fetchOrder: async () => order({ venueId: id }),
    openOrders: async () => [order({ venueId: id, status: 'open', filled: ZERO, remaining: parseAmount('1') })],
  };
}

const tradeOnly = (venueId: string): VenueCredentials => ({
  venueId,
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'],
});

const knownBinanceSpot = ((id: string) => (id === 'binance-spot' ? fakeTradeAdapter(id) : null)) as typeof createVenueTradeAdapter;

const BINANCE_SPOT_CREDENTIAL_ENV_KEYS = [
  'EXECUTION_VENUE_BINANCE_SPOT_API_KEY',
  'EXECUTION_VENUE_BINANCE_SPOT_API_SECRET',
  'EXECUTION_VENUE_BINANCE_SPOT_PASSPHRASE',
  'VENUE_AGGREGATION_BINANCE_SPOT_API_KEY',
  'VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET',
  'VENUE_AGGREGATION_BINANCE_SPOT_PASSPHRASE',
] as const;

function withClearedBinanceSpotProcessEnv(run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of BINANCE_SPOT_CREDENTIAL_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('parseExecutionVenueIds', () => {
  it('splits comma list, normalizes, and treats off tokens as empty', () => {
    expect(parseExecutionVenueIds('binance-spot, bybit-spot ,okx-spot')).toEqual(['binance-spot', 'bybit-spot', 'okx-spot']);
    expect(parseExecutionVenueIds('')).toEqual([]);
    expect(parseExecutionVenueIds('off')).toEqual([]);
    expect(parseExecutionVenueIds('none')).toEqual([]);
    expect(parseExecutionVenueIds('false')).toEqual([]);
  });
});

describe('loadExecutionVenueCredentials', () => {
  const prefix = executionVenueCredentialEnvPrefix('binance-spot');

  beforeEach(() => {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_API_SECRET`];
    delete process.env[`${prefix}_PASSPHRASE`];
  });

  afterEach(() => {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_API_SECRET`];
    delete process.env[`${prefix}_PASSPHRASE`];
  });

  it('returns null when key or secret blank — refuse-closed, no invent', () => {
    expect(loadExecutionVenueCredentials('binance-spot')).toBeNull();
    process.env[`${prefix}_API_KEY`] = 'k';
    expect(loadExecutionVenueCredentials('binance-spot')).toBeNull();
  });

  it('loads trade-only credentials from per-venue env', () => {
    process.env[`${prefix}_API_KEY`] = 'key-1';
    process.env[`${prefix}_API_SECRET`] = 'secret-1';
    const creds = loadExecutionVenueCredentials('binance-spot');
    expect(creds?.apiKey).toBe('key-1');
    expect(creds?.scopes).toEqual(['read', 'trade']);
  });

  it('refuses withdrawal-capable scopes at load', () => {
    expect(() =>
      buildExecutionVenueTradeMaps(['bybit-spot'], {
        credentialsFor: () => ({ venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['trade', 'withdraw'] }),
        createAdapter: ((id, creds) => {
          if (creds) assertTradeOnly(creds);
          return fakeTradeAdapter(id);
        }) as typeof createVenueTradeAdapter,
      }),
    ).toThrow(VenueCredentialScopeError);
  });
});

describe('buildExecutionVenueTradeMaps', () => {
  it('wires known venues and skips unknown ids', () => {
    const maps = buildExecutionVenueTradeMaps(['binance-spot', 'kraken-spot'], {
      credentialsFor: () => tradeOnly('binance-spot'),
      createAdapter: ((id) => (id === 'binance-spot' ? fakeTradeAdapter(id) : null)) as typeof createVenueTradeAdapter,
    });
    expect(maps.wiredVenueIds).toEqual(['binance-spot']);
    expect(maps.submitByVenue['kraken-spot']).toBeUndefined();
  });

  it('submit/cancel/fetch/openOrders forward to injected fake adapter', async () => {
    const maps = buildExecutionVenueTradeMaps(['binance-spot'], {
      credentialsFor: () => tradeOnly('binance-spot'),
      createAdapter: ((id) => fakeTradeAdapter(id)) as typeof createVenueTradeAdapter,
    });
    const submit = await maps.submitByVenue['binance-spot']!({
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: parseAmount('1'),
      limitPrice: parseAmount('100'),
      clientOrderId: 'c1',
    });
    expect(submit.status).toBe('filled');

    const canceled = await maps.cancelByVenue['binance-spot']!('BTC/USDT', 'c1');
    expect(canceled.status).toBe('canceled');

    const fetched = await maps.fetchByVenue['binance-spot']!('BTC/USDT', 'c1');
    expect(fetched.status).toBe('filled');

    const opens = await maps.openOrdersByVenue['binance-spot']!('BTC/USDT', 'buy', 'limit');
    expect(opens).toHaveLength(1);
    expect(opens[0]!.status).toBe('open');
  });

  it('missing credentials skip the venue at map build — never invent a wired door', () => {
    const maps = buildExecutionVenueTradeMaps(['binance-spot'], {
      credentialsFor: () => null,
      createAdapter: ((id, creds) => createVenueTradeAdapter(id, creds)) as typeof createVenueTradeAdapter,
    });
    expect(maps.wiredVenueIds).toEqual([]);
    expect(maps.submitByVenue['binance-spot']).toBeUndefined();
  });

  it('loads credentials from options.env when credentialsFor is absent', () => {
    withClearedBinanceSpotProcessEnv(() => {
      const fromSuppliedEnv = buildExecutionVenueTradeMaps(['binance-spot'], {
        env: {
          EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'supplied-fake-key',
          EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'supplied-fake-secret',
        },
        createAdapter: knownBinanceSpot,
      });
      expect(fromSuppliedEnv.wiredVenueIds).toEqual(['binance-spot']);

      process.env.EXECUTION_VENUE_BINANCE_SPOT_API_KEY = 'process-fake-key';
      process.env.EXECUTION_VENUE_BINANCE_SPOT_API_SECRET = 'process-fake-secret';
      const ignoresProcessEnv = buildExecutionVenueTradeMaps(['binance-spot'], {
        env: {},
        createAdapter: knownBinanceSpot,
      });
      expect(ignoresProcessEnv.wiredVenueIds).toEqual([]);
      expect(ignoresProcessEnv.submitByVenue['binance-spot']).toBeUndefined();
    });
  });

  it('loads credentials from process.env when options.env is absent', () => {
    withClearedBinanceSpotProcessEnv(() => {
      process.env.EXECUTION_VENUE_BINANCE_SPOT_API_KEY = 'process-fake-key';
      process.env.EXECUTION_VENUE_BINANCE_SPOT_API_SECRET = 'process-fake-secret';
      const maps = buildExecutionVenueTradeMaps(['binance-spot'], {
        createAdapter: knownBinanceSpot,
      });
      expect(maps.wiredVenueIds).toEqual(['binance-spot']);
    });
  });

  it('uses a supplied credentialsFor as given and does not consult options.env', () => {
    const unwired = buildExecutionVenueTradeMaps(['binance-spot'], {
      env: {
        EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'supplied-fake-key',
        EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'supplied-fake-secret',
      },
      credentialsFor: () => null,
      createAdapter: knownBinanceSpot,
    });
    expect(unwired.wiredVenueIds).toEqual([]);
    expect(unwired.submitByVenue['binance-spot']).toBeUndefined();

    const wired = buildExecutionVenueTradeMaps(['binance-spot'], {
      env: {},
      credentialsFor: () => tradeOnly('binance-spot'),
      createAdapter: knownBinanceSpot,
    });
    expect(wired.wiredVenueIds).toEqual(['binance-spot']);
  });

  it('loadExecutionVenueCredentials prefers EXECUTION_VENUE_* over VENUE_AGGREGATION_*', () => {
    const env = {
      EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'exec-key',
      EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'exec-secret',
      VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'agg-key',
      VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 'agg-secret',
    };
    const creds = loadExecutionVenueCredentials('binance-spot', env);
    expect(creds?.apiKey).toBe('exec-key');
    expect(describeExecutionVenueCredentialSources('binance-spot', env)).toMatchObject({
      executionEnvConfigured: true,
      operatorEnvConfigured: true,
      configured: true,
      inventsCredentials: false,
    });
  });

  it('loadExecutionVenueCredentials falls back to VENUE_AGGREGATION_* when execution env blank', () => {
    const env = {
      VENUE_AGGREGATION_BYBIT_SPOT_API_KEY: 'agg-key',
      VENUE_AGGREGATION_BYBIT_SPOT_API_SECRET: 'agg-secret',
    };
    const creds = loadExecutionVenueCredentials('bybit-spot', env);
    expect(creds?.apiKey).toBe('agg-key');
    expect(describeExecutionVenueCredentialSources('bybit-spot', env)).toMatchObject({
      executionEnvConfigured: false,
      operatorEnvConfigured: true,
      configured: true,
    });

    const maps = buildExecutionVenueTradeMaps(['bybit-spot'], {
      credentialsFor: (id) => loadExecutionVenueCredentials(id, env),
      createAdapter: ((id, creds) => createVenueTradeAdapter(id, creds)) as typeof createVenueTradeAdapter,
    });
    expect(maps.wiredVenueIds).toEqual(['bybit-spot']);
  });

  it('buildExecutionVenueTradeMapsWithOperatorSupplement wires operator-only venues', () => {
    const env = {
      VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 's',
    };
    const maps = buildExecutionVenueTradeMapsWithOperatorSupplement([], { env });
    expect(maps.wiredVenueIds).toEqual(['binance-spot']);
    expect(maps.operatorSupplementVenueIds).toEqual(['binance-spot']);
    expect(maps.submitByVenue['binance-spot']).toBeTypeOf('function');
  });

  it('execution list wins over operator supplement for the same venue id', () => {
    const env = {
      EXECUTION_VENUE_BINANCE_SPOT_API_KEY: 'exec-k',
      EXECUTION_VENUE_BINANCE_SPOT_API_SECRET: 'exec-s',
      VENUE_AGGREGATION_BINANCE_SPOT_API_KEY: 'agg-k',
      VENUE_AGGREGATION_BINANCE_SPOT_API_SECRET: 'agg-s',
    };
    const maps = buildExecutionVenueTradeMapsWithOperatorSupplement(['binance-spot'], {
      env,
      credentialsFor: (id) => loadExecutionVenueCredentials(id, env),
      createAdapter: ((id, creds) => createVenueTradeAdapter(id, creds)) as typeof createVenueTradeAdapter,
    });
    expect(maps.wiredVenueIds).toEqual(['binance-spot']);
    expect(maps.operatorSupplementVenueIds).toEqual([]);
  });
});
