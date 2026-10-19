import { expect, it } from 'vitest';
import { BybitSpotTrade } from './bybit-spot-trade.js';
import { RecHttp, marketPostOnly } from './venue-test-http.js';
it('L108 bybit: market+postOnly is refused, never sent', async () => {
  const book = {
    retCode: 0,
    retMsg: 'OK',
    result: {
      s: 'BTCUSDT',
      b: [
        ['30000.00', '2.00'],
        ['29999.00', '5.00'],
      ],
      a: [
        ['30002.00', '1.00'],
        ['30003.00', '4.00'],
      ],
      ts: 1_700_000_000_000,
      u: 1,
      seq: 9001,
      cts: 1_700_000_000_000,
    },
    retExtInfo: {},
    time: 1_700_000_000_000,
  };
  const http = new RecHttp(book);
  const t = new BybitSpotTrade(
    { venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] },
    { http, clock: () => 1_700_000_000_000, snapshotLimit: 5 },
  );
  await expect(t.placeOrder(marketPostOnly)).rejects.toThrow(/post/i);
  expect(http.posts).toHaveLength(0);
});
