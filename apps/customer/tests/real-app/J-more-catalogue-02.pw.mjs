import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-02, in the running app (docs/roadmap/journeys.json): find a strategy in the Market and buy it. One test
// per step, titled "J-more-catalogue-02 #<n>", run in order. Step 1 makes the journey's start: a verified TEST seller
// publishes a strategy subscription at TEST 25 USDT with a refund window, a founder approves it on the console, and a
// verified buyer holds TEST 200 USDT. The commission, the refund window and the refund policy are the stack's TEST
// market terms. Every purchase is read back from svc-market and every balance from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the house commission is unpublished on the stack, so the market refuses every listing ("The house commission is
//   unpublished, so the service refuses listing creation and purchases."); there is no founder approval door on the
//   console; /market has no listing-type switch and no entry points to the other rooms.
// - #3: no vendor listing kinds (signals, data, indicators), category taxonomy or labelled placement.
// - #6: no refund window or refund request; #7: no reviews.
const J = 'J-more-catalogue-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const PRICE = '25';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/market/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const listings = (page) => page.getByRole('region', { name: 'Browse listings' });

async function purchasesOf(who) {
  const { status, body } = await (await api(who)).get(trpc('purchases.list', { limit: 20 }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.items;
}

/** Opens the listing's page from /market by its id. */
async function openListing(page, id) {
  await page.goto(`/market?listing=${encodeURIComponent(id)}`);
  await expect(page.getByRole('region', { name: 'Listing' })).toBeVisible(UNBUILT);
}

test(`${J} #1 opens /market: listings with terms, a listing-type switch, four entry points to their rooms, never ordered by returns`, async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  // The seller publishes a strategy subscription.
  const seller = await fundedTrader(page, 'jmks', '10');
  await signIn(page, seller);
  await page.goto('/market/strategy');
  const title = `TEST strategy ${seller.handle}`;
  await page.getByLabel('Listing title').fill(title);
  await page.getByLabel('Listing description').fill('TEST strategy subscription for the market journey.');
  await page.getByLabel('Price asset ID').fill('USDT');
  await page.getByLabel('Price', { exact: true }).fill(PRICE);
  await page.getByLabel('Paid period in seconds').fill('2592000');
  await page.getByRole('button', { name: 'Review listing' }).click(UNBUILT);
  const created = page.waitForResponse((res) => res.url().includes('listings.create') && res.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish listing' }).click();
  const answer = await created;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const listingId = (await answer.json()).result.data.id;
  await signOutBrowser(page.context());

  // A founder approves it on the console.
  const founder = await (await browser.newContext()).newPage();
  await founderSignIn(founder, 'a');
  await founder.goto(`${ADMIN}/more-ops/market`);
  await founder
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: 'Approve' })
    .click(UNBUILT);
  await expect(founder.getByRole('row', { name: new RegExp(title) })).toContainText('Approved');
  await founder.context().close();

  const buyer = await fundedTrader(page, 'jmkb', '200');
  run.reset({ seller, buyer, listingId, title });
  await signIn(page, buyer);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
  const row = listings(page).getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText(`${PRICE} USDT`);
  await expect(row).toContainText(/Refund window/);

  // The listing-type switch.
  const types = page.getByRole('radiogroup', { name: 'Listing type' });
  for (const name of ['Access listing', 'Strategy subscription']) await expect(types.getByRole('radio', { name })).toBeVisible(UNBUILT);
  // Four entry points, each linking to the room that owns it, or naming its blocker.
  const doors = page.getByRole('navigation', { name: 'Other marketplaces' });
  for (const [name, href] of [
    ['Spot copy trading', '/trade/copy'],
    ['Futures copy trading', '/trade/copy?tab=futures'],
    ['Bot marketplace', '/trade/bots'],
    ['Signal marketplace', null],
  ]) {
    const door = doors.getByRole('listitem').filter({ hasText: name });
    if (href) await expect(door.getByRole('link', { name })).toHaveAttribute('href', href);
    else await expect(door).toContainText(/Not built|blocked/i);
  }
  // Order by registration, price or title; returns is never offered.
  const sort = page.getByRole('combobox', { name: 'Sort' });
  await expect(sort.getByRole('option')).toHaveText(['Registration', 'Price', 'Title']);
});

test(`${J} #2 opens a listing by id: the seller profile, review summary and performance with its basis; an unknown id is not found`, async ({
  page,
}) => {
  await signIn(page, state('buyer'));
  await openListing(page, state('listingId'));
  const listing = page.getByRole('region', { name: 'Listing' });
  await expect(listing.getByRole('heading', { name: state('title') })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Seller' })).toContainText(state('seller').handle);
  await expect(listing.getByRole('region', { name: 'Reviews' })).toContainText(/No reviews yet|\d+ reviews?/);
  // A performance figure always says what it is measured on.
  await expect(listing.getByRole('region', { name: 'Performance' })).toContainText(/Basis:|Not reported/);

  await page.goto('/market?listing=00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('No listing has this id.')).toBeVisible();
});

test(`${J} #3 browses vendor listings of other kinds and sees premium placement: categories, lifecycle, and the placement labelled`, async ({
  page,
}) => {
  await signIn(page, state('buyer'));
  await page.goto('/market');
  const categories = page.getByRole('navigation', { name: 'Categories' });
  for (const name of ['Strategies', 'Signals', 'Data', 'Indicators'])
    await expect(categories.getByRole('link', { name })).toBeVisible(UNBUILT);
  await categories.getByRole('link', { name: 'Signals' }).click();
  // Every listing shows where it is in its lifecycle; a paid placement says so.
  for (const card of await listings(page).getByRole('row').all()) await expect(card).toContainText(/Draft|In review|Listed|Paused|Retired/);
  const placed = listings(page).getByText('Promoted placement');
  if (await placed.count()) await expect(placed.first()).toBeVisible();
});

test(`${J} #4 presses Buy on the strategy: charged once into the held account, the record shows held, the seller sees nothing yet`, async ({
  page,
}) => {
  const buyer = state('buyer');
  const seller = state('seller');
  await signIn(page, buyer);
  const before = await (await api(buyer)).balances();
  const sellerBefore = await (await api(seller)).balances();
  await openListing(page, state('listingId'));
  await page.getByRole('button', { name: 'Buy' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: `Pay ${PRICE} USDT` })
    .click();
  await expect(page.getByText('Held until the refund window ends')).toBeVisible();
  const after = await (await api(buyer)).balances();
  expect(toUnits(before.USDT.free) - toUnits(after.USDT.free)).toBe(toUnits(PRICE));
  const mine = await purchasesOf(buyer);
  expect(mine).toHaveLength(1);
  expect(mine[0].status).toBe('held');
  run.write({ purchaseId: mine[0].id });
  expect((await (await api(seller)).balances()).USDT.free).toBe(sellerBefore.USDT.free);
});

test(`${J} #5 presses Buy again, or loses the reply: one purchase, and the screen re-reads the stored state`, async ({ page }) => {
  const buyer = state('buyer');
  const purchaseId = state('purchaseId');
  await signIn(page, buyer);
  await openListing(page, state('listingId'));
  // Already bought: the page shows the stored purchase and no second Buy.
  await expect(page.getByRole('button', { name: 'Buy' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open your purchase' })).toHaveAttribute('href', new RegExp(purchaseId));
  // The same buy sent again, as a lost reply's retry would: the same purchase, nothing charged.
  const before = await (await api(buyer)).balances();
  const again = await (await api(buyer)).post('/api/market/trpc/purchases.create', { listingId: state('listingId') });
  expect(again.body?.result?.data?.id ?? JSON.stringify(again.body)).toBe(purchaseId);
  expect((await (await api(buyer)).balances()).USDT.free).toBe(before.USDT.free);
  expect(await purchasesOf(buyer)).toHaveLength(1);
});

test(`${J} #6 requests a refund inside the window: the amount comes back once`, async ({ page }) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await page.goto('/market/purchases');
  const row = page.getByRole('row', { name: new RegExp(state('title')) });
  const before = await (await api(buyer)).balances();
  await row.getByRole('button', { name: 'Ask for a refund' }).click(UNBUILT);
  await page.getByRole('dialog').getByRole('button', { name: 'Ask for a refund' }).click();
  await expect(row).toContainText('Refunded');
  const after = await (await api(buyer)).balances();
  expect(toUnits(after.USDT.free) - toUnits(before.USDT.free)).toBe(toUnits(PRICE));
  // A second refund changes nothing.
  await expect(row.getByRole('button', { name: 'Ask for a refund' })).toHaveCount(0);
});

test(`${J} #7 after a settled purchase, writes a review: one stored, a second refused, a visitor with no purchase refused`, async ({
  page,
}) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await openListing(page, state('listingId'));
  const box = page.getByRole('form', { name: 'Write a review' });
  await box.getByLabel('Rating').selectOption('4', UNBUILT);
  await box.getByLabel('Review').fill('TEST review from the market journey.');
  await box.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('region', { name: 'Reviews' })).toContainText('TEST review from the market journey.');
  await expect(box.getByText('You have already reviewed this listing.')).toBeVisible();

  // The seller bought nothing, so may not review.
  await signOutBrowser(page.context());
  await signIn(page, state('seller'));
  await openListing(page, state('listingId'));
  await expect(page.getByText('Only a buyer whose purchase settled can review.')).toBeVisible();
});

test(`${J} #8 opens /market/purchases: price, window and status; a pending settlement is not shown as a receipt`, async ({ page }) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await page.goto('/market/purchases');
  await expect(page.getByRole('heading', { name: 'Market purchases', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(state('title')) });
  await expect(row).toContainText(`${PRICE} USDT`);
  await expect(row).toContainText(/Refund window/);
  await expect(row).toContainText(/Held|Refunded|Released/);
  // Only a settled purchase offers a receipt.
  if (!/Released/.test(await row.innerText())) await expect(row.getByRole('link', { name: /receipt/i })).toHaveCount(0);
});
