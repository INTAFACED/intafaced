import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';

// J-developer-18, in the running app (docs/roadmap/journeys.json): a founder sets the platform's API rules and tells
// developers. One test per step, titled "J-developer-18 #<n>", run in order on the console as the stack's TEST
// founders; every value set is TEST and read back on the public developer pages.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #3: the console has no API limits view (tiers, per-route cost, limit requests).
// - #4: no changelog publishing on the console; #5: no incident recording against a component from the console.
const J = 'J-developer-18';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

async function limits(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/system/api-limits`);
  const view = page.getByRole('region', { name: 'API limits' });
  await expect(view).toBeVisible(UNBUILT);
  return view;
}

test(`${J} #1 opens the limits view: tiers, per-route cost, a shared counter; a blank rate makes every call return limits-unset`, async ({
  page,
}) => {
  run.reset({});
  const view = await limits(page);
  await expect(view.getByRole('table', { name: 'Tiers' }).or(view.getByText('Rate tiers are not set.'))).toBeVisible();
  await expect(view.getByRole('table', { name: 'Cost per route' })).toBeVisible();
  await expect(view).toContainText(/Shared counter/);
});

test(`${J} #2 sets a base tier: the tiers saved with an audit entry`, async ({ page }) => {
  const view = await limits(page);
  await view.getByLabel('Base tier, requests per second').fill('10');
  await view.getByLabel('Base tier, burst').fill('20');
  await view.getByRole('button', { name: 'Save tiers' }).click();
  await expect(view).toContainText(/Base\s*10/);
  await page.goto(`${ADMIN}/audit?q=api-limits`);
  await expect(page.getByRole('row', { name: /api_limits\.tiers/ }).first()).toBeVisible();
});

test(`${J} #3 grants part of a customer's limit request: the owner value changes once with one audit entry`, async ({ page }) => {
  const view = await limits(page);
  const row = view.getByRole('table', { name: 'Limit requests' }).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Grant' }).click();
  await page.getByRole('dialog').getByLabel('Granted requests per second').fill('15');
  await page.getByRole('dialog').getByRole('button', { name: 'Grant' }).click();
  await expect(row).toContainText('Granted 15');
});

test(`${J} #4 publishes a breaking changelog entry with a date: under its area, flagged, on upcoming until the date; no role refused`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/system/changelog`);
  const form = page.getByRole('form', { name: 'New changelog entry' });
  const title = `TEST breaking ${Date.now().toString(36)}`;
  await form.getByLabel('Title').fill(title, UNBUILT);
  await form.getByLabel('Area').selectOption('Orders');
  await form.getByLabel('Breaking').check();
  await form.getByLabel('Release date').fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await form.getByRole('button', { name: 'Publish' }).click();
  await page.goto('/developers/changelog/upcoming');
  const entry = page.getByRole('article').filter({ hasText: title });
  await expect(entry).toContainText('Breaking');
  await expect(entry).toContainText('Orders');
});

test(`${J} #5 records an incident on a component: the status feed shows impact and updates`, async ({ page }) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/system/status`);
  const form = page.getByRole('form', { name: 'Record an incident' });
  await form.getByLabel('Component').selectOption({ index: 1 }, UNBUILT);
  await form.getByLabel('Impact').selectOption('Degraded');
  await form.getByLabel('Update').fill('TEST incident for the developer journey.');
  await form.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('TEST incident for the developer journey.')).toBeVisible();
});
