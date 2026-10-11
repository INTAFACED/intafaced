import { describe, expect, it } from 'vitest';
import { formatAmount } from '@intafaced/ledger-client/money';
import { VenueCredentialScopeError, VenueCredentialsMissingError } from '@intafaced/venue-contracts';
import { createVenueAccountAdapter } from './factory.js';
import { BinanceSpotAccount } from './binance-spot-account.js';
import { BybitSpotAccount } from './bybit-spot-account.js';
import { OkxSpotAccount } from './okx-spot-account.js';
import type { HttpPort, HttpResponse } from '../transport.js';

class FakeHttp implements HttpPort {
  readonly requests: string[] = [];
  constructor(private readonly body: unknown) {}
  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    return { status: 200, body: this.body, header: () => null };
  }
}

const KEYS = { venueId: 'binance-spot' as const, apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] as const };

describe('createVenueAccountAdapter', () => {
  it('builds all three spot account adapters from their ids', () => {
    expect(createVenueAccountAdapter('binance-spot', KEYS)).toBeInstanceOf(BinanceSpotAccount);
    expect(createVenueAccountAdapter('bybit-spot', { ...KEYS, venueId: 'bybit-spot' })).toBeInstanceOf(BybitSpotAccount);
    expect(createVenueAccountAdapter('okx-spot', { ...KEYS, venueId: 'okx-spot', passphrase: 'p' })).toBeInstanceOf(OkxSpotAccount);
    expect(createVenueAccountAdapter('  BINANCE-SPOT  ', KEYS)!.venue.id).toBe('binance-spot');
    expect(createVenueAccountAdapter('')).toBeNull();
    expect(createVenueAccountAdapter('off')).toBeNull();
    expect(createVenueAccountAdapter('not-a-venue', KEYS)).toBeNull();
  });

  it('refuses a withdrawal key at construct — before HTTP', () => {
    expect(() =>
      createVenueAccountAdapter('binance-spot', { venueId: 'binance-spot', apiKey: 'k', apiSecret: 's', scopes: ['trade', 'withdraw'] }),
    ).toThrow(VenueCredentialScopeError);
  });

  it('missing keys throw on balances, never an empty wallet', async () => {
    const account = createVenueAccountAdapter('binance-spot');
    expect(account).not.toBeNull();
    await expect(account!.balances()).rejects.toThrow(VenueCredentialsMissingError);
  });

  it('reaches signed GET /api/v3/account through the factory id', async () => {
    const http = new FakeHttp({
      balances: [{ asset: 'USDT', free: '90', locked: '10' }],
    });
    const account = createVenueAccountAdapter('binance-spot', KEYS, { http, restBase: 'https://rest.test', clock: () => 1 });
    expect(account).not.toBeNull();
    const rows = await account!.balances();
    expect(rows).toHaveLength(1);
    expect(formatAmount(rows[0]!.total)).toBe('100');
    expect(http.requests[0]).toContain('/api/v3/account?');
    expect(http.requests[0]).toContain('signature=');
  });
});
