import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';

// J-copy-bots-otc-11, in the running app (docs/roadmap/journeys.json): check that profit settlement and broker rebates
// match the ledger. One test per step, titled "J-copy-bots-otc-11 #<n>", run in order, as the stack's TEST founder on the
// founder console (the finance view). The settlements read are the copy fee shares the copy journeys settled on this
// stack; the reconcile window and the broker hierarchy law are the stack's TEST values (the hierarchy law is left unset,
// so rebate figures read "Not set" and payout refuses).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no /trade-ops/copy/settlements or /trade-ops/broker room.
const J = 'J-copy-bots-otc-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

async function settlements(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/copy/settlements`);
  await expect(page.getByRole('heading', { name: 'Copy settlements', level: 1 })).toBeVisible(UNBUILT);
  return page.getByRole('table', { name: 'Settlements' });
}

/** Presses Reconcile and returns the counts it reports. */
async function reconcile(page) {
  await page.getByRole('button', { name: 'Reconcile' }).click();
  const result = page.getByRole('status', { name: 'Reconcile result' });
  await expect(result).toBeVisible();
  return (await result.innerText()).replace(/\s+/g, ' ');
}

test(`${J} #1 opens settlement oversight: "Settled" where a ledger post matches, "Held" with its key where it is missing`, async ({
  page,
}) => {
  run.reset({});
  const table = await settlements(page);
  await expect(
    table
      .locator('tbody tr')
      .filter({ hasText: /Settled|Held/ })
      .first(),
  ).toBeVisible();
  for (const row of await table.locator('tbody tr').all()) {
    const text = await row.innerText();
    if (/Held/.test(text)) expect(text).toMatch(/copy\.[a-z-]+:[\w-]+/);
    else expect(text).toMatch(/Settled/);
  }
});

test(`${J} #2 runs reconcile twice: the counts are the same both times`, async ({ page }) => {
  await settlements(page);
  await page.getByLabel('Window').selectOption({ label: 'Last 24 hours' });
  const first = await reconcile(page);
  const second = await reconcile(page);
  expect(second).toBe(first);
});

test(`${J} #3 runs reconcile with the window blank: refused`, async ({ page }) => {
  await settlements(page);
  await page.getByLabel('Window').selectOption({ label: 'Choose a window' });
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await expect(page.getByText('Choose a window to reconcile.')).toBeVisible();
});

test(`${J} #4 opens a follow's position accounting: oversight links to the fee-share and position rows`, async ({ page }) => {
  const table = await settlements(page);
  await table.locator('tbody tr').first().getByRole('link', { name: 'Open follow' }).click();
  await expect(page.getByRole('table', { name: 'Fee shares' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Positions' })).toBeVisible();
});

test(`${J} #5 opens the broker dashboard for two days: a daily table with decimal sums; rebates "Not set" and payout refused`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/broker`);
  const daily = page.getByRole('table', { name: 'Broker volume by day' });
  await expect(daily).toBeVisible(UNBUILT);
  for (const cell of await daily.getByRole('cell', { name: /^\d/ }).allInnerTexts()) expect(cell).toMatch(/^\d+(\.\d+)?/);
  await expect(daily).toContainText('Not set');
  await page.getByRole('button', { name: 'Pay rebates' }).click();
  await expect(page.getByText(/The rebate hierarchy is not set/)).toBeVisible();
});
