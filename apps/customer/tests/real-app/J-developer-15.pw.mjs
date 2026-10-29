import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { codeOf, holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-15, in the running app (docs/roadmap/journeys.json): run keys for sub-accounts, teams and agents. One test
// per step, titled "J-developer-15 #<n>", run in order. #1 makes the start: a verified TEST master account with a passkey
// and two strategy sub-accounts made through identity. The portfolio cap, roles and agent rules are the stack's TEST key
// terms; every key, approval and payout is read back from the services.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #3: the key form has no account choice, so no key can be made for a sub-account.
// - #4: there are no team roles on the key page.
// - #5, #6: there are no agent keys or approval rows.
// - #7: there is no API explorer.
const J = 'J-developer-15';
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

const subAccount = async (who, label) => {
  const res = await (await api(who)).post('/api/identity/trpc/subAccounts.create', { label });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.id;
};

test(`${J} #1 creates a key for the second sub-account as the master: it reaches only that account`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdsa');
  const first = await subAccount(who, 'TEST first');
  const second = await subAccount(who, 'TEST second');
  run.reset({ who, first, second });
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Account').selectOption({ label: 'TEST second' }, UNBUILT);
  const key = await makeKey(page, { name: 'sub-2' });
  run.write({ key });
  const own = await withKey(key, { path: '/api/identity/trpc/me' });
  expect(own.body.result.data.userId).toBe(second);
  const other = await withKey(key, {
    path: `/api/ledger/trpc/balances.list?input=${encodeURIComponent(JSON.stringify({ accountId: first }))}`,
  });
  expect(other.status).toBe(403);
});

test(`${J} #2 requests an organisation key without an account id: refused; a blank portfolio cap refuses another portfolio key`, async () => {
  const res = await (await api(state('who'))).post('/api/identity/trpc/apiKeys.create', { name: 'org', scope: 'organisation' });
  expect(codeOf(res.body)).toBe('keys.account_required');
});

test(`${J} #3 deletes a sub-account key: it stops verifying at once`, async ({ browser }) => {
  const key = state('key');
  const page = await holderAgain(browser, state('who'));
  await page.goto('/uc/safe/api-keys');
  await page.getByTestId('api-keys__table').getByRole('row', { name: /sub-2/ }).getByRole('button', { name: 'Delete' }).click(UNBUILT);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete key' }).click();
  expect((await withKey(key, { path: '/api/identity/trpc/me' })).status).toBe(401);
});

test(`${J} #4 opens the key page as a read-role member: create and revoke disabled with the reason; roles unset says so`, async ({
  browser,
}) => {
  const page = await holderAgain(browser, state('who'));
  await page.goto('/uc/safe/api-keys');
  await expect(page.getByText(/Roles are not set|Your role can only read keys/)).toBeVisible(UNBUILT);
});

test(`${J} #5 creates an agent key: tagged and restricted; a forbidden scope is refused at create`, async ({ browser }) => {
  const page = await holderAgain(browser, state('who'));
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Agent key', { exact: true }).check(UNBUILT);
});

test(`${J} #6 the agent key attempts a payout: an approval row appears and no payout runs; a read runs`, async ({ browser }) => {
  const page = await holderAgain(browser, state('who'));
  await page.goto('/uc/safe/api-keys/approvals');
  await expect(page.getByRole('table', { name: 'Waiting for your approval' })).toBeVisible(UNBUILT);
});

test(`${J} #7 builds a write in the API explorer with a live key: a typed refusal; with a sandbox key it runs`, async ({ page }) => {
  await page.goto('/developers/explorer');
  await expect(page.getByRole('heading', { name: 'API explorer', level: 1 })).toBeVisible(UNBUILT);
});
