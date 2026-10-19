import { expect, it } from 'vitest';
import { OkxSpotTrade } from './okx-spot-trade.js';
import { RecHttp, marketPostOnly } from './venue-test-http.js';
it('L114 okx: market+postOnly is refused, never sent', async () => {
  const book = {
    code: '0',
    msg: '',
    data: [{ asks: [['30002.10', '1.5', '0', '1']], bids: [['30000.00', '2.0', '0', '1']], ts: '1700000000000', seqId: 42 }],
  };
  const http = new RecHttp(book);
  const t = new OkxSpotTrade(
    { venueId: 'okx-spot', apiKey: 'k', apiSecret: 's', passphrase: 'p', scopes: ['read', 'trade'] },
    { http, restBase: 'https://www.okx.com', clock: () => Date.parse('2026-08-17T00:00:00Z'), snapshotLimit: 5 },
  );
  await expect(t.placeOrder(marketPostOnly)).rejects.toThrow(/post/i);
  expect(http.posts).toHaveLength(0);
});
