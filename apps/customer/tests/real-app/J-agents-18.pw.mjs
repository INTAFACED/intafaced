import { test, expect } from '@playwright/test';
import { UNBUILT, agentCard, agentsRun, openAgents, tableIn } from './agents.mjs';
import { free, held } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-18, in the running app (docs/roadmap/journeys.json): let the Portfolio and Copy-Intel agents propose, and
// approve what I choose. One test per step, titled "J-agents-18 #<n>", run in order on one verified TEST account funded
// with TEST USDT. An approved rebalance moves value only through ordinary exchange orders under the person's limits; no
// profit share is paid; the leader directory shows disclosed stats and never a returns ranking.
// What is built: the catalogue cards of Portfolio planner ("Not connected"), Copy intelligence (metered session), Launch
// check, Growth drafts and Risk and compliance ("Staff only"). Steps not built yet fail at their first missing part,
// quickly (UNBUILT):
// - Portfolio planner's source is not connected, so there is no rebalance proposal (RC-agents-03);
// - leader cards have no Copy-Intel stats or audited badge (RC-agents-07), and opening a Copy intelligence session is
//   refused for a standard account ("agents:execute");
// - the Launch check and Growth drafts agents have no pages with run history and drafts (RC-agents-04).
const J = 'J-agents-18';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const proposals = (page) => tableIn(main(page), 'Rebalance proposals');

/** The account's USDT as the ledger holds it, free and held, in scaled units. */
async function usdt() {
  const balances = await (await api(agents.account())).balances();
  return { free: free(balances, 'USDT'), held: held(balances, 'USDT') };
}

/** Asks the Portfolio planner for a rebalance from its card. */
async function askRebalance(page) {
  await openAgents(page, agents);
  await agentCard(page, 'Portfolio planner').getByRole('button', { name: 'Ask for a rebalance' }).click(UNBUILT);
}

test(`${J} starts: a verified TEST account with a funded TEST portfolio and the leader directory`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag18', '100');
  await openAgents(page, agents);
  await expect(agentCard(page, 'Portfolio planner')).toBeVisible();
});

test(`${J} #1 asks the Portfolio agent for a rebalance: a proposal listing each order, and nothing executed`, async ({ page }) => {
  const before = await usdt();
  await askRebalance(page);
  const latest = proposals(page).getByRole('row').nth(1);
  await expect(latest.getByTestId('proposal-orders')).toHaveText(/^\d+ orders?$/);
  await expect(latest).toContainText('Proposed');
  expect(await usdt()).toEqual(before);
});

test(`${J} #2 approves one proposal and rejects another: the approved orders placed within limits; the rejected one changes nothing`, async ({
  page,
}) => {
  await askRebalance(page);
  await askRebalance(page);
  const [approve, reject] = [proposals(page).getByRole('row').nth(1), proposals(page).getByRole('row').nth(2)];
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toContainText('Orders placed within your limits');
  // The approved market orders settle before the reject is weighed: nothing stays held for them.
  await expect.poll(async () => (await usdt()).held, { timeout: 30_000 }).toBe(0n);
  const before = await usdt();
  await reject.getByRole('button', { name: 'Reject' }).click();
  await expect(reject).toContainText('Rejected: nothing changed');
  expect(await usdt()).toEqual(before);
  await page.goto('/trade/orders');
  await expect(main(page).getByRole('row').filter({ hasText: 'Placed by Portfolio planner' }).first()).toBeVisible();
});

test(`${J} #3 opens a leader's card: stats computed from fills, with the audited badge only once the Copy-Intel job wrote it`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Copy intelligence').getByRole('button', { name: 'Details' }).click();
  await main(page).getByRole('link', { name: 'Leader directory' }).click(UNBUILT);
  const card = main(page).getByRole('article').first();
  await expect(card.getByRole('region', { name: 'Stats from fills' })).toBeVisible();
  const badge = card.getByTestId('audited-badge');
  await expect(badge.or(card.getByText('Not audited yet'))).toBeVisible();
});

test(`${J} #4 asks Copy-Intel for a returns ranking: a typed refusal and no board`, async ({ page }) => {
  await openAgents(page, agents);
  await agentCard(page, 'Copy intelligence').getByRole('button', { name: 'Open a session' }).click();
  await main(page).getByRole('button', { name: 'Review session' }).click();
  await page.getByRole('dialog', { name: 'Review agent session' }).getByRole('button', { name: 'Open agent session' }).click();
  await expect(page.getByText('Agent session opened')).toBeVisible(UNBUILT);
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: rank the leaders by returns');
  await workspace.getByRole('button', { name: 'Run' }).click();
  await expect(workspace.getByRole('alert')).toContainText('agents.copy_intel.returns_board_refused');
  await expect(workspace.getByRole('table', { name: /ranking/i })).toHaveCount(0);
});

test(`${J} #5 opens the Launch, Risk and Compliance, and Growth agent pages: run history and drafts; a growth proposal to publish stays a draft`, async ({
  page,
}) => {
  for (const name of ['Launch check', 'Growth drafts']) {
    await openAgents(page, agents);
    await agentCard(page, name).getByRole('button', { name: 'Details' }).click(UNBUILT);
    await expect(tableIn(main(page), 'Run history')).toBeVisible(UNBUILT);
    await expect(tableIn(main(page), 'Drafts')).toBeVisible();
  }
  // Risk and compliance is staff only: the customer sees its card say so, and no page of runs.
  await openAgents(page, agents);
  await expect(agentCard(page, 'Risk and compliance')).toContainText('Staff only');
  await openAgents(page, agents);
  await agentCard(page, 'Growth drafts').getByRole('button', { name: 'Details' }).click();
  const draft = tableIn(main(page), 'Drafts').getByRole('row').nth(1);
  await draft.getByRole('button', { name: 'Publish' }).click();
  await expect(main(page).getByRole('alert')).toContainText('A growth proposal stays a draft.');
  await expect(draft).toContainText('Draft');
});
