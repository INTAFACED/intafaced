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
// check, Growth drafts and Risk and compliance ("Staff only").
// #1, #2 and #5 are red by name (BLOCKED below; D's ruling 2026-10-31 by product law): the Portfolio, Launch and Growth
// agents are v2, "Doctrine names only — no factory until product law" (services/svc-agents/README.md:313;
// INTAFACED_DEFINITIVE_BUILD.md:388), so no rebalance proposal, run history or draft is built for them. Each step
// first asserts what the app does today, then fails with its name.
// #3 is not built yet and fails at its first missing part, quickly (UNBUILT): leader cards have no Copy-Intel stats or
// audited badge (RC-agents-07).
const J = 'J-agents-18';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** The account's USDT as the ledger holds it, free and held, in scaled units. */
async function usdt() {
  const balances = await (await api(agents.account())).balances();
  return { free: free(balances, 'USDT'), held: held(balances, 'USDT') };
}

/** The steps that stay red by name, and why. Every failure inside them carries the name (`blockedBy`). */
const V2 = 'services/svc-agents/README.md:313: v2 agents are "Doctrine names only — no factory until product law"';
const BLOCKED = {
  1: `${J} #1 BLOCKED (${V2}; RC-agents-03): the Portfolio planner's portfolio source is not connected, so it proposes no rebalance (portfolio.plan refuses portfolio.killed)`,
  2: `${J} #2 BLOCKED (${V2}; RC-agents-03): with no proposal there is nothing to approve or reject`,
  5: `${J} #5 BLOCKED (${V2}; RC-agents-04): the Launch check and Growth drafts agents keep no run history or drafts`,
};

/**
 * A step that is red by name: `check` asserts what the app does today, and any assertion it fails carries the name;
 * when it passes, the step still fails with the name.
 */
async function blockedBy(name, check) {
  try {
    await check();
  } catch (error) {
    if (error instanceof Error) error.message = `${name}\n(a check before the block failed) ${error.message}`;
    throw error;
  }
  throw new Error(name);
}

/**
 * What the Portfolio planner does today when a person tries it: its card's open button is off with the blocker named,
 * and asking the service for a plan is refused with the planner's kill switch (portfolio.killed), moving nothing. A plan coming back means
 * the planner is wired, and the step needs a rewrite instead of the block.
 */
async function plannerRefuses(page) {
  await openAgents(page, agents);
  const card = agentCard(page, 'Portfolio planner');
  await expect(card.getByRole('button', { name: 'Open a session' })).toBeDisabled();
  await expect(card.getByRole('note')).toHaveText(
    'No session can be opened: this agent’s data source is not connected, so it cannot plan or place anything.',
  );
  const before = await usdt();
  const door = await api(agents.account());
  const input = encodeURIComponent(JSON.stringify({ targets: [{ asset: 'USDT', plane: 'custodial', weight: '1' }] }));
  const plan = await door.get(`/api/agents/trpc/portfolio.plan?input=${input}`);
  const result = plan.body?.result?.data?.result;
  if (result?.status === 'planned')
    throw new Error(`${J} NEEDS A REWRITE: portfolio.plan now plans (${JSON.stringify(result).slice(0, 200)})`);
  expect(plan.status, JSON.stringify(plan.body).slice(0, 300)).toBe(200);
  expect(result).toMatchObject({ status: 'refused', code: 'portfolio.killed' });
  expect(await usdt()).toEqual(before);
}

test(`${J} starts: a verified TEST account with a funded TEST portfolio and the leader directory`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag18', '100');
  await openAgents(page, agents);
  await expect(agentCard(page, 'Portfolio planner')).toBeVisible();
});

test(`${J} #1 asks the Portfolio agent for a rebalance: a proposal listing each order, and nothing executed`, async ({ page }) => {
  await blockedBy(BLOCKED[1], () => plannerRefuses(page));
});

test(`${J} #2 approves one proposal and rejects another: the approved orders placed within limits; the rejected one changes nothing`, async ({
  page,
}) => {
  await blockedBy(BLOCKED[2], () => plannerRefuses(page));
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
  await blockedBy(BLOCKED[5], async () => {
    // What the app does today: Launch check and Growth drafts are catalogue cards that open their rooms, with no run
    // history or drafts; Risk and compliance is staff only, its card says so.
    for (const name of ['Launch check', 'Growth drafts']) {
      await openAgents(page, agents);
      await agentCard(page, name).getByRole('button', { name: 'Details' }).click();
      await expect(main(page).getByRole('table', { name: 'Run history' })).toHaveCount(0);
      await expect(main(page).getByRole('table', { name: 'Drafts' })).toHaveCount(0);
    }
    await openAgents(page, agents);
    await expect(agentCard(page, 'Risk and compliance')).toContainText('Staff only');
  });
});
