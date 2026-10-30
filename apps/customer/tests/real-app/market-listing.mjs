import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { api, fund } from './stack.mjs';
import { signUp, verify } from './desk.mjs';

// A TEST seller and their TEST strategy listing on the local stack, built through the product's own doors, never
// injected: a TEST account signs up, is verified, is funded with TEST IFC through the real ledger and stakes 1000 of it
// in svc-token (the stake tier that holds one listing slot); it applies to sell in the Market, the stack's two TEST
// operators approve the application through identity's four-eyes door and svc-market's `vet` (`market:ops`), and the
// seller publishes a strategy listing. svc-market's house commission is the stack's labelled TEST value
// (tooling/profiles/test-owner-values/market.json).

const STAKE = '1000';
const gatesTool = () => import('../../../../tooling/scripts/local-test-gates.mjs');
const data = (res, what) => {
  const row = res.body?.result?.data;
  expect(row, `${what} refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`).toBeTruthy();
  return row;
};

/**
 * svc-token refuses every stake read while its fee-decay ladder is blank, and svc-market reads the seller's slots from
 * that read. On a stack where no journey has published one yet, two TEST founders publish a one-step TEST ladder (no
 * discount at any stake) through the token's two-person door, as J-copy-bots-otc-24 does; a ladder already there stays.
 */
async function stakeReadable(client) {
  const read = async () => (await client.get('/api/token/trpc/feeDiscount.get')).body.result.data;
  if ((await read()).schedule != null) return;
  const gates = await gatesTool();
  const ctx = await gates.makeContext({ log: () => undefined });
  const schedule = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
  await gates.setFeeDiscountSchedule(ctx, schedule, { sessions: await gates.approverSessions(ctx) }).catch(async (err) => {
    // Another journey published first, between the read and the write: its ladder stands.
    if ((await read()).schedule == null) throw err;
  });
}

/**
 * A new approved TEST seller with one published TEST strategy listing titled `title`. Returns the seller and the
 * listing as svc-market answered its creation.
 */
export async function testStrategyListing(page, { title, price = '10', assetId = 'USDT', periodSeconds = 30 * 86_400 }) {
  const seller = await signUp(page, 'mks');
  await verify(page, seller);
  expect(fund(seller.email, 'IFC', '1100').tx).toBeTruthy();
  const client = await api(seller);
  const staked = data(await client.post('/api/token/trpc/stake', { amount: STAKE, tier: 'flex', stakeId: randomUUID() }), 'stake');
  expect(staked).toMatchObject({ amount: STAKE, status: 'active' });
  const applied = data(
    await client.post('/api/market/trpc/applyAsVendor', { displayName: `TEST seller ${seller.handle}`, description: 'TEST seller' }),
    'applyAsVendor',
  );
  await stakeReadable(client);
  const gates = await gatesTool();
  const ctx = await gates.makeContext({ log: () => {} });
  const vetted = await gates.vetVendor(ctx, applied.id, 'approved', 'TEST seller for J-more-catalogue-02');
  expect(vetted.vendor.status).toBe('approved');
  const listing = data(
    await client.post('/api/market/trpc/createStrategyListing', {
      title,
      description: 'TEST strategy listing on the local test stack. Not a real strategy.',
      assetId,
      price,
      periodSeconds,
    }),
    'createStrategyListing',
  );
  return { seller, listing };
}
