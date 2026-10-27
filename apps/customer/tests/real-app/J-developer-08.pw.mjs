import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-08, in the running app (docs/roadmap/journeys.json): see what my key did. One test per step, titled
// "J-developer-08 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey makes a read-only key
// bound to one IP, then makes three calls with it: one allowed, one denied by its scope (an order) and one from outside
// its IP list (sent through the stack's TEST forwarded-for header, which Edge trusts only on the local stack).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #5: the key detail has no call log (status, request id, IP flag, filters, Refresh) and no usage.
const J = 'J-developer-08';
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

const log = (page) => page.getByRole('table', { name: 'Call log' });

/** The key's detail page for its holder. */
async function openDetail(browser) {
  const page = await holderAgain(browser, state('who'));
  await page.goto(`/uc/safe/api-keys/${encodeURIComponent(state('keyId'))}`);
  return page;
}

test(`${J} #1 opens /uc/safe/api-keys/<keyId>: the key detail with its call log`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdc');
  const key = await makeKey(page, { name: 'reader', preset: 'Read only', ips: '127.0.0.1' });
  await withKey(key, { path: '/api/v1/account/balance' });
  await withKey(key, {
    method: 'POST',
    path: '/api/v1/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1' },
  });
  await withKey(key, { path: '/api/v1/account/balance', headers: { 'x-forwarded-for': '203.0.113.99' } });
  await page.goto('/uc/safe/api-keys');
  await page.getByTestId('api-keys__table').locator('tbody tr').filter({ hasText: 'reader' }).getByRole('link').first().click();
  const keyId = page.url().split('/').at(-1);
  run.reset({ who, keyId });
  await expect(log(page)).toBeVisible(UNBUILT);
  await page.context().close();
});

test(`${J} #2 reads the three rows: status and request id; no body or header value; the outside-IP call flagged`, async ({ browser }) => {
  const page = await openDetail(browser);
  const rows = log(page).locator('tbody tr');
  await expect(rows).toHaveCount(3, UNBUILT);
  for (const row of await rows.all()) await expect(row).toContainText(/\b(200|403)\b.*req_[\w-]+|req_[\w-]+.*\b(200|403)\b/);
  await expect(rows.filter({ hasText: 'Outside the IP list' })).toHaveCount(1);
  expect(await log(page).innerText()).not.toMatch(/authorization|Bearer|ifc_/i);
});

test(`${J} #3 filters by status and date and presses Refresh: only matching rows; the as-of time updates`, async ({ browser }) => {
  const page = await openDetail(browser);
  await page.getByLabel('Status').selectOption('Denied', UNBUILT);
  await expect(log(page).locator('tbody tr')).toHaveCount(1);
  const before = await page.getByTestId('as-of').innerText();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('as-of')).not.toHaveText(before);
});

test(`${J} #4 opens the log of someone else's key: refused`, async ({ browser }) => {
  const { page } = await keyHolder(browser, 'jdc4');
  await page.goto(`/uc/safe/api-keys/${encodeURIComponent(state('keyId'))}`);
  await expect(page.getByText('No key with this id on your account.')).toBeVisible(UNBUILT);
});

test(`${J} #5 reads used and remaining limits: usage with an as-of time`, async ({ browser }) => {
  const page = await openDetail(browser);
  await expect(page.getByRole('region', { name: 'Usage' })).toContainText(/Used\s*\d+.*Remaining\s*\d+/s, UNBUILT);
});
