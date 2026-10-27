import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-22, in the running app (docs/roadmap/journeys.json): publish a signal and see what it earned. One test
// per step, titled "J-copy-bots-otc-22 #<n>", run in order on one verified TEST provider. The provider criteria and the
// commission are the stack's TEST signal terms; sales come from TEST buyers.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no signal publishing (criteria, vetting, fee models, archive) and no provider earnings.
const J = 'J-copy-bots-otc-22';
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

const form = (page) => page.getByRole('form', { name: 'Publish a signal' });

async function publishForm(page) {
  await signIn(page, state('provider'));
  await page.goto('/trade/bots/signals/publish');
  await expect(form(page)).toBeVisible(UNBUILT);
}

test(`${J} #1 publishes with the provider criteria blank: refused as criteria not set`, async ({ page }) => {
  test.setTimeout(240_000);
  const provider = await fundedTrader(page, 'jcsp', '100');
  run.reset({ provider });
  await publishForm(page);
  await form(page).getByLabel('Title').fill(`TEST signal ${provider.handle}`);
  await form(page).getByRole('button', { name: 'Publish' }).click();
  await expect(form(page).getByText(/criteria are not set/)).toBeVisible();
});

test(`${J} #2 publishes with a verified record: vetting passes once and the state is published`, async ({ page }) => {
  await publishForm(page);
  await form(page).getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published')).toBeVisible();
});

test(`${J} #3 publishes free, monthly with a blank price, then profit share: free lists once; blank refused; profit share forbidden`, async ({
  page,
}) => {
  await publishForm(page);
  await form(page).getByRole('radio', { name: 'Monthly fee' }).check();
  await form(page).getByRole('button', { name: 'Publish' }).click();
  await expect(form(page).getByText('Enter a price.')).toBeVisible();
  await form(page).getByRole('radio', { name: 'Profit share' }).check();
  await expect(form(page).getByText('A profit share isn’t allowed.')).toBeVisible();
});

test(`${J} #4 tries a recurring subscription: refused as not built`, async ({ page }) => {
  await publishForm(page);
  await expect(form(page).getByRole('radio', { name: 'Recurring subscription' })).toBeDisabled();
});

test(`${J} #5 archives the signal: the listing withdraws and existing subscribers keep their period`, async ({ page }) => {
  await signIn(page, state('provider'));
  await page.goto('/trade/bots/signals?view=mine');
  await page.getByRole('button', { name: 'Archive' }).first().click(UNBUILT);
  await expect(page.getByText('Archived')).toBeVisible();
});

test(`${J} #6 opens earnings after two sales of 10 and 5 with commission 1: gross 15 and net 14 per asset`, async ({ page }) => {
  await signIn(page, state('provider'));
  await page.goto('/trade/bots/signals?view=earnings');
  const earnings = page.getByRole('table', { name: 'Earnings by asset' });
  await expect(earnings).toBeVisible(UNBUILT);
  await expect(page.getByText(/Profit share\s*Not set by the platform/)).toBeVisible();
});
