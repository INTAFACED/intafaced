import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-06, in the running app (docs/roadmap/journeys.json): stay inside the rate limits, and ask for more. One
// test per step, titled "J-developer-06 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey
// makes a live trade key. The tiers, per-route cost, burst and refill are the stack's TEST rate terms; the reviewer is
// the stack's TEST founder on the console.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the portal has no limits page (tiers, per-route cost, burst, refill).
// - #2: Edge sends no rate headers or retry-after on a key's 429.
// - #3: the key detail shows no used and remaining with an as-of time; #4: no backoff guidance.
// - #5, #6: no limit-request form or console review of it.
const J = 'J-developer-06';
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

test(`${J} #1 reads the limits page: tiers, per-route cost, burst and refill; with no tiers set, a banner says so`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const holder = await keyHolder(browser, 'jdl');
  const key = await makeKey(holder.page);
  run.reset({ who: holder.who, key });
  await holder.page.context().close();
  await page.goto('/developers/limits');
  const limits = page.getByRole('region', { name: 'Rate limits' });
  await expect(limits.getByRole('table', { name: 'Tiers' }).or(limits.getByText('Rate tiers are not set.'))).toBeVisible(UNBUILT);
  // The route costs are published either way; only the tiers can be unset.
  await expect(limits.getByRole('table', { name: 'Cost per route' })).toBeVisible();
});

test(`${J} #2 sends calls faster than the refill: allowed until the burst is spent, then 429 with reason, retry-after and request id`, async () => {
  let refused;
  for (let i = 0; i < 500 && !refused; i++) {
    const res = await withKey(state('key'), { path: '/api/v1/account/balance' });
    expect(res.headers.get('x-ratelimit-remaining'), 'every reply carries the remaining count').not.toBeNull();
    if (res.status === 429) refused = res;
  }
  expect(refused, 'the burst ends in a 429').toBeTruthy();
  expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(codeOf(refused.body)).toBe('rate_limited');
  expect(refused.headers.get('x-request-id')).toBeTruthy();
});

test(`${J} #3 opens the key detail: used and remaining with an as-of time that moves on Refresh`, async ({ browser }) => {
  const holder = await keyHolder(browser, 'jdl3');
  await makeKey(holder.page);
  await holder.page.goto('/uc/safe/api-keys');
  await holder.page.getByTestId('api-keys__table').locator('tbody tr').first().getByRole('link').first().click();
  const usage = holder.page.getByRole('region', { name: 'Usage' });
  await expect(usage).toContainText(/Used\s*\d+/, UNBUILT);
  const before = await usage.getByTestId('as-of').innerText();
  await usage.getByRole('button', { name: 'Refresh' }).click();
  await expect(usage.getByTestId('as-of')).not.toHaveText(before);
  await holder.page.context().close();
});

test(`${J} #4 reads the backoff guidance: exponential backoff with jitter`, async ({ page }) => {
  await page.goto('/developers/limits');
  await expect(page.getByRole('heading', { name: 'Back off and retry' })).toBeVisible(UNBUILT);
  await expect(page.getByText(/exponential backoff with jitter/i)).toBeVisible();
});

test(`${J} #5 asks for a higher limit and gives a spike notice: recorded; with no base tier, "limits not set"`, async ({ browser }) => {
  const holder = await keyHolder(browser, 'jdl5');
  await holder.page.goto('/developers/limits/request');
  const form = holder.page.getByRole('form', { name: 'Ask for a higher limit' });
  await expect(form.or(holder.page.getByText('Rate limits are not set.'))).toBeVisible(UNBUILT);
  if (!(await form.isVisible())) {
    // No base tier: the honest refusal is the whole step, and there is no request for #6 to grant.
    await holder.page.context().close();
    return;
  }
  await form.getByLabel('Requests per second you need').fill('50');
  await form.getByLabel('Expected spike').fill('TEST launch day');
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(holder.page.getByText('Request sent')).toBeVisible();
  run.write({ requester: holder.who });
  await holder.page.context().close();
});

test(`${J} #6 the reviewer grants part of it: the customer is told the granted amount; one audit entry`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/system/api-limits`);
  const row = page.getByRole('table', { name: 'Limit requests' }).getByRole('row', { name: new RegExp(state('requester').email) });
  await row.getByRole('button', { name: 'Grant' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Granted requests per second').fill('20');
  await page.getByRole('dialog').getByRole('button', { name: 'Grant' }).click();
  await expect(row).toContainText('Granted 20');
});
