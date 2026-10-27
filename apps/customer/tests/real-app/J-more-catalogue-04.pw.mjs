import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-04, in the running app (docs/roadmap/journeys.json): founders review market listings on the console's
// /more-ops/market. One test per step, titled "J-more-catalogue-04 #<n>", run in order. #1 makes the start: a verified
// TEST seller applies three strategy listings through /market/strategy; the review criteria are the stack's TEST market
// terms. The public list is read on the customer app.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the house commission is unpublished on the stack, so listing creation is refused; the console has no market
//   review queue (approve with two founders, reject with a reason, take down).
const J = 'J-more-catalogue-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function queue(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/more-ops/market`);
  const table = page.getByRole('table', { name: 'Listings to review' });
  await expect(table).toBeVisible(UNBUILT);
  return table;
}

const publicRow = (page, title) => page.getByRole('region', { name: 'Browse listings' }).getByRole('row', { name: new RegExp(title) });

test(`${J} #1 opens the review queue: applied listings with seller, terms and criteria; blank criteria show the queue waiting`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const seller = await fundedTrader(page, 'jmrq', '10');
  const titles = ['approve', 'reject', 'take down'].map((what) => `TEST ${what} ${seller.handle}`);
  run.reset({ seller, titles });
  await signIn(page, seller);
  for (const title of titles) {
    await page.goto('/market/strategy');
    await page.getByLabel('Listing title').fill(title);
    await page.getByLabel('Listing description').fill('TEST listing for the review journey.');
    await page.getByLabel('Price asset ID').fill('USDT');
    await page.getByLabel('Price', { exact: true }).fill('25');
    await page.getByLabel('Paid period in seconds').fill('2592000');
    await page.getByRole('button', { name: 'Review listing' }).click(UNBUILT);
    await page.getByRole('dialog').getByRole('button', { name: 'Publish listing' }).click();
  }
  const founder = await (await browser.newContext()).newPage();
  const table = await queue(founder);
  for (const title of titles) {
    const row = table.getByRole('row', { name: new RegExp(title) });
    await expect(row).toContainText(seller.handle);
    await expect(row).toContainText('25 USDT');
  }
  await expect(founder.getByText(/Review criteria\s*(Not set|.+)/)).toBeVisible();
  await founder.context().close();
});

test(`${J} #2 approves alone: a typed refusal needing a second founder`, async ({ page }) => {
  const table = await queue(page, 'a');
  const row = table.getByRole('row', { name: new RegExp(state('titles')[0]) });
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Waiting for a second founder');
});

test(`${J} #3 a second founder approves: approved, in the public list, with an audit row`, async ({ page, browser }) => {
  const title = state('titles')[0];
  const table = await queue(page, 'b');
  const row = table.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Approved');
  await page.goto(`${ADMIN}/audit?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole('row', { name: /listing.approve/ }).first()).toBeVisible();
  const customer = await (await browser.newContext()).newPage();
  await signIn(customer, state('seller'));
  await customer.goto('/market');
  await expect(publicRow(customer, title)).toBeVisible();
  await customer.context().close();
});

test(`${J} #4 rejects another with a reason: the seller sees the reason`, async ({ page, browser }) => {
  const title = state('titles')[1];
  const founder = await (await browser.newContext()).newPage();
  const table = await queue(founder);
  await table
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: 'Reject' })
    .click();
  await founder.getByRole('dialog').getByLabel('Reason').fill('TEST: the description names no risks.');
  await founder.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await founder.context().close();
  await signIn(page, state('seller'));
  await page.goto('/market?tab=mine');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText('TEST: the description names no risks.');
});

test(`${J} #5 takes down an approved listing: it leaves the public list and the reason shows in the audit`, async ({ page, browser }) => {
  const title = state('titles')[0];
  const founder = await (await browser.newContext()).newPage();
  const table = await queue(founder);
  await table
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: 'Take down' })
    .click();
  await founder.getByRole('dialog').getByLabel('Reason').fill('TEST take-down.');
  await founder.getByRole('dialog').getByRole('button', { name: 'Take down' }).click();
  await founder.goto(`${ADMIN}/audit?q=${encodeURIComponent(title)}`);
  await expect(founder.getByRole('row', { name: /TEST take-down\./ })).toBeVisible();
  await founder.context().close();
  await signIn(page, state('seller'));
  await page.goto('/market');
  await expect(publicRow(page, title)).toHaveCount(0);
});
