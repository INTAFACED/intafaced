// World: restart
import { test, expect } from './journey.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, venueForThisFile } from './venue.mjs';

// PLANTED, never merged: journey A of the own-world proof. It takes part of the TEST venue's seeded 59,990 bid on
// BTC-USDC (as J-agents-18 did before J-campaigns-11, #8594) and leaves a bid of its own resting above it (as J-bank-13
// did before J-cex-spot-02, #8546). It never cancels anything.
const J = 'J-plant-world-01';
const RUN = `${process.env.JOURNEY_RUN_ID ?? 'local'}-${Date.now()}`;
venueForThisFile(test);
test.describe.configure({ mode: 'serial' });

const intent = (side, price, amount, timeInForce, key) => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side,
  type: 'limit',
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: `order:${key}`,
  builderFee: null,
});

test(`${J} #1 sells into the seeded bid and leaves a bid of its own resting above it`, async () => {
  const seller = `${J}-seller-${RUN}`;
  await testDeposit(otherTraderKey(seller).address, 'BTC', '1', `seed:${seller}:BTC`);
  expect(await otherTraderRun(seller, intent('sell', '59990', '0.3', 'IOC', `${seller}:take`))).toMatchObject({
    definite: true,
    accepted: true,
  });
  const buyer = `${J}-buyer-${RUN}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '100000', `seed:${buyer}:USDC`);
  expect(await otherTraderRun(buyer, intent('buy', '59995', '1', 'GTC', `${buyer}:rest`))).toMatchObject({
    definite: true,
    accepted: true,
  });
});
