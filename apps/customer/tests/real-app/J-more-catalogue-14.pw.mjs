import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-more-catalogue-14, in the running app (docs/roadmap/journeys.json): onboard an issuer and announce a launch event.
// One test per step, titled "J-more-catalogue-14 #<n>", run in order. #1 makes the start: a verified TEST issuer saves a
// draft on /launch/new. The operator is the stack's TEST founder on the console's /launch desk.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /launch/new has no stored draft.
// - #2 to #8: the console's /launch desk has no issuer onboarding, announce, progress panels, milestones, issuance kinds,
//   claims evidence register or issuer suspension.
const J = 'J-more-catalogue-14';
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

async function desk(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/launch`);
  const issuers = page.getByRole('table', { name: 'Issuers' });
  await expect(issuers).toBeVisible(UNBUILT);
  return issuers;
}

const issuerRow = (page) => page.getByRole('table', { name: 'Issuers' }).getByRole('row', { name: new RegExp(state('issuer').handle) });
const eventPanel = async (page, name) => {
  await desk(page);
  await issuerRow(page)
    .getByRole('link', { name: /TEST launch/ })
    .click();
  return page.getByRole('region', { name });
};

test(`${J} #1 opens /launch/new as an issuer and saves a draft, then reloads: the stored draft appears`, async ({ page }) => {
  test.setTimeout(240_000);
  const issuer = await fundedTrader(page, 'jli', '1');
  const title = `TEST launch ${issuer.handle}`;
  run.reset({ issuer, title });
  await signIn(page, issuer);
  await page.goto('/launch/new');
  await page.getByLabel('Project name').fill(title, UNBUILT);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.reload();
  await expect(page.getByLabel('Project name')).toHaveValue(title);
});

test(`${J} #2 an operator announces for an issuer with no onboarding: refused as not onboarded; status unchanged`, async ({ page }) => {
  await desk(page);
  await issuerRow(page).getByRole('button', { name: 'Announce' }).click();
  await expect(page.getByText('This issuer isn’t onboarded.')).toBeVisible();
  await expect(issuerRow(page)).toContainText('Applied');
});

test(`${J} #3 onboards the issuer and announces: the event appears in the catalogue with its issuer state`, async ({ page, browser }) => {
  await desk(page);
  await issuerRow(page).getByRole('button', { name: 'Onboard' }).click();
  await issuerRow(page).getByRole('button', { name: 'Announce' }).click();
  await expect(issuerRow(page)).toContainText('Announced');
  const customer = await (await browser.newContext()).newPage();
  await customer.goto('/launch');
  await expect(
    customer
      .getByRole('region', { name: 'Launch events' })
      .getByRole('article')
      .filter({ hasText: state('title') }),
  ).toContainText('Onboarded');
  await customer.context().close();
});

test(`${J} #4 reads the commits and refunds panel: progress reads for the event`, async ({ page }) => {
  const panel = await eventPanel(page, 'Commits and refunds');
  await expect(panel).toContainText(/Committed\s*[\d.]+/);
  await expect(panel).toContainText(/Refunded\s*[\d.]+/);
});

test(`${J} #5 records fundraising milestones and investor records: milestones with their state`, async ({ page }) => {
  const panel = await eventPanel(page, 'Milestones');
  await panel.getByLabel('Milestone').fill('TEST first close');
  await panel.getByRole('button', { name: 'Add milestone' }).click();
  await expect(panel.getByRole('row', { name: /TEST first close/ })).toContainText(/Planned|Met/);
});

test(`${J} #6 records a wrapped or structured issuance: the issuance with its kind`, async ({ page }) => {
  const panel = await eventPanel(page, 'Issuance');
  await panel.getByLabel('Kind').selectOption('Wrapped');
  await panel.getByRole('button', { name: 'Record issuance' }).click();
  await expect(panel).toContainText(/Kind\s*Wrapped/);
});

test(`${J} #7 reviews the marketing claims register before announcing: each claim with its evidence or a block`, async ({ page }) => {
  const panel = await eventPanel(page, 'Marketing claims');
  for (const row of await panel.getByRole('row').all()) await expect(row).toContainText(/Evidence|Blocked/);
});

test(`${J} #8 moves the issuer to suspended: its open events close and the move is audited`, async ({ page }) => {
  await desk(page);
  await issuerRow(page).getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('TEST suspension.');
  await page.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click();
  await expect(issuerRow(page)).toContainText('Suspended');
  await page.goto(`${ADMIN}/audit?q=${encodeURIComponent(state('issuer').handle)}`);
  await expect(page.getByRole('row', { name: /TEST suspension\./ })).toBeVisible();
});
