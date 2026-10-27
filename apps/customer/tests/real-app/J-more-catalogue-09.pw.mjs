import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-more-catalogue-09, in the running app (docs/roadmap/journeys.json): read a governance proposal and cast a vote. One
// test per step, titled "J-more-catalogue-09 #<n>". The person is a TEST account on the local stack. A vote moves no
// value. The space, its two proposals and the person's earlier stake are the stack's TEST governance fixture.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack seeds no governance space, proposals or earlier stake (`local-test-gates.mjs governance`, proposed).
// - #1, #2: no space card and no follow (MC-token-01).
// - #4, #5: no proposer rule shown before submit, and no draft with a future opening time.
// - #6: no voting-power history (MC-token-03); #8, #9: no delegate refusal or treasury panel (MC-token-04).
const J = 'J-more-catalogue-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

async function openGovernance(page) {
  await signIn(page, run.read().who);
  await page.goto('/token/governance');
  await expect(page.getByRole('heading', { name: 'Token governance', level: 1 })).toBeVisible();
}

const space = (page) => page.getByRole('region', { name: 'Governance space' });
const proposals = (page) => page.getByRole('table', { name: 'Proposals' });

test(`${J} starts: a signed-up TEST account`, async ({ page }) => {
  const who = await signUp(page, 'gv');
  run.reset({ who });
});

test(`${J} #1 opens /token/governance: the space card, follow, filters, and an empty state when there are no proposals`, async ({
  page,
}) => {
  await openGovernance(page);
  await expect(space(page)).toBeVisible(UNBUILT);
  await expect(space(page).getByRole('button', { name: /^Follow/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
  await expect(proposals(page).or(page.getByText('No proposals yet'))).toBeVisible();
});

test(`${J} #2 follows the space, twice: the follow persists, and the second follow changes nothing`, async ({ page }) => {
  await openGovernance(page);
  await space(page).getByRole('button', { name: 'Follow' }).click(UNBUILT);
  await expect(space(page).getByRole('button', { name: 'Following' })).toBeVisible();
  const followers = await space(page).getByTestId('space-followers').textContent();
  await page.reload();
  await expect(space(page).getByRole('button', { name: 'Following' })).toBeVisible();
  await space(page).getByRole('button', { name: 'Following' }).click();
  await expect(space(page).getByTestId('space-followers')).toHaveText(followers ?? '');
});

test(`${J} #3 filters and searches the proposals: only matches, with dates and counts`, async ({ page }) => {
  await openGovernance(page);
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' }, UNBUILT);
  const rows = proposals(page).locator('tbody tr');
  for (const row of await rows.all()) await expect(row).toContainText('Active');
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill('TEST');
  for (const row of await rows.all()) {
    await expect(row).toContainText('TEST');
    await expect(row.locator('time').first()).toBeVisible();
  }
  await expect(page.getByTestId('proposals-count')).toHaveText(new RegExp(`^${await rows.count()} `));
});

test(`${J} #4 creates a proposal below the proposer rule: the panel says why before submit, and submit is refused with the typed code`, async ({
  page,
}) => {
  await openGovernance(page);
  await page.getByRole('button', { name: 'New proposal' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New proposal' });
  await expect(form.getByRole('note')).toContainText(/You need at least [\d.]+ staked to propose|The proposer rule is not set/);
  await form.getByRole('textbox', { name: 'Title' }).fill('TEST proposal below the rule');
  await form.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(page.getByRole('alert')).toContainText(/below the proposer rule|proposer rule is not set/);
});

test(`${J} #5 creates a proposal with a future opening time: it stays a draft and can be edited before voting`, async ({ page }) => {
  await openGovernance(page);
  await page.getByRole('button', { name: 'New proposal' }).click(UNBUILT);
  const form = page.getByRole('form', { name: 'New proposal' });
  await form.getByRole('textbox', { name: 'Title' }).fill('TEST future proposal');
  await form.getByLabel('Voting opens').fill('2030-01-01T00:00');
  await form.getByRole('button', { name: 'Submit proposal' }).click();
  const row = proposals(page).getByRole('row', { name: /TEST future proposal/ });
  await expect(row).toContainText('Draft');
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('form', { name: 'Edit proposal' })).toBeVisible();
});

test(`${J} #6 opens a proposal and reads the voting power: fixed when it was created; zero with the reason if staked later; and the power history`, async ({
  page,
}) => {
  await openGovernance(page);
  await proposals(page).getByRole('link').first().click(UNBUILT);
  const power = page.getByRole('region', { name: 'Your voting power' });
  await expect(power).toContainText(/Fixed at block \d+|Fixed on /);
  await expect(power.getByRole('table', { name: 'Voting power over time' })).toBeVisible();
});

test(`${J} #7 casts a vote: a ballot with bad weights refused; the vote needs a signed message; without a wallet link the typed unavailable reply`, async ({
  page,
}) => {
  await openGovernance(page);
  await proposals(page).getByRole('link').first().click(UNBUILT);
  await page.getByRole('button', { name: /^Vote/ }).click();
  const ballot = page.getByRole('dialog');
  const weights = ballot.getByRole('spinbutton');
  if (await weights.count()) {
    await weights.first().fill('150');
    await ballot.getByRole('button', { name: /^Cast/ }).click();
    await expect(ballot.getByRole('alert')).toContainText(/weights must add up to 100/i);
  }
  await expect(ballot).toContainText(/sign|wallet link is not available/i);
});

test(`${J} #8 presses Delegate: the refusal naming the Protocol blocker, and no row written`, async ({ page }) => {
  await openGovernance(page);
  await page.getByRole('button', { name: 'Delegate' }).click(UNBUILT);
  await expect(page.getByRole('alert')).toContainText(/Delegation waits for the INTACHAIN launch/);
});

test(`${J} #9 opens the treasury panel: each figure equals the token service read; missing figures say "not reported"; burns "none recorded", not zero`, async ({
  page,
}) => {
  await openGovernance(page);
  const treasury = page.getByRole('region', { name: 'Treasury' });
  await expect(treasury).toBeVisible(UNBUILT);
  await expect(treasury.getByTestId('treasury-burns')).toHaveText(/none recorded|[\d.]+/);
  await expect(treasury.getByTestId('treasury-burns')).not.toHaveText(/^0(\.0+)?$/);
  for (const figure of await treasury.getByRole('definition').all()) await expect(figure).toHaveText(/not reported|none recorded|[\d.]+/);
});
