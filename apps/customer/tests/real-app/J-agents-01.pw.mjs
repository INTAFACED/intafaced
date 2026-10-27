import { test, expect } from '@playwright/test';
import { UNBUILT, agentCard, agentSection, agentsRun, openAgents, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-01, in the running app (docs/roadmap/journeys.json): find an agent, check what it may do, and run it once.
// One test per step, titled "J-agents-01 #<n>", run in order on one verified TEST account funded with TEST USDT. The
// usage window settles once as a ledger fee charge equal to the stated window cost; a retried request id charges once.
// What is built: the catalogue (search, the "How it is used" filter, a card per agent), the detail panel (guardrail and
// a Tools table of name, access and approval), the published routing prices and the "Review agent session" sheet.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the catalogue has no sort and no status on each card;
// - #2: there is no compare;
// - #3: the Tools table names no inputs, outputs or refusal reasons;
// - #4: there is no estimate;
// - #5 to #7: opening a session is refused for a standard account ("Scope "agents:execute" is required"), so nothing
//   runs, closes or reaches the session history.
// Not checkable on this stack: #1's empty state (the stack publishes five agents) and #2's ineligible agent (the TEST
// account is eligible for every customer agent). J-agents-14 #7 checks a disabled agent's card.
const J = 'J-agents-01';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const workspace = (page) => main(page).getByRole('region', { name: 'Session workspace' });

/** The session #5 ran, from the run file; a later step after a failed #5 says so instead of using another session. */
function ranSession() {
  const { sessionId } = agents.run.read();
  if (!sessionId) throw new Error(`${J} #5 ran no session, so this step has no session to act on`);
  return sessionId;
}

/** Opens Sessions with the session #5 ran selected. */
async function selectRanSession(page) {
  const sessionId = ranSession();
  await openAgents(page, agents, 'Sessions');
  const records = main(page).getByRole('region', { name: 'Recorded sessions' });
  await records.getByRole('row').filter({ hasText: sessionId }).getByRole('button', { name: 'Inspect session' }).click(UNBUILT);
  return main(page).getByRole('region', { name: 'Selected session' });
}

test(`${J} starts: a verified TEST account funded with TEST USDT, opening Agents from More`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag01');
  await signIn(page, agents.account());
  await page.goto('/more');
  await main(page)
    .getByRole('link', { name: /^Agents/ })
    .first()
    .click();
  await expect(main(page).getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
});

test(`${J} #1 opens Agents: the catalogue from the stored list with filters, sort and status; a disabled agent stays visible with its open button off`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await expect(main(page).getByRole('heading', { name: 'Agent catalogue' })).toBeVisible();
  // The stored list: the five session agents the stack registers, each a card.
  for (const name of ['Navigator', 'Support helper', 'Market scanner', 'Merchant watcher', 'Copy intelligence']) {
    await expect(agentCard(page, name)).toBeVisible();
  }
  await expect(main(page).getByRole('textbox', { name: 'Search agents' })).toBeVisible();
  await main(page).getByRole('combobox', { name: 'How it is used' }).selectOption({ label: 'Metered session' });
  await expect(agentCard(page, 'Curriculum coach')).toHaveCount(0);
  await main(page).getByRole('combobox', { name: 'How it is used' }).selectOption({ label: 'All' });

  const sort = main(page).getByRole('combobox', { name: 'Sort' });
  await expect(sort).toBeVisible(UNBUILT);
  await sort.selectOption({ label: 'Name' });
  const names = await main(page).getByRole('article').getByRole('heading', { level: 3 }).allInnerTexts();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  // Every card says whether the agent can be used now.
  for (const card of await main(page).getByRole('article').all())
    await expect(card.getByTestId('agent-status')).toHaveText(/^(Enabled|Disabled)$/);
});

test(`${J} #2 selects two agents to compare: one table of tools, modes, caps and tasks side by side from the stored guardrail`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('checkbox', { name: 'Compare' }).check(UNBUILT);
  await agentCard(page, 'Support helper').getByRole('checkbox', { name: 'Compare' }).check();
  await main(page).getByRole('button', { name: 'Compare 2 agents' }).click();
  const compare = tableIn(main(page), 'Compare agents');
  await expect(compare.getByRole('columnheader', { name: 'Navigator' })).toBeVisible();
  await expect(compare.getByRole('columnheader', { name: 'Support helper' })).toBeVisible();
  for (const row of ['Tools', 'Modes', 'Spend cap per session', 'Allowed engine tasks']) {
    await expect(compare.getByRole('row').filter({ has: page.getByRole('cell', { name: row, exact: true }) })).toBeVisible();
  }
  // The caps come from each agent's stored guardrail (Navigator publishes 1 per session on the stack).
  await expect(
    compare.getByRole('row').filter({ hasText: 'Spend cap per session' }).getByRole('cell', { name: '1 USDT per session', exact: true }),
  ).toHaveCount(2);
});

test(`${J} #3 opens an agent's detail page: tools with inputs, outputs and refusal reasons; the permission mode; it acts as the person, never with broader access`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Details' }).click();
  const tools = tableIn(main(page), 'Tools');
  await expect(tools.getByRole('row').filter({ hasText: 'trade.quote' })).toBeVisible();
  for (const header of ['Inputs', 'Outputs', 'Refusals'])
    await expect(tools.getByRole('columnheader', { name: header })).toBeVisible(UNBUILT);
  // A tool that publishes no shape says so, rather than showing an empty cell.
  for (const cell of await tools.getByRole('cell').all()) await expect(cell).toHaveText(/\S/);
  await expect(main(page).getByRole('term').filter({ hasText: 'Permission mode' })).toBeVisible();
  await expect(main(page)).toContainText('This agent acts as you, and never with more access than you have.');
});

test(`${J} #4 reads the rate card and asks for an estimate: the published rate, the worst case equal to the cap check, no expected range without history`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Open a session' }).click();
  const rates = tableIn(main(page), 'Published engine routing prices');
  await expect(rates.getByRole('row').filter({ has: page.getByRole('cell', { name: 'navigator.plan', exact: true }) })).toContainText(
    '3 USDT',
  );
  await main(page).getByRole('button', { name: 'Estimate the cost' }).click(UNBUILT);
  const estimate = main(page).getByRole('region', { name: 'Cost estimate' });
  // The worst case is the one the cap check uses: the session's spend cap (1 USDT on the stack).
  await expect(estimate.getByTestId('worst-case')).toHaveText('At most 1 USDT for this run');
  await expect(estimate).toContainText('No expected range yet: this agent has no run history.');
});

test(`${J} #5 presses Run and confirms the spend ceiling: a run row before the engine; the reply and its exact cost; one request id twice is one run and one charge`, async ({
  page,
}) => {
  const sessionId = await openNavigatorSession(page, agents);
  agents.run.write({ sessionId });
  const ask = workspace(page).getByRole('textbox', { name: /^Ask the agent/ });
  await ask.fill('Where do I place a limit order?');
  await workspace(page).getByRole('button', { name: 'Run' }).click();
  const ceiling = page.getByRole('dialog', { name: 'Confirm the spend ceiling' });
  await expect(ceiling).toContainText('1 USDT');
  await ceiling.getByRole('button', { name: 'Run up to 1 USDT' }).click();
  const runs = tableIn(workspace(page), 'Runs');
  await expect(runs.getByRole('row').nth(1)).toContainText(/Running|Completed/);
  await expect(workspace(page).getByRole('region', { name: 'Reply' })).not.toBeEmpty({ timeout: 60_000 });
  await expect(runs.getByRole('row').nth(1).getByTestId('run-cost')).toHaveText(/^\d+(\.\d+)? USDT$/);

  // Sending the same request again (a retry after a lost answer) returns the first run and charges once.
  await runs.getByRole('row').nth(1).getByRole('button', { name: 'Send again' }).click();
  await expect(runs.getByRole('row')).toHaveCount(2);
  await expect(workspace(page).getByRole('status')).toContainText('Same request: the first run is shown and nothing was charged again.');
});

test(`${J} #6 closes the session: open windows settle once; a closed session refuses further actions`, async ({ page }) => {
  // The session #5 ran, with its usage window still open.
  const selected = await selectRanSession(page);
  await selected.getByRole('button', { name: 'Close session' }).click();
  await expect(selected.getByRole('status')).toContainText('Session closed. Usage settled.');
  await expect(tableIn(selected, 'Usage windows').getByRole('row').filter({ hasText: 'Settled' })).toHaveCount(1);
  // Closing again settles nothing more, and the session takes no new request.
  await expect(selected.getByRole('button', { name: 'Close session' })).toHaveCount(0);
  await expect(selected).toContainText('This session is closed.');
});

test(`${J} #7 opens session history: the run with exact usage, refusal codes as words and no prompt text; the selection survives a reload and another device`, async ({
  page,
  browser,
}) => {
  const selected = await selectRanSession(page);
  await expect(selected.getByRole('term').filter({ hasText: 'Session usage accrued' })).toBeVisible();
  await expect(selected).toContainText(ranSession());
  await expect(selected).not.toContainText('Where do I place a limit order?');
  await page.reload();
  await agentSection(page, 'Sessions');
  await expect(selected.getByRole('term').filter({ hasText: 'Session usage accrued' })).toBeVisible();

  const other = await browser.newContext();
  try {
    const device = await other.newPage();
    await signIn(device, agents.account());
    await device.goto('/agents');
    await agentSection(device, 'Sessions');
    await expect(
      device.getByRole('region', { name: 'Selected session' }).getByRole('term').filter({ hasText: 'Session usage accrued' }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});
