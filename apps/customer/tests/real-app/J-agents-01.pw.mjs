import { test, expect } from '@playwright/test';
import { UNBUILT, agentCard, agentSection, agentsRun, openAgents, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { api, fromUnits, stackFile, toUnits } from './stack.mjs';

// J-agents-01, in the running app (docs/roadmap/journeys.json): find an agent, check what it may do, and run it once.
// One test per step, titled "J-agents-01 #<n>", run in order on one verified TEST account funded with TEST USDT. The
// usage window settles once as a ledger fee charge equal to the stated window cost; a retried request id charges once.
// The run uses the stack's TEST rate card (tooling/profiles/test-owner-values/agents.json) and the service's sandbox
// engine; #5 to #7 check its cost against the published rate and the ledger's own balances, read through Edge.
// Not checkable on this stack: #1's empty state (the stack publishes five agents) and #2's ineligible agent (the TEST
// account is eligible for every customer agent). #1's disabled agent is the Portfolio planner, which no customer can run
// yet; J-agents-14 #7 checks a quarantined agent's card.
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
  // A disabled agent stays visible with its open button off: the Portfolio planner, which no customer can run yet.
  const portfolio = agentCard(page, 'Portfolio planner');
  await expect(portfolio).toBeVisible();
  await expect(portfolio.getByTestId('agent-status')).toHaveText('Disabled');
  const openPortfolio = portfolio.getByRole('button', { name: 'Open a session' });
  await expect(openPortfolio).toBeDisabled();
  // Parked means visible with the real blocker named, on the card and as the button's description.
  const blocker = 'No session can be opened: this agent’s data source is not connected, so it cannot plan or place anything.';
  await expect(portfolio.getByRole('note')).toHaveText(blocker);
  await expect(openPortfolio).toHaveAccessibleDescription(blocker);
});

test(`${J} #2 selects two agents to compare: one table of tools, modes, caps and tasks side by side from the stored guardrail`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('checkbox', { name: 'Compare' }).check(UNBUILT);
  await agentCard(page, 'Support helper').getByRole('checkbox', { name: 'Compare' }).check();
  // The table is drawn from the two stored guardrails the page reads now; their answers are what each column must show.
  const read = (agentId) =>
    page.waitForResponse(
      (r) =>
        r.ok() &&
        r.request().method() === 'GET' &&
        r.url().includes('/api/agents/trpc/agent.get') &&
        decodeURIComponent(r.url()).includes(`"agentId":"${agentId}"`),
      { timeout: 15_000 },
    );
  const reads = [read('navigator'), read('support')];
  await main(page).getByRole('button', { name: 'Compare 2 agents' }).click();
  const [navigator, support] = await Promise.all(reads.map(async (answer) => (await (await answer).json())?.result?.data));
  const compare = tableIn(main(page), 'Compare agents');
  await expect(compare.getByRole('columnheader', { name: 'Navigator' })).toBeVisible();
  await expect(compare.getByRole('columnheader', { name: 'Support helper' })).toBeVisible();
  for (const row of ['Tools', 'Modes', 'Spend cap per session', 'Allowed engine tasks']) {
    await expect(compare.getByRole('row').filter({ has: page.getByRole('cell', { name: row, exact: true }) })).toBeVisible();
  }
  // The caps come from each agent's stored guardrail, one per column: Navigator publishes 1 per session on the stack and
  // Support helper 0.5 (services/svc-agents/src/support-agent/guardrail.ts).
  await expect(compare.getByRole('row').filter({ hasText: 'Spend cap per session' }).getByRole('cell')).toHaveText([
    'Spend cap per session',
    '1 USDT per session',
    '0.5 USDT per session',
  ]);
  // Tools, modes and tasks side by side, each cell exactly the stored guardrail's values for its column.
  const joined = (values) => (values.length ? values.join(', ') : 'None');
  const stored = {
    Tools: (g) => joined(g.tools.map((tool) => tool.name)),
    Modes: (g) => joined([...new Set(g.tools.map((tool) => tool.mode))]),
    'Allowed engine tasks': (g) => joined(g.limits.allowedTasks),
  };
  for (const [g, who] of [
    [navigator, 'navigator'],
    [support, 'support'],
  ])
    expect(g?.tools?.length, `${who}: ${JSON.stringify(g).slice(0, 300)}`).toBeGreaterThan(0);
  // The two agents differ in what they may do, so the comparison is not one value twice.
  expect(stored.Tools(navigator)).not.toBe(stored.Tools(support));
  for (const [row, of] of Object.entries(stored)) {
    await expect(
      compare
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: row, exact: true }) })
        .getByRole('cell'),
    ).toHaveText([row, of(navigator), of(support)]);
  }
});

test(`${J} #3 opens an agent's detail page: tools with inputs, outputs and refusal reasons; the permission mode; it acts as the person, never with broader access`, async ({
  page,
}) => {
  await openAgents(page, agents);
  // The detail page reads Navigator's stored guardrail; its own answer is what the page must show.
  const read = page.waitForResponse((r) => r.url().includes('/api/agents/trpc/agent.get'));
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Details' }).click();
  const stored = await (await read).json();
  const tools = tableIn(main(page), 'Tools');
  await expect(tools.getByRole('row').filter({ hasText: 'trade.quote' })).toBeVisible();
  for (const header of ['Inputs', 'Outputs', 'Refusals'])
    await expect(tools.getByRole('columnheader', { name: header })).toBeVisible(UNBUILT);
  // A tool that publishes no shape says so, rather than showing an empty cell.
  for (const cell of await tools.getByRole('cell').all()) await expect(cell).toHaveText(/\S/);
  // The permission mode is the one svc-agents stores for Navigator, in its words: research only.
  expect(stored?.result?.data?.capacityMode, JSON.stringify(stored).slice(0, 400)).toBe('research_only');
  const mode = main(page).getByRole('term').filter({ hasText: 'Permission mode' });
  await expect(mode).toBeVisible();
  await expect(mode.locator('xpath=following-sibling::dd[1]')).toHaveText(
    'Research only: it cannot place, change or cancel orders, or withdraw',
  );
  await expect(main(page)).toContainText('This agent acts as you, and never with more access than you have.');
});

test(`${J} #4 reads the rate card and asks for an estimate: the published rate, the worst case equal to the cap check, no expected range without history`, async ({
  page,
}) => {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Open a session' }).click();
  const rates = tableIn(main(page), 'Published engine routing prices');
  // The rate row is the service's published route, cell for cell, as routes.list answers it now.
  const routes = await agentsCall('routes.list', undefined, 'GET');
  expect(routes.status).toBe(200);
  const route = routes.body.result.data.find((row) => row.task === 'navigator.plan' && row.capability === 'complete');
  expect(route?.inputPerMillion && route?.outputPerMillion, 'the stack publishes both navigator.plan rates').toBeTruthy();
  const rateRow = rates.getByRole('row').filter({ has: page.getByRole('cell', { name: 'navigator.plan', exact: true }) });
  await expect(rateRow).toHaveCount(1);
  await expect(rateRow.getByRole('cell')).toHaveText([
    'navigator.plan',
    'complete',
    `${route.inputPerMillion} ${route.assetId}`,
    `${route.outputPerMillion} ${route.assetId}`,
  ]);
  await main(page).getByRole('button', { name: 'Estimate the cost' }).click(UNBUILT);
  const estimate = main(page).getByRole('region', { name: 'Cost estimate' });
  // The worst case is the figure the cap check holds a run against: the stored guardrail's session spend cap, which the
  // runtime passes as the run's agent cap (runtime.ts agentCapOf), in the route's fee asset.
  const guardrail = await agentsCall('agent.get', { agentId: 'navigator' }, 'GET');
  expect(guardrail.status).toBe(200);
  const cap = guardrail.body.result.data.limits.maxSpendPerSession;
  expect(cap, 'navigator has a stored session spend cap').toBeTruthy();
  await expect(estimate.getByTestId('worst-case')).toHaveText(`At most ${cap} ${route.assetId} for this run`);
  await expect(estimate).toContainText(
    'The worst case is the session’s spend cap: a run that could cost more is refused before the engine is called.',
  );
  await expect(estimate).toContainText('No expected range yet: this agent has no run history.');
});

/** One agents query or mutation through Edge as the run's account, on its own sign-in: `{ status, body }`. */
async function agentsCall(procedure, input, method = 'POST') {
  const door = await api(agents.account());
  return method === 'GET'
    ? door.get(`/api/agents/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
    : door.post(`/api/agents/trpc/${procedure}`, input);
}

/** The exact cost the service's rate card puts on `usage` for `task`: each token count times its published rate per
 * million, rounded up once at the ledger's last place (services/svc-agents/src/metering/pricing.ts). */
async function rateCardCost(task, usage) {
  const routes = await agentsCall('routes.list', undefined, 'GET');
  expect(routes.status).toBe(200);
  const route = routes.body.result.data.find((row) => row.task === task && row.capability === 'complete');
  expect(route, `the stack publishes a rate for ${task}`).toBeTruthy();
  const MILLION = 1_000_000n;
  const part = (tokens, rate) => (BigInt(tokens) * toUnits(rate) + MILLION - 1n) / MILLION;
  return { cost: part(usage.inputTokens, route.inputPerMillion) + part(usage.outputTokens, route.outputPerMillion), route };
}

/** The account's ledger balances, every asset, as the ledger answers them. */
const ledgerBalances = async () => (await api(agents.account())).balances();

test(`${J} #5 presses Run and confirms the spend ceiling: a run row before the engine; the reply and its exact cost; one request id twice is one run and one charge`, async ({
  page,
}) => {
  const sessionId = await openNavigatorSession(page, agents);
  agents.run.write({ sessionId });
  const before = await ledgerBalances();
  const ask = workspace(page).getByRole('textbox', { name: /^Ask the agent/ });
  await ask.fill('Where do I place a limit order?');

  // The stack's stand-in engine is held at its door (its hold file), so the run is read from the service itself while
  // the engine has not answered: the service's run row exists before the engine answers.
  const hold = stackFile('agents-engine.hold');
  const parked = `${hold}.held`;
  writeFileSync(hold, 'J-agents-01 #5');
  let first;
  let requestId;
  const runs = tableIn(workspace(page), 'Runs');
  const row = runs.getByRole('row').nth(1);
  try {
    const sent = page.waitForRequest((req) => req.url().endsWith('/api/agents/trpc/run.complete'));
    const answered = page.waitForResponse((res) => res.url().endsWith('/api/agents/trpc/run.complete'));
    await workspace(page).getByRole('button', { name: 'Run' }).click();
    const ceiling = page.getByRole('dialog', { name: 'Confirm the spend ceiling' });
    await expect(ceiling).toContainText('1 USDT');
    await ceiling.getByRole('button', { name: 'Run up to 1 USDT' }).click();
    requestId = JSON.parse((await sent).postData()).requestId;
    await expect.poll(() => existsSync(parked), { message: 'the engine is parked at its door' }).toBe(true);
    const during = await agentsCall('session.detail', { sessionId }, 'GET');
    expect(during.status).toBe(200);
    expect(during.body.result.data.runs).toEqual([{ requestId, startedAt: expect.any(String), state: 'running' }]);
    // Nothing is used or charged while the engine has not answered.
    const pending = await agentsCall('usage.current', { sessionId }, 'GET');
    expect(toUnits(pending.body.result.data.sessionTotal)).toBe(0n);
    await expect(row).toContainText('Running');
    rmSync(hold);
    first = await answered;
  } finally {
    rmSync(hold, { force: true });
  }
  expect(first.status()).toBe(200);
  const run = (await first.json()).result.data;
  // The reply is the engine's own answer to this request.
  await expect(workspace(page).getByRole('region', { name: 'Reply' }).getByTestId('more-body')).toHaveText(run.text, { timeout: 60_000 });
  expect(run.text.trim()).not.toBe('');
  // Its exact cost: the reported usage at the published rate, to the last place, shown on the row as the service billed it.
  const { cost } = await rateCardCost(run.action.task, run);
  expect(run.metered).toBe(true);
  expect(toUnits(run.cost)).toBe(cost);
  expect(cost > 0n).toBe(true);
  await expect(row).toContainText('Completed');
  await expect(row).toContainText(requestId);
  await expect(row.getByTestId('run-cost')).toHaveText(`${fromUnits(cost)} USDT`);
  agents.run.write({
    sessionId,
    requestId,
    task: run.action.task,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cost: run.cost,
  });

  // Sending the same request again (a retry after a lost answer) is refused as a replay: the first run is the only one,
  // and it charges once.
  const again = page.waitForResponse((res) => res.url().endsWith('/api/agents/trpc/run.complete'));
  await row.getByRole('button', { name: 'Send again' }).click();
  const second = await again;
  expect(JSON.parse(second.request().postData()).requestId).toBe(requestId);
  expect(second.status()).toBe(400);
  expect((await second.json()).error.data.cause.code).toBe('agents.request_id_replay');
  await expect(runs.getByRole('row')).toHaveCount(2);
  await expect(workspace(page).getByRole('status')).toContainText('Same request: the first run is shown and nothing was charged again.');
  // One charge: the session's usage is the one run's cost, its open window holds that cost once, and the ledger has
  // not moved yet (the window settles when it closes).
  const usage = await agentsCall('usage.current', { sessionId }, 'GET');
  expect(usage.status).toBe(200);
  expect(toUnits(usage.body.result.data.sessionTotal)).toBe(cost);
  expect(toUnits(usage.body.result.data.pending)).toBe(cost);
  expect(await ledgerBalances()).toEqual(before);
  // The service's own record: the session holds exactly this one run, completed, and one executed engine response.
  const detail = await agentsCall('session.detail', { sessionId }, 'GET');
  expect(detail.body.result.data.runs).toEqual([{ requestId, startedAt: expect.any(String), state: 'completed' }]);
  const log = await agentsCall('session.log', { sessionId, limit: 50 }, 'GET');
  expect(log.status).toBe(200);
  const engineRuns = log.body.result.data.filter((entry) => entry.kind === 'completion' && entry.status === 'executed');
  expect(engineRuns).toHaveLength(1);
  expect(engineRuns[0].cost).toBe(run.cost);
});

test(`${J} #6 closes the session: open windows settle once; a closed session refuses further actions`, async ({ page }) => {
  // The session #5 ran, with its usage window still open. A request this agent may not run is refused and logged first,
  // so the history #7 reads has a refusal in it; it bills nothing.
  const { cost } = agents.run.read();
  if (!cost) throw new Error(`${J} #5 recorded no run cost, so this step has no window to settle`);
  const beforeRefusal = await ledgerBalances();
  const refused = await agentsCall('run.complete', {
    sessionId: ranSession(),
    requestId: `${ranSession()}:not-allowed`,
    task: 'support.reply',
    messages: [{ role: 'user', content: 'TEST' }],
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error.message).toBe('agents.refused.task_not_allowed');
  // The refusal held and billed nothing: the ledger is as it was and the session's usage is still the one run.
  expect(await ledgerBalances()).toEqual(beforeRefusal);
  const usage = await agentsCall('usage.current', { sessionId: ranSession() }, 'GET');
  expect(usage.status).toBe(200);
  expect(toUnits(usage.body.result.data.sessionTotal)).toBe(toUnits(cost));
  expect(toUnits(usage.body.result.data.pending)).toBe(toUnits(cost));

  const before = await ledgerBalances();
  const selected = await selectRanSession(page);
  await selected.getByRole('button', { name: 'Close session' }).click();
  await expect(selected.getByRole('status')).toContainText('Session closed. Usage settled.');
  // One window, settled on its charge key for exactly the run's cost.
  const windows = tableIn(selected, 'Usage windows');
  await expect(windows.getByRole('row')).toHaveCount(2);
  const settled = windows.getByRole('row').filter({ hasText: 'Settled' });
  await expect(settled).toHaveCount(1);
  await expect(settled.getByTestId('window-cost')).toHaveText(`${cost} USDT`);
  await expect(settled.getByTestId('charge-key')).toHaveText(/^agent\.usage:\S+$/);
  // The ledger moved once, by the window's cost, as a fee from the account's USDT; nothing else moved.
  const after = await ledgerBalances();
  expect(toUnits(before.USDT.total) - toUnits(after.USDT.total)).toBe(toUnits(cost));
  expect(toUnits(before.USDT.free) - toUnits(after.USDT.free)).toBe(toUnits(cost));
  expect(after.USDT.used).toBe(before.USDT.used);
  expect({ ...after, USDT: undefined }).toEqual({ ...before, USDT: undefined });

  // Closing again settles nothing more, and the closed session takes no new request.
  await expect(selected.getByRole('button', { name: 'Close session' })).toHaveCount(0);
  await expect(selected).toContainText('This session is closed.');
  const closeAgain = await agentsCall('session.close', { sessionId: ranSession() });
  expect(closeAgain.status).toBe(200);
  expect(closeAgain.body.result.data.status).toBe('closed');
  const afterRun = await agentsCall('run.complete', {
    sessionId: ranSession(),
    requestId: `${ranSession()}:after-close`,
    task: agents.run.read().task,
    messages: [{ role: 'user', content: 'TEST' }],
  });
  expect(afterRun.status).toBe(400);
  expect(afterRun.body.error.data.cause.code).toBe('agents.session_closed');
  expect(await ledgerBalances()).toEqual(after);
});

test(`${J} #7 opens session history: the run with exact usage, refusal codes as words and no prompt text; the selection survives a reload and another device`, async ({
  page,
  browser,
}) => {
  const { inputTokens, outputTokens, cost } = agents.run.read();
  if (cost === undefined) throw new Error(`${J} #5 recorded no run, so this step has no usage to read`);
  // A newer session, so the one #5 ran is not simply the newest: what is shown below is the person's own selection.
  const newer = await agentsCall('session.open', { agentId: 'navigator' });
  expect(newer.status).toBe(200);

  const selected = await selectRanSession(page);
  const history = selected.getByRole('list', { name: 'Agent audit activity' });
  const engine = history.getByRole('listitem').filter({ hasText: 'Engine response · Executed' });
  await expect(engine).toHaveCount(1);
  const usage = async (item) => ({
    input: await item.getByRole('definition').nth(0).innerText(),
    output: await item.getByRole('definition').nth(1).innerText(),
    cost: await item.getByRole('definition').nth(2).innerText(),
  });
  expect(await usage(engine)).toEqual({ input: String(inputTokens), output: String(outputTokens), cost });
  // The refusal #6 caused, in words and with its code.
  const refusal = history.getByRole('listitem').filter({ hasText: 'Refused' });
  await expect(refusal).toContainText('This agent may not run that task agents.task_not_allowed');
  await expect(selected).not.toContainText('Where do I place a limit order?');

  await page.reload();
  await agentSection(page, 'Sessions');
  await expect(selected.getByRole('code')).toHaveText(ranSession());
  await expect(engine).toHaveCount(1);

  const other = await browser.newContext();
  try {
    const device = await other.newPage();
    await signIn(device, agents.account());
    await device.goto('/agents');
    await agentSection(device, 'Sessions');
    const there = device.getByRole('main').getByRole('region', { name: 'Selected session' });
    await expect(there.getByRole('code')).toHaveText(ranSession());
    expect(
      await usage(
        there.getByRole('list', { name: 'Agent audit activity' }).getByRole('listitem').filter({ hasText: 'Engine response · Executed' }),
      ),
    ).toEqual({
      input: String(inputTokens),
      output: String(outputTokens),
      cost,
    });
  } finally {
    await other.close();
  }
});
