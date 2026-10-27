import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-24, in the running app (docs/roadmap/journeys.json): ask the quote desk at /otc for a firm price on a
// large trade and settle it. One test per step, titled "J-copy-bots-otc-24 #<n>". The trader is a TEST account on the
// local stack, verified and funded with TEST USDT through the real ledger; accept binds the quoted price and size,
// settle posts once and expiry moves nothing, which the steps check against the ledger balance.
// The region-block clause of #1 and the settlement name-match clause of #3 are compliance gates and wait for launch
// prep (owner decision 2026-10-27); the level gate of #3 stays (identity verification).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The desk's law is blank on the stack: no asset list, providers, provider cap, level gate, minimum notional or
//   deferral window are published, so a request is refused before a quote is priced (CB-otc-01, -07, -08, -11).
// - #5: no RFQ board grouped by status (CB-otc-02); #8: no re-price of an expired quote; #9: Convert has no OTC price (CB-otc-12).
const J = 'J-copy-bots-otc-24';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const desk = (page) => page.getByRole('region', { name: 'Desk status' });
const request = (page) => page.getByRole('region', { name: 'Request a price' });
const card = (page) => page.getByRole('region', { name: 'Quote', exact: true });
const dialog = (page) => page.getByRole('dialog');
const balances = async () => (await api(run.read().who)).balances();

async function openOtc(page) {
  await signIn(page, run.read().who);
  await page.goto('/otc');
  await expect(desk(page)).toBeVisible();
}

/** Asks for a price on `quantity` BTC and returns the open quote card. */
async function ask(page, quantity = '0.5') {
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill(quantity, UNBUILT);
  await page.getByRole('button', { name: 'Request price' }).click(UNBUILT);
  await expect(card(page)).toBeVisible(UNBUILT);
  await expect(card(page).getByTestId('phase-line')).toContainText('firm');
  return card(page);
}

test(`${J} starts: a verified TEST account with 50000 USDT`, async ({ page }) => {
  test.setTimeout(180_000);
  run.reset({ who: await fundedTrader(page, 'ot', '50000') });
});

test(`${J} #1 opens OTC: the overview and the owner's asset list, "Not set" when blank`, async ({ page }) => {
  await openOtc(page);
  const assets = page.getByRole('region', { name: 'Assets on the desk' });
  await expect(assets).toBeVisible(UNBUILT);
  await expect(assets).toContainText(/Not set|BTC/);
});

test(`${J} #2 requests a quote with no provider set, then from four providers when three are allowed: "No providers set" refuses, and the cap refusal names the limit`, async ({
  page,
}) => {
  await openOtc(page);
  const providers = request(page).getByRole('group', { name: 'Providers' });
  await expect(providers).toBeVisible(UNBUILT);
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill('0.5', UNBUILT);
  await page.getByRole('button', { name: 'Request price' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/No providers set|at most \d+ providers/);
});

test(`${J} #3 requests as a user below the owner's level: refused, and no quote is priced`, async ({ page }) => {
  test.setTimeout(180_000);
  const unverified = await signUp(page, 'ou');
  await signIn(page, unverified);
  await page.goto('/otc');
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill('0.5', UNBUILT);
  await page.getByRole('button', { name: 'Request price' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText('verification level', UNBUILT);
  await expect(card(page)).toHaveCount(0);
});

test(`${J} #4 requests below the desk minimum: refused with the minimum`, async ({ page }) => {
  await openOtc(page);
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill('0.00001', UNBUILT);
  await page.getByRole('button', { name: 'Request price' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/minimum of [\d.,]+ USDT/, UNBUILT);
});

test(`${J} #5 opens the RFQ board: grouped by status with counts, the best quote on top, equal quotes to the earlier`, async ({ page }) => {
  await openOtc(page);
  const board = page.getByRole('region', { name: 'Your requests' });
  for (const group of ['Open', 'Accepted', 'Settled', 'Expired']) {
    await expect(board.getByRole('heading', { name: new RegExp(`^${group} \\(\\d+\\)$`) })).toBeVisible(UNBUILT);
  }
});

test(`${J} #6 accepts a quote: bound (accepted, not settled) at the quoted price; an asserted other price is refused as last look`, async ({
  page,
}) => {
  await openOtc(page);
  const quote = await ask(page);
  const price = await quote.getByTestId('quote-price').textContent();
  await quote.getByRole('button', { name: 'Accept', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Accept at this price' }).click();
  await expect(quote.getByTestId('phase-line')).toContainText('Accepted, not settled');
  await expect(quote.getByTestId('quote-price')).toHaveText(price ?? '');
  run.write({ bound: await quote.getAttribute('data-quote-id') });
});

test(`${J} #7 settles later inside the deferral window: one settlement posts with its key; after the window it is refused; a blank window reads "Not set"`, async ({
  page,
}) => {
  const before = await balances();
  await openOtc(page);
  const quote = card(page);
  await expect(quote.getByTestId('settle-by')).toHaveText(/Settle by \d{1,2}:\d{2}|Not set/, UNBUILT);
  await quote.getByRole('button', { name: 'Settle', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Settle now' }).click();
  await expect(quote.getByTestId('phase-line')).toContainText('Settled. The trade is complete.');
  expect(await balances()).not.toEqual(before);
});

test(`${J} #8 lets a quote expire, then re-prices it: the old quote stays expired, a new RFQ exists, and balances are unchanged by the expiry`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openOtc(page);
  const quote = await ask(page);
  const before = await balances();
  await expect(quote.getByTestId('phase-line')).toContainText(/Expired|time is up/, { timeout: 120_000 });
  expect(await balances()).toEqual(before);
  await quote.getByRole('button', { name: 'Ask again' }).click();
  await expect(card(page).getByTestId('phase-line')).toContainText('firm');
});

test(`${J} #9 uses Convert for a large buy at the OTC price: the OTC price and settlement time; a blank bound refuses`, async ({
  page,
}) => {
  await signIn(page, run.read().who);
  await page.goto('/convert');
  await page
    .getByRole('textbox', { name: /Amount/ })
    .first()
    .fill('0.5', UNBUILT);
  await expect(page.getByTestId('convert-otc-price')).toContainText(/OTC price/, UNBUILT);
  await expect(page.getByTestId('convert-otc-price')).toContainText(/Settles/);
});
