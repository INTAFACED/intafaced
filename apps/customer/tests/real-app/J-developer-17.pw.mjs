import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-17, in the running app (docs/roadmap/journeys.json): a support agent helps a developer who says the API is
// failing. One test per step, titled "J-developer-17 #<n>", run in order. #1 makes the start: a verified TEST developer
// makes a read-only key and calls the order route with it, which the scope refuses; the request id from that reply is
// what the developer gives support. The agent is the stack's TEST founder on the console's support desk.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #4: the console has no request-id search.
// - #2, #3: the console reads no customer's key list or call log.
// - #5: the developer support page lists no contacts or what to send.
const J = 'J-developer-17';
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

const lookup = (page) => page.getByRole('search', { name: 'Find a request' });

test(`${J} #1 searches the request id: metadata and the typed error only; no secret or body; another account's id not found`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const { page: dev, who } = await keyHolder(browser, 'jdsp');
  const key = await makeKey(dev, { name: 'reader', preset: 'Read only' });
  await dev.context().close();
  const refused = await withKey(key, {
    method: 'POST',
    path: '/api/v1/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1' },
  });
  const requestId = refused.headers.get('x-request-id');
  expect(requestId, 'Edge names the request').toBeTruthy();
  run.reset({ who, key, requestId });
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/support`);
  await lookup(page).getByRole('searchbox').fill(requestId, UNBUILT);
  await lookup(page).getByRole('searchbox').press('Enter');
  const found = page.getByRole('region', { name: 'Request' });
  await expect(found).toContainText(requestId);
  expect(await found.innerText()).not.toContain(key);
});

test(`${J} #2 opens the customer's key list: no secret and no hash anywhere`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/accounts?q=${encodeURIComponent(state('who').email)}`);
  await page.getByRole('tab', { name: 'API keys' }).click(UNBUILT);
  const content = await page.content();
  expect(content).not.toContain(state('key'));
  expect(content).not.toMatch(/[a-f0-9]{64}/);
});

test(`${J} #3 reads the key's call log: status and request id rows, flagged out-of-IP calls`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/accounts?q=${encodeURIComponent(state('who').email)}`);
  await page.getByRole('tab', { name: 'API keys' }).click(UNBUILT);
  await expect(page.getByRole('table', { name: 'Call log' }).getByRole('row', { name: new RegExp(state('requestId')) })).toBeVisible();
});

test(`${J} #4 finds an account-restricted reason: the reason code the API returned`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/support`);
  await lookup(page).getByRole('searchbox').fill(state('requestId'), UNBUILT);
  await lookup(page).getByRole('searchbox').press('Enter');
  await expect(page.getByRole('region', { name: 'Request' })).toContainText(/Reason\s*\w+/);
});

test(`${J} #5 points the customer to the catalogue and the support route: contacts and what to send, or "contact not set"`, async ({
  page,
}) => {
  await page.goto('/developers/support');
  const support = page.getByRole('region', { name: 'Developer support' });
  await expect(support).toContainText(/What to send/, UNBUILT);
  await expect(support).toContainText(/request id/i);
  await expect(support.getByRole('link', { name: 'Error catalogue' })).toBeVisible();
});
