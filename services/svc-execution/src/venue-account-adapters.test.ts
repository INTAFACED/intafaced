import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { AccountAdapter, VenueBalance, VenueCredentials } from '@intafaced/venue-contracts';
import { createVenueAccountAdapter } from '@intafaced/venue-adapter';
import {
  buildExecutionVenueAccountMaps,
  buildExecutionVenueAccountMapsWithOperatorSupplement,
  wireAccountAdapter,
  wireExecutionVenueAccountAdapter,
} from './venue-account-adapters.js';
import { ExecutionVenueCredentialsUnsetError, ExecutionVenueUnknownError } from './venue-adapters.js';

const CREDS: VenueCredentials = {
  venueId: 'binance-spot',
  apiKey: 'k',
  apiSecret: 's',
  scopes: ['read', 'trade'],
};

const OBSERVED = new Date('2026-08-21T00:00:00.000Z');

function fakeAccount(balances: VenueBalance[] = []): AccountAdapter {
  return {
    venue: { id: 'binance-spot', displayName: 'binance-spot', kind: 'external-cex', sequencedDepth: true },
    balances: vi.fn(async () => balances),
    positions: vi.fn(async () => []),
    transferRails: vi.fn(async () => []),
  };
}

describe('wireExecutionVenueAccountAdapter', () => {
  it('wires known venue with credentials', () => {
    const createAdapter = vi.fn((id: string, _creds: VenueCredentials | null) =>
      id === 'binance-spot'
        ? fakeAccount([
            {
              venueId: 'binance-spot',
              asset: 'USDT',
              free: parseAmount('1'),
              used: parseAmount('0'),
              total: parseAmount('1'),
              observedAt: OBSERVED,
            },
          ])
        : null,
    ) as typeof createVenueAccountAdapter;
    const wire = wireExecutionVenueAccountAdapter('binance-spot', CREDS, { createAdapter });
    expect(createAdapter).toHaveBeenCalledWith('binance-spot', CREDS);
    expect(wire.balances).toBeTypeOf('function');
  });

  it('refuses unknown venue id', () => {
    expect(() =>
      wireExecutionVenueAccountAdapter('unknown-venue', CREDS, {
        createAdapter: (() => null) as typeof createVenueAccountAdapter,
      }),
    ).toThrow(ExecutionVenueUnknownError);
  });

  it('refuses blank credentials', () => {
    expect(() =>
      wireExecutionVenueAccountAdapter('binance-spot', null, {
        createAdapter: ((id) => (id === 'binance-spot' ? fakeAccount() : null)) as typeof createVenueAccountAdapter,
      }),
    ).toThrow(ExecutionVenueCredentialsUnsetError);
  });
});

describe('buildExecutionVenueAccountMaps', () => {
  it('skips venues without credentials — never invents a map entry', () => {
    const maps = buildExecutionVenueAccountMaps(['binance-spot', 'bybit-spot'], {
      credentialsFor: (id) => (id === 'binance-spot' ? CREDS : null),
      createAdapter: ((id) => (id === 'binance-spot' || id === 'bybit-spot' ? fakeAccount() : null)) as typeof createVenueAccountAdapter,
    });
    expect(maps.wiredVenueIds).toEqual(['binance-spot']);
    expect(Object.keys(maps.balancesByVenue)).toEqual(['binance-spot']);
    expect(maps.balancesByVenue['bybit-spot']).toBeUndefined();
  });

  it('forwards adapter balances without rewriting', async () => {
    const balances: VenueBalance[] = [
      {
        venueId: 'binance-spot',
        asset: 'BTC',
        free: parseAmount('0.5'),
        used: parseAmount('0.1'),
        total: parseAmount('0.6'),
        observedAt: OBSERVED,
      },
    ];
    const wire = wireAccountAdapter(fakeAccount(balances));
    await expect(wire.balances()).resolves.toEqual(balances);
  });

  it('buildExecutionVenueAccountMapsWithOperatorSupplement wires operator-only venues', () => {
    const env = {
      VENUE_AGGREGATION_OKX_SPOT_API_KEY: 'k',
      VENUE_AGGREGATION_OKX_SPOT_API_SECRET: 's',
      VENUE_AGGREGATION_OKX_SPOT_PASSPHRASE: 'p',
    };
    const maps = buildExecutionVenueAccountMapsWithOperatorSupplement([], { env });
    expect(maps.wiredVenueIds).toEqual(['okx-spot']);
    expect(maps.operatorSupplementVenueIds).toEqual(['okx-spot']);
    expect(maps.balancesByVenue['okx-spot']).toBeTypeOf('function');
  });
});
