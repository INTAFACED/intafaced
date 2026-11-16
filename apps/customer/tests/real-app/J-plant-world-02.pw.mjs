// World: restart
import { test, expect } from './journey.mjs';
import { sameDecimal, testVenue, venueForThisFile } from './venue.mjs';

// PLANTED, never merged: journey B of the own-world proof, run after J-plant-world-01 in the same shard. It reads the
// TEST venue's BTC-USDC book and expects it as the venue seeds it (local-test-venue.mjs, packages/venue-sim
// seedTestVenue: mid 60,000, step 10, 1 BTC a level), so it is red exactly when another file's orders reach it.
const J = 'J-plant-world-02';
venueForThisFile(test);

test(`${J} #1 meets the TEST venue's BTC-USDC book as seeded: best bid 1 BTC at 59990, best ask 1 BTC at 60010`, async () => {
  const { status, body } = await testVenue('/book', {
    symbol: 'BTC-USDC',
    depth: 3,
  });
  expect(status, JSON.stringify(body)).toBe(200);
  const top = (levels) => levels.map((l) => [String(l.price), String(l.amount)]);
  const said = JSON.stringify({
    bids: top(body.value.bids),
    asks: top(body.value.asks),
  });
  const [bid] = body.value.bids;
  const [ask] = body.value.asks;
  expect(sameDecimal(bid.price, '59990') && sameDecimal(bid.amount, '1'), `best bid: ${said}`).toBe(true);
  expect(sameDecimal(ask.price, '60010') && sameDecimal(ask.amount, '1'), `best ask: ${said}`).toBe(true);
});
