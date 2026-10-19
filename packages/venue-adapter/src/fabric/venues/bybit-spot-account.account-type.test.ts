import { describe, expect, it } from 'vitest';
import { BybitSpotAccount } from './bybit-spot-account.js';
describe('L106 wallet-balance accountType', () => {
  it('asks for UNIFIED not SPOT', async () => {
    const urls: string[] = [];
    const http: any = {
      async get(url: string) {
        urls.push(url);
        return { status: 200, body: { retCode: 0, result: { list: [] } }, header: () => null };
      },
    };
    const a = new BybitSpotAccount({ venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read'] } as any, {
      http,
      clock: () => 1_700_000_000_000,
    });
    await a.balances();
    expect(urls[0]).toContain('accountType=UNIFIED');
  });
});
