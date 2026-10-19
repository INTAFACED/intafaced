import { expect, it } from 'vitest';
import { BinanceSpotTrade } from './binance-spot-trade.js';
import { RecHttp, marketPostOnly } from './venue-test-http.js';
it('L103 binance: market+postOnly is refused, never signed', async () => {
  const book = {
    lastUpdateId: 1,
    bids: [
      ['30000.00', '2.00'],
      ['29999.00', '5.00'],
    ],
    asks: [
      ['30002.00', '1.00'],
      ['30003.00', '4.00'],
    ],
  };
  const http = new RecHttp(book);
  const t = new BinanceSpotTrade(
    { venueId: 'binance-spot', apiKey: 'k', apiSecret: 's', scopes: ['read', 'trade'] },
    { http, restBase: 'https://r.test', clock: () => 1_700_000_000_000, snapshotLimit: 5 },
  );
  await expect(t.placeOrder(marketPostOnly)).rejects.toThrow(/post/i);
  expect(http.posts).toHaveLength(0);
});
