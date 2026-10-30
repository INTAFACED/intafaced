import { test, expect } from '@playwright/test';
import { UNBUILT, agentCard, agentsRun, openAgents, tableIn } from './agents.mjs';
import { free, held } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-18, in the running app (docs/roadmap/journeys.json): let the Portfolio and Copy-Intel agents propose, and
// approve what I choose. One test per step, titled "J-agents-18 #<n>", run in order on one verified TEST account funded
// with TEST USDT. An approved rebalance moves value only through ordinary exchange orders under the person's limits; no
// profit share is paid; the leader directory shows disclosed stats and never a returns ranking.
// #4 is built: a person's own session opens Copy intelligence, and a request for a returns ranking is refused before
// anything is priced, held or run.
// What is built: the catalogue cards of Portfolio planner ("Not connected"), Copy intelligence (metered session), Launch
// check, Growth drafts and Risk and compliance ("Staff only"). Steps not built yet fail at their first missing part,
// quickly (UNBUILT):
// - Portfolio planner's source is not connected, so there is no rebalance proposal (RC-agents-03);
// - leader cards have no Copy-Intel stats or audited badge (RC-agents-07);
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
  const CODE = 'agents.copy_intel.returns_board_refused';
  await openAgents(page, agents);
  await agentCard(page, 'Copy intelligence').getByRole('button', { name: 'Open a session' }).click();
  await main(page).getByRole('button', { name: 'Review session' }).click();
  await page.getByRole('dialog', { name: 'Review agent session' }).getByRole('button', { name: 'Open agent session' }).click();
  await expect(page.getByText('Agent session opened')).toBeVisible();
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  const sessionId = (await workspace.getByTestId('session-id').textContent()).trim();
  // The session as svc-agents records it: its log and its usage, re-read on "Refresh session".
  const selected = main(page).getByRole('region', { name: 'Selected session' });
  await expect(selected.locator('code')).toHaveText(sessionId);
  const accrued = selected
    .getByRole('term')
    .filter({ hasText: /^Session usage accrued$/ })
    .locator('xpath=following-sibling::dd[1]');
  const log = selected.getByRole('list', { name: 'Agent audit activity' }).getByRole('listitem');
  await expect(accrued).toHaveText(/^0 USDT$/);
  await expect(log).toHaveCount(1);
  const before = await usdt();
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: rank the leaders by returns');
  await workspace.getByRole('button', { name: 'Run' }).click();
  const answer = page.waitForResponse((r) => r.url().includes('/api/agents/trpc/run.complete'));
  await page
    .getByRole('dialog', { name: 'Confirm the spend ceiling' })
    .getByRole('button', { name: /^Run up to/ })
    .click();
  // The service's own answer: refused by the one typed refusal, said in its words on the page.
  const refused = await answer;
  expect(refused.ok()).toBe(false);
  expect((await refused.json()).error.message).toBe('agents.refused.copy_intel.returns_board_refused');
  await expect(main(page).getByTestId('failure')).toContainText('Copy intelligence never ranks leaders by returns');
  await expect(tableIn(workspace, 'Runs').getByRole('row').nth(1).getByRole('cell').nth(2)).toContainText('Refused');
  // No board: the agent gave no reply at all, and nothing on the page ranks leaders.
  await expect(workspace.getByRole('region', { name: 'Reply' })).toHaveCount(0);
  await expect(main(page).getByRole('table', { name: /rank/i })).toHaveCount(0);
  await expect(main(page).getByRole('list', { name: /rank/i })).toHaveCount(0);
  // Re-read from svc-agents: the session's log gained exactly one row, the refusal by its one typed code, and nothing
  // ran or was charged, in the session or the ledger.
  const reread = Promise.all(
    ['session.log', 'usage.current'].map((procedure) =>
      page.waitForResponse((r) => r.url().includes(`/api/agents/trpc/${procedure}`) && r.ok()),
    ),
  );
  await selected.getByRole('button', { name: 'Refresh session' }).click();
  await reread;
  await expect(log).toHaveCount(2);
  const refusal = log.filter({ hasText: CODE });
  await expect(refusal).toHaveCount(1);
  await expect(refusal.locator('span[lang="zxx"]')).toHaveText(CODE);
  await expect(refusal.locator('strong')).toContainText('Refused');
  await expect(
    refusal
      .getByRole('term')
      .filter({ hasText: /^Cost$/ })
      .locator('xpath=following-sibling::dd[1]'),
  ).toHaveText(/^0$/);
  await expect(accrued).toHaveText(/^0 USDT$/);
  await expect(workspace.locator('p').filter({ has: page.getByTestId('session-id') })).toContainText('· open');
  expect(await usdt()).toEqual(before);
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
