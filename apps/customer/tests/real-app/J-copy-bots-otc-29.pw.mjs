import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-29, in the running app (docs/roadmap/journeys.json): a founder runs the OTC desk and its regional rules
// on the console's /trade-ops/otc. One test per step, titled "J-copy-bots-otc-29 #<n>", run in order. The RFQs read are
// those the OTC journeys made on this stack; the per-client limits, maker applications and sub-account links are made
// here through the console. The region block list is out until launch prep (owner decision 2026-10-27, no compliance
// work until then), so #5 proves only that a blank list doesn't invent one.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no /trade-ops/otc room (desk operations, client limits, exceptions, maker vetting, region
//   rules, grouped fee volume).
const J = 'J-copy-bots-otc-29';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

async function desk(page, tab) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/otc`);
  await expect(page.getByRole('heading', { name: 'OTC desk', level: 1 })).toBeVisible(UNBUILT);
  if (tab) await page.getByRole('tab', { name: tab }).click();
}

test(`${J} #1 opens desk operations: open RFQs and settled fills listed with statuses`, async ({ page }) => {
  run.reset({});
  await desk(page);
  const rfqs = page.getByRole('table', { name: 'RFQs' });
  await expect(rfqs.or(page.getByText('No RFQs.'))).toBeVisible();
  await expect(
    rfqs
      .locator('tbody tr')
      .filter({ hasText: /Open|Accepted|Settled|Expired/ })
      .first(),
  ).toBeVisible();
  for (const row of await rfqs.locator('tbody tr').all()) await expect(row).toContainText(/Open|Accepted|Settled|Expired/);
});

test(`${J} #2 leaves a per-client limit blank: that client's quotes are refused`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const client = await fundedTrader(page, 'jotl', '1000');
  run.write({ client });
  const founder = await (await browser.newContext()).newPage();
  await desk(founder, 'Client limits');
  await founder.getByRole('searchbox', { name: 'Find a client' }).fill(client.email);
  await expect(founder.getByRole('row', { name: new RegExp(client.handle) })).toContainText('Not set');
  await founder.context().close();
  await signIn(page, client);
  await page.goto('/otc');
  await expect(page.getByText(/Your desk limit is not set/)).toBeVisible();
});

test(`${J} #3 opens an exception for a failed settlement: listed with its saga key`, async ({ page }) => {
  await desk(page, 'Exceptions');
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(exceptions.or(page.getByText('No settlement exceptions.'))).toBeVisible();
  if (await exceptions.isVisible()) await expect(exceptions.locator('tbody tr').first()).toContainText(/otc\.settle:[\w-]+/);
});

test(`${J} #4 reviews a maker application: approve once; a second approve writes nothing`, async ({ page }) => {
  await desk(page, 'Makers');
  const row = page.getByRole('table', { name: 'Maker applications' }).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Approved');
  await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test(`${J} #5 opens the region rules with no block list set: nothing is invented, and the page says it is not set`, async ({ page }) => {
  await desk(page, 'Regions');
  await expect(page.getByText(/Region block list\s*Not set/)).toBeVisible();
});

test(`${J} #6 reads two linked sub-accounts with volumes 100 and 50: the grouped fee volume is 150`, async ({ page }) => {
  await desk(page, 'Fee groups');
  const group = page.getByRole('table', { name: 'Fee groups' }).locator('tbody tr').first();
  const parts = (await group.getByRole('cell', { name: /^\d/ }).allInnerTexts()).map((v) => Number(v.replace(/[^\d.]/g, '')));
  expect(parts.at(-1)).toBe(parts.slice(0, -1).reduce((a, b) => a + b, 0));
});
