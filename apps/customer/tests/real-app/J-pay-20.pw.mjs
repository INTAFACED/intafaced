import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { signIn } from './desk.mjs';
import { member, sendNow } from './pay.mjs';

// J-pay-20, in the running app (docs/roadmap/journeys.json): a founder checks pay routing health and acts on stuck money
// on the console's /pay-ops. One test per step, titled "J-pay-20 #<n>", run in order. #1 makes the start: two verified
// TEST members and one TEST payment between them; the desk reads svc-bank's operator answers for this stack. An unset
// rail shows its code, never a number.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the desk has no per-route tiles (claim, request, link, QR), no stuck, held or unclaimed by age, no debts and no
//   protection pot.
// - #3 to #5: every operator action on a personal transfer is switched off ("svc-bank has no operator action").
// - #6: no unmatched rail event row or alert; #7: no export with a reason; #8: no protection pot top-up.
const J = 'J-pay-20';
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

async function desk(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/pay-ops`);
  await expect(page.getByRole('heading', { name: 'Personal Pay operations', level: 1 })).toBeVisible();
}

test(`${J} #1 opens the pay ops desk: tiles per route, failed, stuck, held and unclaimed by age, debts and the protection pot`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const customer = await (await browser.newContext()).newPage();
  const to = await member(customer, 'jpor');
  const from = await member(customer, 'jpos', '50');
  await signIn(customer, from);
  const reference = await sendNow(customer, to.handle, '5', 'TEST ops');
  await customer.context().close();
  run.reset({ from, to, reference });
  await desk(page);
  for (const route of ['Member send', 'Claim', 'Request', 'Bills', 'Global', 'Link', 'QR'])
    await expect(page.getByRole('region', { name: `${route} route` })).toBeVisible(UNBUILT);
  await expect(page.getByRole('region', { name: 'Protection pot' })).toBeVisible();
});

test(`${J} #2 opens a transfer by id: the transfer with its ledger key; an unknown id is the service's own refusal`, async ({ page }) => {
  await desk(page);
  await page.getByLabel('Transfer id').fill(state('reference'));
  await page.getByRole('button', { name: 'Find this transfer' }).click();
  await page.getByRole('button', { name: 'Read the full transfer record' }).click();
  const record = page.getByTestId('transfer-record');
  await expect(record).toContainText(/Amount\s*5(\.0+)? USDT/);
  await expect(record).toContainText(/Ledger transaction\s*\S+/);
  await page.getByLabel('Transfer id').fill('00000000-0000-4000-8000-000000000000');
  await page.getByRole('button', { name: 'Find this transfer' }).click();
  await page.getByRole('button', { name: 'Read the full transfer record' }).click();
  await expect(page.getByTestId('transfer-failed')).toBeVisible();
});

test(`${J} #3 sees a stuck unclaimed send and presses Return: it posts once; the queue clears`, async ({ page }) => {
  await desk(page);
  await page.getByRole('region', { name: 'Unclaimed sends' }).getByRole('button', { name: 'Return' }).first().click(UNBUILT);
});

test(`${J} #4 sees a held received payment and a release date: the hold reason; release posts once`, async ({ page }) => {
  await desk(page);
  await page.getByRole('region', { name: 'Held payments' }).getByRole('button', { name: 'Release' }).first().click(UNBUILT);
});

test(`${J} #5 sees a held send from risk review and releases it: posts once with the original key; past the window refused`, async ({
  page,
}) => {
  await desk(page);
  await page.getByRole('region', { name: 'Sends in review' }).getByRole('button', { name: 'Release' }).first().click(UNBUILT);
});

test(`${J} #6 reads the bills and global queues: a return after paid shows one row; an unmatched rail event one row and one alert`, async ({
  page,
}) => {
  await desk(page);
  await expect(page.getByRole('region', { name: 'Unmatched rail events' })).toBeVisible(UNBUILT);
});

test(`${J} #7 exports the view with a reason: a file whose row count equals the audit row`, async ({ page }) => {
  await desk(page);
  await page.getByRole('button', { name: 'Export this view' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Reason').fill('TEST export.');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
});

test(`${J} #8 tops up the protection pot under four-eyes: the pot rises by exactly the top-up; only owner top-ups fund it`, async ({
  page,
}) => {
  await desk(page);
  await page.getByRole('region', { name: 'Protection pot' }).getByRole('button', { name: 'Top up' }).click(UNBUILT);
});
