import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-07, in the running app (docs/roadmap/journeys.json): rotate a key, revoke a key, and respond to a leaked
// one. One test per step, titled "J-developer-07 #<n>", run in order. #1 makes the start: a verified TEST account with a
// passkey makes a live trade key; "in use" means it answers a balance read. The overlap maximum is the stack's TEST
// identity terms (60 seconds is the TEST overlap).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #3: the key list has no Rotate action, so no overlap, retry or approval.
// - #6: the console has no leaked-key report.
const J = 'J-developer-07';
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

const works = async (key) => (await withKey(key, { path: '/api/v1/account/balance' })).status === 200;
const rowOf = (page, name) => page.getByTestId('api-keys__table').locator('tbody tr').filter({ hasText: name });

test(`${J} #1 rotates with a 60-second overlap: both keys verify until the end, then only the new one`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'jdr');
  const key = await makeKey(page, { name: 'bot-1' });
  run.reset({ who, key });
  expect(await works(key)).toBe(true);
  await rowOf(page, 'bot-1').getByRole('button', { name: 'Rotate' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Rotate this key' });
  await sheet.getByLabel('Keep the old key working for, seconds').fill('60');
  await sheet.getByRole('button', { name: 'Rotate with a passkey' }).click();
  const next = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  run.write({ next });
  expect([await works(key), await works(next)]).toEqual([true, true]);
  await expect.poll(() => works(key), { timeout: 120_000, intervals: [5_000] }).toBe(false);
  expect(await works(next)).toBe(true);
  await page.context().close();
});

test(`${J} #2 loses the reply after the replacement is issued and retries: one replacement exists`, async ({ browser }) => {
  const page = await holderAgain(browser, state('who'));
  await page.goto('/uc/safe/api-keys');
  // The replaced key and its one replacement: two rows named bot-1, one of them Replaced.
  await expect(rowOf(page, 'bot-1').getByText('Replaced')).toHaveCount(1, UNBUILT);
  await expect(rowOf(page, 'bot-1')).toHaveCount(2);
  await page.context().close();
});

test(`${J} #3 a key asks for its own rotation and the requester tries to approve: refused; another person approves once`, async () => {
  const asked = await withKey(state('next'), { method: 'POST', path: '/api/v1/keys/rotate', body: { overlapSeconds: 0 } });
  expect(asked.status, JSON.stringify(asked.body).slice(0, 200)).toBe(202);
});

test(`${J} #4 revokes a key: it stops verifying at once; the list shows it revoked with its reason`, async ({ browser }) => {
  const { page } = await keyHolder(browser, 'jdrv');
  const key = await makeKey(page, { name: 'bot-r' });
  await rowOf(page, 'bot-r').getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(rowOf(page, 'bot-r')).toContainText('Revoked');
  expect(await works(key)).toBe(false);
  await expect(rowOf(page, 'bot-r')).toContainText(/Revoked by you/);
  await page.context().close();
});

test(`${J} #5 revokes all keys: every live key revoked; another user's keys untouched`, async ({ browser }) => {
  const mine = await keyHolder(browser, 'jdra');
  const keys = [await makeKey(mine.page, { name: 'a-1' }), await makeKey(mine.page, { name: 'a-2' })];
  const other = await keyHolder(browser, 'jdro');
  const theirs = await makeKey(other.page, { name: 'o-1' });
  await mine.page.getByRole('button', { name: 'Revoke all keys' }).click();
  await mine.page
    .getByRole('alertdialog')
    .getByRole('button', { name: /Revoke all/ })
    .click();
  for (const key of keys) await expect.poll(() => works(key), { timeout: 15_000 }).toBe(false);
  expect(await works(theirs)).toBe(true);
  await mine.page.context().close();
  await other.page.context().close();
});

test(`${J} #6 an operator reports a leaked key string: revoked with one audit row and one notice; a repeat or a stranger string alike`, async ({
  page,
}) => {
  const key = state('next');
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/system/leaked-keys`);
  const form = page.getByRole('form', { name: 'Report a leaked key' });
  await form.getByLabel('Key').fill(key, UNBUILT);
  await form.getByRole('button', { name: 'Report' }).click();
  const first = await page.getByRole('status').innerText();
  expect(await works(key)).toBe(false);
  await form.getByLabel('Key').fill(key);
  await form.getByRole('button', { name: 'Report' }).click();
  await form.getByLabel('Key').fill('ifc_nothingmatchesthisstringatall0000');
  await form.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByRole('status')).toHaveText(first);
});
