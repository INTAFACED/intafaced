import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-more-catalogue-02, in the running app (docs/roadmap/journeys.json): find a strategy in the Market and buy it. One test
// per step, titled "J-more-catalogue-02 #<n>". The buyer is a TEST account on the local stack, verified and funded with
// TEST USDT through the real ledger. The listing is the stack's TEST strategy listing with a refund window, approved by
// the stack's TEST operators. The purchase is held, then released or refunded once; the steps read the buyer's ledger
// balance to check each moves once.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack seeds no approved TEST strategy listing (`local-test-gates.mjs market-listing`, proposed), so #2 and #4
//   to #8 have nothing to open or buy.
// - #1: /market has no listing-type switch and no four entry points to the copy, bot and signal rooms (MC-market-01).
// - #3: no listings of other kinds and no placement label (RC-more-catalogue-18 to -20).
// - #6, #7: no refund or release after the window and no reviews (MC-market-01, -02).
const J = 'J-more-catalogue-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const LISTING = 'TEST strategy with a refund window';

test.describe.configure({ mode: 'default' });

const usdt = async (who) => (await (await api(who)).balances()).USDT ?? { free: '0', used: '0' };

async function openMarket(page) {
  await signIn(page, run.read().who);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
}

async function openListing(page) {
  await openMarket(page);
  const card = page.getByRole('article').filter({ hasText: LISTING });
  await expect(card).toBeVisible(UNBUILT);
  await card.getByRole('button', { name: /View/ }).click();
  return page.getByRole('dialog');
}

test(`${J} starts: a verified TEST account with 100 USDT, and the stack's TEST strategy listing approved`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'mk');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });
});

test(`${J} #1 opens /market: listings with terms, a listing-type switch and four entry points to their own rooms, ordered by registration, price or title, never by returns`, async ({
  page,
}) => {
  await openMarket(page);
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
  const listing = await openListing(page);
  await expect(listing.getByRole('region', { name: 'Seller' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Reviews' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Performance' })).toContainText(/Basis:/);
  await page.goto('/market/listing/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('main')).toContainText('No listing has this id.');
});

test(`${J} #3 browses vendor listings of other kinds (signals, data, indicators) and sees premium placement: the category taxonomy and lifecycle for every kind, and placement labelled`, async ({
  page,
}) => {
  await openMarket(page);
  const kinds = page.getByRole('combobox', { name: 'Category' });
  await expect(kinds).toBeVisible(UNBUILT);
  for (const kind of ['Signals', 'Data', 'Indicators']) await expect(kinds.getByRole('option', { name: kind })).toBeAttached();
  const placed = page.getByRole('article').filter({ has: page.getByText('Promoted placement') });
  for (const card of await placed.all()) await expect(card.getByText('Promoted placement')).toBeVisible();
});

test(`${J} #4 presses Buy on the strategy: the charge into the held account once, the record shows held, and the seller sees nothing yet`, async ({
  page,
}) => {
  const { who } = run.read();
  const before = await usdt(who);
  const listing = await openListing(page);
  const price = /([\d.]+) USDT/.exec((await listing.getByRole('group', { name: 'Price' }).textContent()) ?? '')?.[1];
  expect(price).toBeTruthy();
  await listing.getByRole('button', { name: 'Buy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm purchase' }).click();
  await expect(page.getByRole('status')).toContainText('Held until the refund window ends');
  expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) - toUnits(price));
  run.write({ price });
});

test(`${J} #5 presses Buy again, or loses the reply: one purchase, and the screen re-reads the stored state`, async ({ page }) => {
  const { who, price } = run.read();
  expect(price, 'a purchase from #4').toBeTruthy();
  const before = await usdt(who);
  const listing = await openListing(page);
  await expect(listing.getByRole('button', { name: 'Buy' })).toBeDisabled();
  await expect(listing).toContainText('You own this. Held until the refund window ends.');
  await page.goto('/market/purchases');
  await expect(tableIn(page, 'Your purchases').getByRole('row', { name: new RegExp(LISTING) })).toHaveCount(1);
  expect(await usdt(who)).toEqual(before);
});

test(`${J} #6 requests a refund inside the window: the amount returns once; with the refund policy undecided the refund shows its named blocker`, async ({
  page,
}) => {
  const { who, price } = run.read();
  expect(price, 'a purchase from #4').toBeTruthy();
  const before = await usdt(who);
  await signIn(page, who);
  await page.goto('/market/purchases');
  const row = tableIn(page, 'Your purchases').getByRole('row', { name: new RegExp(LISTING) });
  await row.getByRole('button', { name: 'Ask for a refund' }).click(UNBUILT);
  await page.getByRole('dialog').getByRole('button', { name: 'Refund' }).click();
  const said = page.getByRole('status').or(page.getByRole('alert'));
  await expect(said).toContainText(/Refunded|refund policy is not decided/);
  if (/Refunded/.test((await said.textContent()) ?? '')) {
    expect(toUnits((await usdt(who)).free)).toBe(toUnits(before.free) + toUnits(price));
    await expect(row).toContainText('Refunded');
  } else {
    expect(await usdt(who)).toEqual(before);
  }
});

test(`${J} #7 writes a review after a settled purchase: one review stored, a second refused as already reviewed, and a visitor with no purchase refused`, async ({
  page,
}) => {
  const listing = await openListing(page);
  await listing.getByRole('button', { name: 'Write a review' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'Your review' });
  await form.getByRole('textbox', { name: 'Review' }).fill('TEST review');
  await form.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('status')).toContainText('Review posted');
  await listing.getByRole('button', { name: 'Write a review' }).click();
  await expect(page.getByRole('alert')).toContainText('You have already reviewed this listing.');
});

test(`${J} #8 opens /market/purchases: price, window and status for each; a pending settlement is not shown as a receipt`, async ({
  page,
}) => {
  await signIn(page, run.read().who);
  await page.goto('/market/purchases');
  const table = tableIn(page, 'Your purchases');
  await expect(table).toBeVisible(UNBUILT);
  for (const column of ['Price', 'Refund window', 'Status']) await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  for (const row of await bodyRows(table).all()) {
    if (/Held|Pending/.test(await row.innerText())) await expect(row.getByRole('link', { name: 'Receipt' })).toHaveCount(0);
  }
});
