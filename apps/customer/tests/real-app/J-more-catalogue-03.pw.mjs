import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-03, in the running app (docs/roadmap/journeys.json): publish my strategy for others to subscribe to.
// One test per step, titled "J-more-catalogue-03 #<n>", run in order on one verified TEST seller. The commission, hold and
// review criteria are the stack's TEST market terms; every listing is read back from svc-market.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the house commission is unpublished on the stack, so the market refuses listing creation, and the form has no
//   refund window.
// - #2: no profit-share field or its refusal; #3: no applied state or review-criteria notice; #4: no rejection with a
//   reason; #5: no seller earnings, buyers or reviews; #6: no track-record panel.
const J = 'J-more-catalogue-03';
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

const trpc = (proc, input) => `/api/market/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const getListing = async (who, id) => (await (await api(who)).get(trpc('listings.get', { id }))).body?.result?.data;

/** Fills the strategy listing form on /market/strategy. */
async function fillListing(page, title, period = '2592000') {
  await page.goto('/market/strategy');
  await page.getByLabel('Listing title').fill(title);
  await page.getByLabel('Listing description').fill('TEST strategy subscription for the publishing journey.');
  await page.getByLabel('Price asset ID').fill('USDT');
  await page.getByLabel('Price', { exact: true }).fill('25');
  await page.getByLabel('Paid period in seconds').fill(period);
}

test(`${J} #1 opens /market/strategy and fills the listing: price, period, refund window; an unset period refused`, async ({ page }) => {
  test.setTimeout(240_000);
  const seller = await fundedTrader(page, 'jmps', '10');
  const title = `TEST strategy ${seller.handle}`;
  run.reset({ seller, title });
  await signIn(page, seller);
  await fillListing(page, title, '');
  await page.getByRole('button', { name: 'Review listing' }).click();
  await expect(page.getByText(/Enter a paid period/)).toBeVisible(UNBUILT);
  await fillListing(page, title);
  await page.getByLabel('Refund window in hours').fill('24');
  await page.getByRole('button', { name: 'Review listing' }).click();
  const created = page.waitForResponse((res) => res.url().includes('listings.create') && res.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish listing' }).click();
  const answer = await created;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  run.write({ listingId: (await answer.json()).result.data.id });
});

test(`${J} #2 adds a profit-share field: a typed refusal that a profit share is forbidden; a returns-ranked claim refused`, async ({
  page,
}) => {
  await signIn(page, state('seller'));
  await fillListing(page, `${state('title')} share`);
  await page.getByLabel('Profit share, %').fill('20', UNBUILT);
  await page.getByRole('button', { name: 'Review listing' }).click();
  await expect(page.getByText('A profit share isn’t allowed on a listing.')).toBeVisible();
  await page.getByLabel('Profit share, %').fill('');
  await page.getByLabel('Listing description').fill('Top returns of the month, 300% guaranteed.');
  await page.getByRole('button', { name: 'Review listing' }).click();
  await expect(page.getByText(/claim about returns/i)).toBeVisible();
});

test(`${J} #3 submits for review: applied, absent from the public list, shows "applied"; blank review criteria said so`, async ({
  page,
}) => {
  const seller = state('seller');
  const listing = await getListing(seller, state('listingId'));
  expect(listing.status).toBe('applied');
  await signIn(page, seller);
  await page.goto('/market?tab=mine');
  await expect(page.getByRole('row', { name: new RegExp(state('title')) })).toContainText('Applied', UNBUILT);
  await expect(page.getByText(/Review criteria\s*Not set/)).toBeVisible();
  await page.goto('/market');
  await expect(page.getByRole('region', { name: 'Browse listings' }).getByRole('row', { name: new RegExp(state('title')) })).toHaveCount(0);
});

test(`${J} #4 a rejection with a reason arrives: the seller sees the reason and can resubmit`, async ({ page, browser }) => {
  const founder = await (await browser.newContext()).newPage();
  await founderSignIn(founder, 'a');
  await founder.goto(`${ADMIN}/more-ops/market`);
  const row = founder.getByRole('row', { name: new RegExp(state('title')) });
  await row.getByRole('button', { name: 'Reject' }).click(UNBUILT);
  await founder.getByRole('dialog').getByLabel('Reason').fill('TEST: add the strategy’s risk notes.');
  await founder.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  await founder.context().close();
  await signIn(page, state('seller'));
  await page.goto('/market?tab=mine');
  const mine = page.getByRole('row', { name: new RegExp(state('title')) });
  await expect(mine).toContainText('TEST: add the strategy’s risk notes.');
  await expect(mine.getByRole('button', { name: 'Resubmit' })).toBeEnabled();
});

test(`${J} #5 once approved, opens my listing: visible in the list; seller earnings, buyers and reviews`, async ({ page }) => {
  await signIn(page, state('seller'));
  await page.goto(`/market?listing=${encodeURIComponent(state('listingId'))}`);
  const listing = page.getByRole('region', { name: 'Listing' });
  await expect(listing.getByRole('region', { name: 'Seller earnings' })).toBeVisible(UNBUILT);
  await expect(listing.getByRole('region', { name: 'Buyers' })).toBeVisible();
  await expect(listing.getByRole('region', { name: 'Reviews' })).toBeVisible();
});

test(`${J} #6 looks at the track-record panel: fills from the store only; the profit-share option disabled and said so`, async ({
  page,
}) => {
  await signIn(page, state('seller'));
  await page.goto('/market/strategy');
  const panel = page.getByRole('region', { name: 'Track record' });
  await expect(panel).toContainText(/From your stored fills|No fills yet/, UNBUILT);
  await expect(page.getByRole('checkbox', { name: 'Profit share' })).toBeDisabled();
  await expect(page.getByText('A profit share isn’t offered.')).toBeVisible();
});
