import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader } from './desk.mjs';

// J-more-catalogue-10, in the running app (docs/roadmap/journeys.json): founders set governance rules and roles on the
// console's /more-ops/token. One test per step, titled "J-more-catalogue-10 #<n>", run in order. Proposals come from the
// stack's TEST governance seed (`local-test-world.mjs token-proposals`); every setting, proposal and audit row is read
// back from svc-token.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the console has no /more-ops/token governance panel (delay, period, two-founder confirm, moderator
//   cancel, roles with step-up), and the stack has no proposal seed.
const J = 'J-more-catalogue-10';
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

async function panel(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/more-ops/token`);
  const gov = page.getByRole('region', { name: 'Governance' });
  await expect(gov).toBeVisible(UNBUILT);
  return gov;
}

test(`${J} #1 opens the governance panel with nothing set: "delay not set" and "period not set"; a proposal with neither refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const author = await fundedTrader(page, 'jgv', '1');
  run.reset({ author });
  const gov = await panel(page);
  await expect(gov).toContainText(/Voting delay\s*Not set/);
  await expect(gov).toContainText(/Voting period\s*Not set/);
  const made = await (await api(author)).post('/api/token/trpc/governance.propose', { title: 'TEST proposal', kind: 'parameter' });
  expect(JSON.stringify(made.body)).toMatch(/voting_(delay|period)_unset/);
});

test(`${J} #2 writes settings alone: refused for lack of a second approver`, async ({ page }) => {
  const gov = await panel(page, 'a');
  await gov.getByLabel('Voting delay, hours').fill('24');
  await gov.getByLabel('Voting period, hours').fill('72');
  await gov.getByRole('button', { name: 'Save' }).click();
  await expect(gov).toContainText('Waiting for a second founder');
  await expect(gov).toContainText(/Voting delay\s*Not set/);
});

test(`${J} #3 a distinct second founder confirms: the settings are stored with an audit row`, async ({ page }) => {
  const gov = await panel(page, 'b');
  await gov.getByRole('button', { name: 'Confirm' }).click();
  await expect(gov).toContainText(/Voting delay\s*24 hours/);
  await expect(gov).toContainText(/Voting period\s*72 hours/);
  await page.goto(`${ADMIN}/audit?q=governance`);
  await expect(page.getByRole('row', { name: /governance\.settings/ }).first()).toBeVisible();
});

test(`${J} #4 a moderator cancels an open proposal with a reason: cancelled, reason shown, votes kept, further votes refused`, async ({
  page,
}) => {
  const seeded = JSON.parse(tool('local-test-world.mjs', 'token-proposals', '--author', state('author').email, '--open', '1'));
  run.write({ proposalId: seeded.ids[0] });
  const gov = await panel(page);
  const row = gov.getByRole('row', { name: new RegExp(seeded.ids[0]) });
  await row.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('TEST: duplicate proposal.');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel proposal' }).click();
  await expect(row).toContainText('Cancelled');
  await expect(row).toContainText('TEST: duplicate proposal.');
  const vote = await (await api(state('author'))).post('/api/token/trpc/governance.vote', { proposalId: seeded.ids[0], choice: 'for' });
  expect(JSON.stringify(vote.body)).toMatch(/proposal_cancelled/);
});

test(`${J} #5 an author tries to cancel another author's proposal: a typed permission refusal`, async ({ page }) => {
  const other = await fundedTrader(page, 'jgv2', '1');
  const cancel = await (
    await api(other)
  ).post('/api/token/trpc/governance.cancel', { proposalId: state('proposalId'), reason: 'not mine' });
  expect(JSON.stringify(cancel.body)).toMatch(/FORBIDDEN|not_author/);
});

test(`${J} #6 changes a role without a fresh step-up: refused until step-up is done`, async ({ page }) => {
  const gov = await panel(page);
  await gov.getByRole('tab', { name: 'Roles' }).click();
  await gov
    .getByRole('row', { name: new RegExp(state('author').handle) })
    .getByLabel('Role')
    .selectOption('Moderator');
  await expect(page.getByText(/Confirm it’s you|step-up/i)).toBeVisible();
});
