import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, fund, journeyState, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-more-catalogue-02, in the running app (docs/roadmap/journeys.json): find a strategy in the Market and buy it. One test
// per step, titled "J-more-catalogue-02 #<n>", run in order. No real value moves: the buyer and the seller are TEST
// accounts on the local stack, funded with TEST assets through the real ledger.
// The start is built through the product's own doors, never injected: a TEST seller signs up, verifies, stakes 1000 TEST
// IFC (the Initiate tier's one listing slot), applies as a vendor, is approved by the stack's two TEST operators
// (`local-test-gates.mjs market-vet`, svc-market's two-person door) and publishes a strategy subscription at 10 TEST USDT.
// The stack runs svc-market with the TEST commission and a TEST one-hour refund window
// (tooling/profiles/test-owner-values/market.json), so a purchase is held in the buyer's own pot until the window ends.
// The seller and listing are the stack's: kept in a stack-wide run file and reused while the listing is still in the
// catalogue, so a long-lived stack does not fill the catalogue's first page with copies.
// Step 6's "refund policy undecided" restarts market with the window unset (LOCAL_STACK_MARKET_REFUND_POLICY=off), reads
// the refusal, then restarts it with the TEST window, in a try/finally.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /market has no listing-type switch and no four entry points to the copy, bot and signal rooms (MC-market-01).
// - #2: no listing page by id with seller profile, review summary and performance (MC-market-01).
// - #3: no listings of other kinds and no placement label (RC-more-catalogue-18 to -20).
// - #7: no review after a released purchase (MC-market-02).
const J = 'J-more-catalogue-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const shop = journeyState(`${J}-stack-listing`);
const UNBUILT = { timeout: 5_000 };
const PRICE = '10';
const PERIOD_SECONDS = 2_592_000;

test.describe.configure({ mode: 'default' });

const data = (res) => res.body?.result?.data;
const causeOf = (body) => body?.error?.data?.cause;
const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0', total: '0' };

async function ok(res) {
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res);
}

/** My purchases as svc-market keeps them: the inventory every screen read is checked against. */
async function myPurchases(who) {
  return ok(await (await api(who)).get(`/api/market/trpc/myPurchases${trpcInput({ limit: 50 })}`));
}

async function catalogue(who) {
  return ok(await (await api(who)).get(`/api/market/trpc/listings${trpcInput({ limit: 50 })}`));
}

/**
 * A listing slot is read from the seller's stake in svc-token, which refuses every stake read while its fee-decay ladder
 * is blank. On a stack where no journey has published one yet, two TEST founders publish a one-step TEST ladder (no
 * discount at any stake) through the token's two-person door, as J-copy-bots-otc-24 does; a ladder already there stands.
 */
async function stakeReadable(who) {
  const read = async () => (await (await api(who)).get('/api/token/trpc/feeDiscount.get')).body.result.data;
  if ((await read()).schedule != null) return;
  const ctx = await makeContext({ log: () => undefined });
  const schedule = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
  await setFeeDiscountSchedule(ctx, schedule, { sessions: await approverSessions(ctx) }).catch(async (err) => {
    // Another journey published first, between the read and the write: its ladder stands.
    if ((await read()).schedule == null) throw err;
  });
}

/** The stack's TEST seller and strategy listing, built through the product's doors when the stack has none yet. */
async function stackListing(page, buyer) {
  const kept = shop.read();
  const listed = kept.listingId ? (await catalogue(buyer)).some((l) => l.id === kept.listingId && l.status === 'active') : false;
  if (listed) return kept;
  const seller = await signUp(page, 'mks');
  await verify(page, seller);
  expect(fund(seller.email, 'IFC', '1100').tx).toBeTruthy();
  await stakeReadable(seller);
  const client = await api(seller);
  expect(await ok(await client.post('/api/token/trpc/stake', { amount: '1000', tier: 'flex', stakeId: randomUUID() }))).toMatchObject({
    amount: '1000',
    status: 'active',
  });
  const vendor = await ok(
    await client.post('/api/market/trpc/applyAsVendor', {
      displayName: 'TEST strategy seller',
      description: 'TEST: a local test stack seller, not a real business.',
    }),
  );
  expect(tool('local-test-gates.mjs', 'market-vet', vendor.id)).toContain(`vendor ${vendor.id} approved`);
  const title = `TEST strategy with a refund window ${Date.now().toString(36)}`;
  const listing = await ok(
    await client.post('/api/market/trpc/createStrategyListing', {
      title,
      description: 'TEST: a strategy subscription on the local test stack. Not advice and not a real product.',
      assetId: 'USDT',
      price: PRICE,
      periodSeconds: PERIOD_SECONDS,
    }),
  );
  expect(listing).toMatchObject({ title, assetId: 'USDT', status: 'active', vendorId: vendor.id });
  return shop.reset({ seller, vendorId: vendor.id, listingId: listing.id, title });
}

async function openMarket(page, who) {
  await signIn(page, who);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
}

const card = (page, title) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const purchasesRoom = (page) => page.getByRole('region', { name: 'Your purchases' }).last();
const purchaseRow = (page, id) => purchasesRoom(page).getByRole('article', { name: `Purchase ${id}`, exact: true });

async function openPurchases(page, who) {
  await signIn(page, who);
  await page.goto('/market/purchases');
  await expect(purchasesRoom(page)).toBeVisible();
}

/** Market restarted with the TEST refund window (`on`) or with it unset, as the token lane's restarts do (J-more-catalogue-09). */
function refundPolicy(on) {
  const before = process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  if (on) delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
  else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'market');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_MARKET_REFUND_POLICY;
    else process.env.LOCAL_STACK_MARKET_REFUND_POLICY = before;
  }
}

/** The status a buyer reads for a purchase, from svc-market's own record. */
const statusOf = (p) =>
  ({ held: 'Held', refunded: 'Refunded', released: 'Released' })[p.hold?.state] ??
  { settled: 'Settled', pending: 'Pending', rejected: 'Rejected' }[p.status];
/** The heading an inspected purchase shows: only a released or direct sale is a settlement receipt. */
const receiptOf = (p) =>
  ({ held: 'Held until the refund window ends', refunded: 'Refunded', released: 'Settlement recorded' })[p.hold?.state] ??
  { settled: 'Settlement recorded', pending: 'Settlement not confirmed', rejected: 'Purchase rejected' }[p.status];

test(`${J} starts: a verified TEST account with 100 USDT, and the stack's TEST strategy listing approved`, async ({ page }) => {
  test.setTimeout(300_000);
  const who = await signUp(page, 'mk');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  const listing = await stackListing(page, who);
  expect((await catalogue(who)).filter((l) => l.id === listing.listingId)).toEqual([
    expect.objectContaining({ title: listing.title, price: PRICE, assetId: 'USDT', status: 'active' }),
  ]);
  run.reset({ who, ...listing });
});

test(`${J} #1 opens /market: listings with terms, a listing-type switch and four entry points to their own rooms, ordered by registration, price or title, never by returns`, async ({
  page,
}) => {
  await openMarket(page, run.read().who);
  const types = page.getByRole('radiogroup', { name: 'Listing type' });
  await expect(types.getByRole('radio', { name: 'Access listing' })).toBeVisible(UNBUILT);
  await expect(types.getByRole('radio', { name: 'Strategy subscription' })).toBeVisible();
  const doors = page.getByRole('navigation', { name: 'More in the Market' });
  for (const door of ['Spot copy trading', 'Futures copy trading', 'Bot marketplace', 'Signal marketplace']) {
    await expect(doors.getByRole('link', { name: new RegExp(door) })).toBeVisible();
  }
  const sort = page.getByRole('combobox', { name: 'Sort by' });
  const options = await sort.getByRole('option').allInnerTexts();
  expect(options).toEqual(expect.arrayContaining(['Newest', 'Price', 'Title']));
  expect(options.join(' ')).not.toMatch(/return|profit|performance/i);
});

test(`${J} #2 opens a listing by id: the seller profile, review summary and performance with its stated basis; an unknown id is a typed not-found`, async ({
  page,
}) => {
  const { who, listingId } = run.read();
  await signIn(page, who);
  await page.goto(`/market/listing/${listingId}`);
  const listing = page.getByRole('main');
  await expect(listing.getByRole('region', { name: 'Seller' })).toBeVisible(UNBUILT);
  await expect(listing.getByRole('region', { name: 'Reviews' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Performance' })).toContainText(/Basis:/);
  await page.goto('/market/listing/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('main')).toContainText('No listing has this id.');
});

test(`${J} #3 browses vendor listings of other kinds (signals, data, indicators) and sees premium placement: the category taxonomy and lifecycle for every kind, and placement labelled`, async ({
  page,
}) => {
  await openMarket(page, run.read().who);
  const kinds = page.getByRole('combobox', { name: 'Category' });
  await expect(kinds).toBeVisible(UNBUILT);
  for (const kind of ['Signals', 'Data', 'Indicators']) await expect(kinds.getByRole('option', { name: kind })).toBeAttached();
  await expect(page.getByText('Promoted placement').first()).toBeVisible();
});

test(`${J} #4 presses Buy on the strategy: the charge into the held account once, the record shows held, and the seller sees nothing yet`, async ({
  page,
}) => {
  const { who, seller, title, listingId } = run.read();
  const before = await usdt(who);
  const sellerBefore = await usdt(seller);
  await openMarket(page, who);
  const listing = card(page, title);
  await expect(listing.getByRole('group', { name: 'Price' })).toHaveText(PRICE);
  await listing.getByRole('button', { name: `Buy ${title}` }).click();
  const bought = page.waitForResponse((r) => r.url().includes('/api/market/trpc/purchase'));
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  const answer = await bought;
  expect(answer.status()).toBe(200);
  const purchase = (await answer.json()).result.data;
  await expect(page.getByRole('status').filter({ hasText: 'Held until the refund window ends.' })).toBeVisible();
  // Charged once, into the held account: the buyer's free USDT is down by the price, and svc-market's record is one hold
  // of exactly the price whose window ends one TEST hour after it was held.
  expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) - toUnits(PRICE));
  const mine = (await myPurchases(who)).filter((p) => p.listingId === listingId);
  expect(mine).toEqual([expect.objectContaining({ id: purchase.id, status: 'settled', price: PRICE, refundWindowSeconds: 3600 })]);
  expect(mine[0].hold).toMatchObject({ state: 'held', heldAmount: PRICE, refundTxId: null, releaseTxId: null });
  expect(Date.parse(mine[0].hold.windowEndsAt) - Date.parse(mine[0].hold.heldAt)).toBe(3_600_000);
  // The seller sees nothing yet: their USDT is unchanged.
  expect(await usdt(seller)).toEqual(sellerBefore);
  await page.goto('/market/purchases');
  await expect(purchaseRow(page, purchase.id)).toContainText(/Status\s*Held/);
  run.write({ purchaseId: purchase.id });
});

test(`${J} #5 presses Buy again, or loses the reply: one purchase, and the screen re-reads the stored state`, async ({ page }) => {
  const { who, title, listingId, purchaseId } = run.read();
  expect(purchaseId, 'a purchase from #4').toBeTruthy();
  const before = await usdt(who);
  await openMarket(page, who);
  const listing = card(page, title);
  await expect(listing.getByRole('button', { name: `Buy ${title}` })).toBeDisabled();
  await expect(listing).toContainText('You own this. Held until the refund window ends.');
  const client = await api(who);
  // The reply lost: sending the same purchase again answers with the stored one, held, and charges nothing.
  const again = await ok(await client.post('/api/market/trpc/purchase', { listingId, purchaseId }));
  expect(again).toMatchObject({ id: purchaseId, status: 'settled', hold: { state: 'held' } });
  // Buy again as a new purchase: refused by name while the first is held.
  const second = await client.post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() });
  expect(second.status).toBe(409);
  expect(causeOf(second.body)?.code).toBe('market.purchase_already_held');
  expect((await myPurchases(who)).filter((p) => p.listingId === listingId).map((p) => p.id)).toEqual([purchaseId]);
  expect(await usdt(who)).toEqual(before);
  // The screen re-reads the stored state: one row for the purchase, held.
  await page.goto('/market/purchases');
  await expect(purchaseRow(page, purchaseId)).toHaveCount(1);
  await expect(purchaseRow(page, purchaseId)).toContainText(/Status\s*Held/);
});

test(`${J} #6 requests a refund inside the window: the amount returns once; with the refund policy undecided the refund shows its named blocker`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, seller, listingId, purchaseId } = run.read();
  expect(purchaseId, 'a purchase from #4').toBeTruthy();
  const sellerBefore = await usdt(seller);
  const before = await usdt(who);
  // The refund policy undecided: market restarts with the window unset, and the ask is refused by name. Nothing moves and
  // the purchase stays held. The TEST window is back afterwards.
  try {
    refundPolicy(false);
    await openPurchases(page, who);
    await purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' }).click();
    const asked = page.waitForResponse((r) => r.url().includes('/api/market/trpc/refundPurchase'));
    await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click();
    const refused = await asked;
    expect(refused.status()).toBe(412);
    expect(causeOf(await refused.json())?.code).toBe('market.refund_policy_unset');
    await expect(page.getByRole('status').getByRole('heading', { name: 'The refund policy is not decided', exact: true })).toBeVisible();
    const still = (await myPurchases(who)).filter((p) => p.listingId === listingId);
    expect(still).toEqual([
      expect.objectContaining({
        id: purchaseId,
        hold: expect.objectContaining({ state: 'held', refundRequestedAt: null }),
      }),
    ]);
    expect(await usdt(who)).toEqual(before);
  } finally {
    refundPolicy(true);
  }
  // Inside the window with the TEST policy: the whole amount returns once.
  await openPurchases(page, who);
  await purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' }).click();
  const asked = page.waitForResponse((r) => r.url().includes('/api/market/trpc/refundPurchase'));
  await page.getByRole('dialog').getByRole('button', { name: 'Refund', exact: true }).click();
  expect((await asked).status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Refunded: the whole amount is back in your account.' })).toBeVisible();
  expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) + toUnits(PRICE));
  const [refunded] = (await myPurchases(who)).filter((p) => p.listingId === listingId);
  expect(refunded.hold).toMatchObject({ state: 'refunded', releaseTxId: null });
  expect(refunded.hold.refundTxId).toBeTruthy();
  await expect(purchaseRow(page, purchaseId)).toContainText(/Status\s*Refunded/);
  await expect(purchaseRow(page, purchaseId).getByRole('button', { name: 'Ask for a refund' })).toHaveCount(0);
  // Once: asking again returns the same refund and moves nothing more. The seller was never paid.
  const retry = await ok(await (await api(who)).post('/api/market/trpc/refundPurchase', { purchaseId }));
  expect(retry.hold).toMatchObject({ state: 'refunded', refundTxId: refunded.hold.refundTxId });
  expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) + toUnits(PRICE));
  expect(await usdt(seller)).toEqual(sellerBefore);
});

test(`${J} #7 writes a review after a settled purchase: one review stored, a second refused as already reviewed, and a visitor with no purchase refused`, async ({
  page,
}) => {
  const { who, title } = run.read();
  await openMarket(page, who);
  await card(page, title).getByRole('button', { name: 'Write a review' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Your review' });
  await form.getByRole('textbox', { name: 'Review' }).fill('TEST review');
  await form.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('status')).toContainText('Review posted');
  await card(page, title).getByRole('button', { name: 'Write a review' }).click();
  await expect(page.getByRole('alert')).toContainText('You have already reviewed this listing.');
});

test(`${J} #8 opens /market/purchases: price, window and status for each; a pending settlement is not shown as a receipt`, async ({
  page,
}) => {
  const { who, listingId } = run.read();
  // A second purchase, held now, so the list holds a pending settlement next to #6's refunded one.
  const held = await ok(await (await api(who)).post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() }));
  expect(held.hold).toMatchObject({ state: 'held' });
  const inventory = await myPurchases(who);
  expect(inventory.map(statusOf).sort()).toEqual(['Held', 'Refunded']);
  await openPurchases(page, who);
  await expect(purchasesRoom(page).getByRole('article')).toHaveCount(inventory.length);
  for (const p of inventory) {
    const row = purchaseRow(page, p.id);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(new RegExp(`Price\\s*${p.price}\\s*${p.assetId}`));
    await expect(row.locator(`time[datetime="${p.hold.windowEndsAt}"]`)).toHaveCount(1);
    await expect(row).toContainText(new RegExp(`Status\\s*${statusOf(p)}`));
    await row.getByRole('button', { name: 'Inspect purchase' }).click();
    const inspected = page.getByRole('region', { name: 'Selected original purchase' });
    await expect(inspected.getByRole('heading', { level: 3, name: receiptOf(p), exact: true })).toBeVisible();
    await expect(inspected.getByRole('heading', { name: 'Settlement recorded' })).toHaveCount(0);
  }
});
