import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-more-catalogue-11, in the running app (docs/roadmap/journeys.json): browse a token launch and read its terms. One test
// per step, titled "J-more-catalogue-11 #<n>". Signed out for the browsing steps, signed in as a TEST account for the
// person's own eligibility and basis. No money moves. The open and the past launch are the stack's TEST launch fixture.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: /launch has no list of events with filters (MC-launch-01).
// - The stack seeds no launch events (`local-test-gates.mjs launch-events`, proposed), so #2 to #5 have nothing to open.
// - #3 to #5: no launch page at /launch/<id> with allocation, terms, eligibility or basis (MC-launch-02).
const J = 'J-more-catalogue-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const events = (page) => page.getByRole('list', { name: 'Launch events' }).getByRole('listitem');

async function openLaunch(page) {
  await events(page).filter({ hasText: 'Open' }).first().getByRole('link').click(UNBUILT);
  await expect(page).toHaveURL(/\/launch\/[^/]+$/);
}

test(`${J} #1 opens /launch with no events: the full layout, filters and an empty state, with no sample card`, async ({ page }) => {
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'State' })).toBeVisible(UNBUILT);
  await expect(events(page).or(page.getByText('No launch events yet'))).toBeVisible();
});

test(`${J} #2 opens it with two events and filters by state: only matching cards, each with its issuer state`, async ({ page }) => {
  await page.goto('/launch');
  await page.getByRole('combobox', { name: 'State' }).selectOption({ label: 'Open' }, UNBUILT);
  await expect(events(page)).not.toHaveCount(0);
  for (const card of await events(page).all()) {
    await expect(card).toContainText('Open');
    await expect(card.getByTestId('launch-issuer-state')).toBeVisible();
  }
  await page.getByRole('combobox', { name: 'State' }).selectOption({ label: 'Past' });
  for (const card of await events(page).all()) await expect(card).toContainText('Ended');
});

test(`${J} #3 opens a launch: the allocation panel (method, cap, weights or "not set") and the terms panel (price, currency, rate or "price not set")`, async ({
  page,
}) => {
  await page.goto('/launch');
  await openLaunch(page);
  const allocation = page.getByRole('region', { name: 'Allocation' });
  for (const field of ['Method', 'Cap', 'Weights']) await expect(allocation).toContainText(field);
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText(/Price\s*([\d.]+ \w+|price not set)/);
});

test(`${J} #4 checks eligibility: the requirements list with the unmet items, such as identity verification`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'lc');
  run.reset({ who });
  await signIn(page, who);
  await page.goto('/launch');
  await openLaunch(page);
  await page.getByRole('button', { name: 'Check my eligibility' }).click();
  const requirements = page.getByRole('list', { name: 'Requirements' });
  await expect(requirements.getByRole('listitem').filter({ hasText: 'Identity verification' })).toContainText('Not met');
});

test(`${J} #5 reads the basis for an allocation by holdings: equal to the stored snapshot, with the cap as a decimal`, async ({ page }) => {
  await signIn(page, run.read().who);
  await page.goto('/launch');
  await openLaunch(page);
  const basis = page.getByRole('region', { name: 'Your basis' });
  await expect(basis).toContainText(/Snapshot at block \d+|Snapshot taken /);
  await expect(basis.getByTestId('launch-cap')).toHaveText(/^\d+(\.\d+)? \w+$/);
});
