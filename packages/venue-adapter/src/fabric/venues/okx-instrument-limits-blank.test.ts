import { expect, it } from 'vitest';
import { OkxSpotMarketData } from './okx-spot.js';
import { json } from './venue-test-http.js';
it('L117 okx: an instrument with absent tickSz/lotSz/minSz is not published as tradable with invented limits', async () => {
  const http = {
    get: async () => json(200, { code: '0', msg: '', data: [{ instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live' }] }),
  };
  const md = new OkxSpotMarketData({ http, clock: () => 1_700_000_000_000, restBase: 'https://r.test' } as any);
  let out: any[] = [];
  try {
    out = await md.markets();
  } catch (e) {
    console.log('THREW', String(e));
    out = [];
  }
  expect(out.filter((m) => m.active)).toHaveLength(0);
});
