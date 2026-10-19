import { expect, it } from 'vitest';
import { OkxSpotMarketData } from './okx-spot.js';
import { json } from './venue-test-http.js';

const live = { instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', tickSz: '0.1', lotSz: '0.00000001', minSz: '0.00001' };
const blank = { instId: 'NEW-USDT', baseCcy: 'NEW', quoteCcy: 'USDT', state: 'preopen' };

it('okx markets(): one instrument with blank limits is left out and the rest of the list still loads', async () => {
  const http = { get: async () => json(200, { code: '0', msg: '', data: [blank, live] }) };
  const md = new OkxSpotMarketData({ http, clock: () => 1_700_000_000_000, restBase: 'https://r.test' } as never);
  const out = await md.markets();
  expect(out.map((m) => m.venueSymbol)).toEqual(['BTC-USDT']);
});
