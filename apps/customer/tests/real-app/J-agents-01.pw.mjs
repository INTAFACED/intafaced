// World: none
import { test, expect } from './journey.mjs';
import { UNBUILT, agentCard, agentSection, agentsRun, openAgents, openNavigatorSession, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { api, fromUnits, stackFile, toUnits } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { setPartner } from './partner.mjs';

// J-agents-01, in the running app (docs/roadmap/journeys.json): find an agent, check what it may do, and run it once.
// One test per step, titled "J-agents-01 #<n>", run in order on one verified TEST account whose payment method is the
// TEST partner bank: its money is held at the partner (`testPartner.set({ custody: 'off' })`, OWNER 226), funded there
// with TEST USDT. INTAFACED keeps no prepaid balance for it. The usage window is recorded once in our ledger as owed by
// the person (`charge:earned:agents:…`), equal to the stated window cost, and collected once from the partner balance
// (`charge:collected:partner-reserve:test:…`, keyed on the partner's own payment id); a retried request id charges once,
// and nothing else moves, in the partner's figures or in the person's own ledger balances. The run uses the stack's TEST
// rate card (tooling/profiles/test-owner-values/agents.json) and the service's sandbox engine; #5 to #7 check its cost
// against the published rate, the partner's own figures (svc-bank `spaces.list`, held at the TEST partner bank) and the
// ledger's own transactions, read by a founder through the console's ledger lookup.
// Not checkable on this stack: #1's empty state (the stack publishes five agents) and #2's ineligible agent (the TEST
// account is eligible for every customer agent). #1's disabled agent is the Portfolio planner, which no customer can run
// yet; J-agents-14 #7 checks a quarantined agent's card.
const J = 'J-agents-01';
const agents = agentsRun(J);
/** The TEST partner bank's name for itself (svc-bank `partner/test-partner.ts` TEST_PARTNER_LABEL). */
const PARTNER_BANK = 'TEST partner bank';
/** #5's question: it names a market, so the platform reads that market before the engine runs (J-agents-10 #4). */
const QUESTION = 'TEST: what moved BTC/USDT today?';
/** What the person holds at the TEST partner at the start, in TEST USDT. */
const AT_PARTNER = '10';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const workspace = (page) => main(page).getByRole('region', { name: 'Session workspace' });

/** A guardrail refusal code in the detail page's words (apps/customer agents-catalogue-copy, English); a code it does
 * not word stays the code itself. */
const REFUSAL_WORDS = {
  session_closed: 'The session is closed',
  action_limit: 'The session’s action budget is spent',
  tool_not_declared: 'This agent may never use it',
  module_not_allowed: 'Its module is not granted to this agent',
  mode_unknown: 'No known permission mode allows it',
  mode_forbids_write: 'The permission mode does not allow changes',
  withdraw_scope_required: 'Withdrawals need a separate grant',
  tool_call_limit: 'Its calls for this session are used up',
  approval_required: 'It waits for your approval',
  place_idempotency_required: 'An order needs its own request key',
  place_key_conflict: 'That request key already belongs to another order',
  task_not_allowed: 'This agent may not run that task',
  'copy_intel.returns_board_refused': 'Copy intelligence never ranks leaders by returns; nothing was run or charged',
  output_limit: 'It asked for more output than allowed',
  spend_limit: 'Its worst case would pass the spend cap',
  price_unset: 'No rate is published for this task',
  funds_insufficient: 'Your available balance is below its worst case',
  funds_unread: 'Your balance could not be read, so it did not start',
};
const refusalWords = (code) => REFUSAL_WORDS[code.replace(/^agents\./, '')] ?? code;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * What a comparison column's "Who may use it" cell says for one agent's stored eligibility (svc-agents `agent.get`), in
 * the page's English words: no rule; the person's plan granted; or left out, naming the very rule the service gives as
 * the reason (plan, age or region) and, for a plan rule, the plans it is published for and the person's own.
 */
function verdictFor(e) {
  if (e.rule === 'none') return /^No plan, age or region rule limits who may use it$/;
  const plan = (value) => (value === 'none' || value === '' ? 'none (not verified)' : value);
  if (e.eligible) return new RegExp(`^Your plan \\(${escape(plan(e.yourPlan))}\\) is one it is published for$`);
  if (!e.published)
    return new RegExp(`^Not on your ${escape(e.reason)}: no ${escape(e.reason)} is published for it, so no one can use it$`);
  return new RegExp(
    `^Not on your ${escape(e.reason)}: it is published for ${escape(e.plans.join(', '))}, and your account is on ${escape(plan(e.yourPlan))}$`,
  );
}

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

/** The person's USDT main balance as the partner reports it; the space says it is held at the TEST partner bank. */
async function partnerUsdt() {
  const res = await (
    await api(agents.account())
  ).get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const main = res.body.result.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  expect(main?.heldAt?.label, 'the person’s USDT is held at the TEST partner bank').toBe(PARTNER_BANK);
  return main.balance;
}

/** svc-ledger's own record of a business key, traced by founder A through the console's ledger lookup. */
async function ledgerTrace(browser, businessKey) {
  const context = await browser.newContext();
  try {
    const founder = await context.newPage();
    await founderSignIn(founder);
    const res = await founder.request.get(`${ADMIN}/api/ledger-lookup?businessKey=${encodeURIComponent(businessKey)}`);
    expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
    return await res.json();
  } finally {
    await context.close();
  }
}

/** The ledger keys of one usage window (packages/ledger-client recipes/charge.ts): earned, and collected on a payment. */
const earnedKey = (chargeKey) => `charge:earned:agents:${chargeKey.replace(/^agent\.usage:/, '').replace(':', '.')}`;
const collectedKey = (paymentRef) => `charge:collected:partner-reserve:test:USDT:${paymentRef}`;

test(`${J} starts: a verified TEST account whose payment method is the TEST partner bank, funded there with TEST USDT, opening Agents from More`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await agents.start(page, 'ag01');
  // The person's money is held by the TEST partner bank, not by us, and paid in there once.
  await setPartner(who, { custody: 'off' });
  const funded = await (
    await api(who)
  ).post('/api/bank/trpc/testPartner.fund', { fundId: `${J}-${who.email}`.slice(0, 64), assetId: 'USDT', amount: AT_PARTNER });
  expect(funded.status, JSON.stringify(funded.body).slice(0, 300)).toBe(200);
  expect(await partnerUsdt()).toBe(AT_PARTNER);
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
  // The catalogue is the stored list: the cards are exactly the agents svc-agents answers the page (agent.catalogue),
  // no more and no fewer, each with its stored status. A card for an agent the stored list does not hold would be a
  // sample card, which the step's words rule out (with none published, the empty state shows no card at all).
  const catalogue = page.waitForResponse((r) => r.ok() && new URL(r.url()).pathname.endsWith('/api/agents/trpc/agent.catalogue'));
  await openAgents(page, agents);
  await expect(main(page).getByRole('heading', { name: 'Agent catalogue' })).toBeVisible();
  const storedList = (await (await catalogue).json())?.result?.data ?? [];
  expect(storedList.length, 'the stack publishes agents').toBeGreaterThan(0);
  const LABEL = {
    navigator: 'Navigator',
    support: 'Support helper',
    scanner: 'Market scanner',
    merchant: 'Merchant watcher',
    'copy-intel': 'Copy intelligence',
    coach: 'Curriculum coach',
    launch: 'Launch check',
    growth: 'Growth drafts',
    portfolio: 'Portfolio planner',
    'risk-compliance': 'Risk and compliance',
  };
  const storedNames = storedList.map((row) => LABEL[row.agentId] ?? row.name ?? row.agentId).sort((a, b) => a.localeCompare(b));
  const cardNames = (await main(page).getByRole('article').getByRole('heading', { level: 3 }).allInnerTexts()).sort((a, b) =>
    a.localeCompare(b),
  );
  expect(cardNames, 'every card is a stored agent and every stored agent has a card').toEqual(storedNames);
  for (const row of storedList)
    await expect(agentCard(page, LABEL[row.agentId] ?? row.name ?? row.agentId).getByTestId('agent-status')).toHaveText(
      row.enabled ? 'Enabled' : 'Disabled',
    );
  // The stored list: the five session agents the stack registers, each a card.
  for (const name of ['Navigator', 'Support helper', 'Market scanner', 'Merchant watcher', 'Copy intelligence']) {
    await expect(agentCard(page, name)).toBeVisible();
  }
  const shownNames = async () =>
    (await main(page).getByRole('article').getByRole('heading', { level: 3 }).allInnerTexts()).sort((x, y) => x.localeCompare(y));
  // Search narrows the stored cards to the ones whose name matches, and clearing it brings every one back.
  const search = main(page).getByRole('textbox', { name: 'Search agents' });
  await search.fill('nav');
  await expect.poll(shownNames).toEqual(storedNames.filter((name) => /nav/i.test(name)));
  expect(await shownNames()).toEqual(['Navigator']);
  await search.fill('');
  await expect.poll(shownNames).toEqual(storedNames);
  // The kind filter keeps only the stored agents of that kind: metered sessions hide the room agents, and the room
  // filter shows only them.
  const SESSION = ['Navigator', 'Support helper', 'Market scanner', 'Merchant watcher', 'Copy intelligence'];
  const ROOM = ['Curriculum coach', 'Launch check', 'Growth drafts'];
  const kind = main(page).getByRole('combobox', { name: 'How it is used' });
  await kind.selectOption({ label: 'Metered session' });
  await expect.poll(shownNames).toEqual(storedNames.filter((name) => SESSION.includes(name)));
  await kind.selectOption({ label: 'Inside a room' });
  await expect.poll(shownNames).toEqual(storedNames.filter((name) => ROOM.includes(name)));
  expect(await shownNames(), 'the stack stores at least one room agent').not.toEqual([]);
  await kind.selectOption({ label: 'All' });

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
  // Eligibility, from the stored guardrail: each agent states who may use it, and the table says per column whether
  // this person may, naming the real reason (plan, age or region) when not.
  for (const [g, who] of [
    [navigator, 'navigator'],
    [support, 'support'],
  ])
    expect(g, `${who}'s stored guardrail states who may use it`).toHaveProperty('eligibility');
  const eligibility = compare.getByRole('row').filter({ has: page.getByRole('cell', { name: /eligib|who may use/i }) });
  await expect(eligibility).toHaveCount(1);
  const verdicts = eligibility.getByRole('cell');
  await expect(verdicts).toHaveCount(3);
  // Each column's verdict is that column's own stored eligibility, word for word.
  await expect(verdicts.nth(1)).toHaveText(verdictFor(navigator.eligibility));
  await expect(verdicts.nth(2)).toHaveText(verdictFor(support.eligibility));
});

test(`${J} #2 an agent the person is not eligible for shows the real reason (plan, age or region) in the comparison`, async ({
  browser,
}) => {
  // A second person, signed up for this step only, who is not verified: an agent whose stored eligibility asks for more
  // than this person has must say which rule (plan, age or region) leaves them out, in the comparison's own row.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const { signUpInBrowser } = await import('./stack.mjs');
    const { randomBytes } = await import('node:crypto');
    const handle = `ag01e${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    await signUpInBrowser(page, {
      handle,
      email: `${handle}@local-test.invalid`,
      password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
    });
    await page.goto('/agents');
    // Both columns' stored guardrails, each read as the page asks for it: each must say this person is left out and why.
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
    await agentCard(page, 'Navigator').getByRole('checkbox', { name: 'Compare' }).check(UNBUILT);
    await agentCard(page, 'Support helper').getByRole('checkbox', { name: 'Compare' }).check();
    await main(page).getByRole('button', { name: 'Compare 2 agents' }).click();
    const guardrails = await Promise.all(reads.map(async (answer) => (await (await answer).json())?.result?.data));
    for (const [g, who] of [
      [guardrails[0], 'navigator'],
      [guardrails[1], 'support'],
    ]) {
      expect(g, `${who}'s stored guardrail states who may use the agent`).toHaveProperty('eligibility');
      // The unverified person is not eligible, for a named rule, with the service's own refusal code.
      expect(g.eligibility, `${who}: ${JSON.stringify(g.eligibility)}`).toMatchObject({ eligible: false });
      expect(['plan', 'age', 'region'], `${who}'s reason`).toContain(g.eligibility.reason);
      expect(g.eligibility.code, `${who}'s refusal code`).toMatch(/^agents\.[a-z_]+$/);
    }
    const row = tableIn(main(page), 'Compare agents')
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: /eligib|who may use/i }) });
    await expect(row).toHaveCount(1);
    // Each column, not the row as a whole, says the person is left out and names the rule.
    const cells = row.getByRole('cell');
    await expect(cells).toHaveCount(3);
    // Each column names the very rule its own stored eligibility gives as the reason, with that column's plans.
    for (const [i, g] of guardrails.entries()) {
      await expect(cells.nth(i + 1)).toHaveText(verdictFor(g.eligibility));
      await expect(cells.nth(i + 1)).toContainText(`Not on your ${g.eligibility.reason}`);
    }
  } finally {
    await context.close();
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
  // Each declared tool, held to its stored guardrail row by row: its name, and every refusal it can return in words, in
  // the stored order. The stored guardrail publishes no input or output shape for a tool, so each such cell says so in
  // words, never an empty cell.
  const declared = stored?.result?.data?.tools ?? [];
  expect(declared.length, JSON.stringify(stored).slice(0, 400)).toBeGreaterThan(0);
  const rows = tools.getByRole('row').filter({ has: page.getByRole('cell') });
  await expect(rows).toHaveCount(declared.length);
  for (const [i, tool] of declared.entries()) {
    expect(tool.refusals.length, `${tool.name} declares the refusals it can return`).toBeGreaterThan(0);
    const cells = rows.nth(i).getByRole('cell');
    await expect(cells).toHaveCount(6);
    await expect(cells.nth(0)).toHaveText(tool.name);
    await expect(cells.nth(1)).toHaveText(tool.mode);
    await expect(cells.nth(2)).toHaveText(tool.requiresApproval ? 'Required' : 'None needed');
    // agent.get publishes no input or output shape for any tool, so both cells say so in words.
    expect(tool, `${tool.name} publishes no input shape`).not.toHaveProperty('inputs');
    expect(tool, `${tool.name} publishes no output shape`).not.toHaveProperty('outputs');
    await expect(cells.nth(3)).toHaveText('Not published by this agent');
    await expect(cells.nth(4)).toHaveText('Not published by this agent');
    // Every refusal is worded, never left as its raw code.
    for (const code of tool.refusals) expect(REFUSAL_WORDS[code.replace(/^agents\./, '')], `${tool.name}: ${code} has words`).toBeDefined();
    await expect(cells.nth(5).getByRole('listitem')).toHaveText(tool.refusals.map(refusalWords));
  }
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
  const partnerBefore = await partnerUsdt();
  const ask = workspace(page).getByRole('textbox', { name: /^Ask the agent/ });
  // A question about a market, so the reply comes with findings: the market the platform read itself before the engine ran.
  await ask.fill(QUESTION);

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
  // The reply is the engine's own answer to this request, sentence by sentence as the service returned it.
  const reply = workspace(page).getByRole('region', { name: 'Reply' }).getByTestId('more-body');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  expect(run.text.trim()).not.toBe('');
  const sentences = run.text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((t) => t.trim())
    .filter(Boolean);
  await expect(reply.locator('span[lang="und"]')).toHaveText(sentences);
  // With its findings: the one market the question names, read by the platform itself, with the figure and the time it
  // was observed, shown with the reply and stored with the run.
  expect(run.provenance?.sources, 'the reply carries its findings').toEqual([
    { id: 'S1', market: 'BTC/USDT', measure: 'last_price', value: expect.stringMatching(/^\d+(\.\d+)?$/), observedAt: expect.any(String) },
  ]);
  const [finding] = run.provenance.sources;
  const findings = workspace(page).getByRole('region', { name: 'Where this came from' });
  await expect(findings.getByTestId('research-source')).toHaveCount(1);
  await expect(findings.getByTestId('research-source')).toContainText(`[S1] BTC/USDT last traded price: ${finding.value}`);
  await expect(findings.getByTestId('research-observed-at')).toHaveAttribute('datetime', finding.observedAt);
  const stored = await agentsCall('run.get', { runId: run.runId }, 'GET');
  expect(stored.status).toBe(200);
  expect(stored.body.result.data.reply).toBe(run.text);
  expect(stored.body.result.data.provenance.sources).toEqual(run.provenance.sources);
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
  expect(await partnerUsdt()).toBe(partnerBefore);
  // The service's own record: the session holds exactly this one run, completed, and one executed engine response.
  const detail = await agentsCall('session.detail', { sessionId }, 'GET');
  expect(detail.body.result.data.runs).toEqual([{ requestId, startedAt: expect.any(String), state: 'completed' }]);
  const log = await agentsCall('session.log', { sessionId, limit: 50 }, 'GET');
  expect(log.status).toBe(200);
  const engineRuns = log.body.result.data.filter((entry) => entry.kind === 'completion' && entry.status === 'executed');
  expect(engineRuns).toHaveLength(1);
  expect(engineRuns[0].cost).toBe(run.cost);
});

test(`${J} #6 closes the session: open windows settle once; a closed session refuses further actions`, async ({ page, browser }) => {
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
  const partnerBefore = await partnerUsdt();
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
  const chargeKey = await settled.getByTestId('charge-key').innerText();
  // Collected from the person's payment method: the partner's own payment, named with the partner.
  const paidFrom = (await settled.getByTestId('paid-from').innerText()).trim();
  const paymentRef = paidFrom.match(/^TEST partner bank, payment (\S+)$/)?.[1];
  expect(paymentRef, `the window names the partner's payment: ${paidFrom}`).toBeTruthy();
  // The partner took exactly the window's cost from the person's balance there, once.
  expect(toUnits(partnerBefore) - toUnits(await partnerUsdt())).toBe(toUnits(cost));
  // We keep no prepaid balance: the person's own ledger balances did not move at all.
  const after = await ledgerBalances();
  expect(after).toEqual(before);
  // Our ledger recorded the window once as owed by the person, equal to its cost: one transaction under the window's
  // earned key, revenue up by the cost and the person's receivable down by it.
  const earned = await ledgerTrace(browser, earnedKey(chargeKey));
  expect(earned.found, `the ledger holds ${earnedKey(chargeKey)}`).toBe(true);
  expect(earned.transaction).toMatchObject({ businessKey: earnedKey(chargeKey), module: 'agents', reason: 'charge.earned' });
  expect(earned.transaction.postings).toHaveLength(2);
  for (const posting of earned.transaction.postings) {
    expect(posting).toMatchObject({ assetId: 'USDT' });
    expect(toUnits(posting.amount)).toBe(toUnits(cost));
  }
  const owedAt = earned.transaction.postings.find((p) => p.side === 'source');
  expect(toUnits(owedAt.balanceAfter) - toUnits(owedAt.balanceBefore)).toBe(-toUnits(cost));
  // And collected once, keyed on the partner's payment: what the person owes comes back to zero, our money at the
  // partner goes up by the cost.
  const collected = await ledgerTrace(browser, collectedKey(paymentRef));
  expect(collected.found, `the ledger holds ${collectedKey(paymentRef)}`).toBe(true);
  expect(collected.transaction).toMatchObject({ businessKey: collectedKey(paymentRef), module: 'agents', reason: 'charge.collected' });
  expect(collected.transaction.postings).toHaveLength(2);
  for (const posting of collected.transaction.postings) expect(toUnits(posting.amount)).toBe(toUnits(cost));
  const owedBack = collected.transaction.postings.find((p) => p.side === 'destination');
  expect(owedBack.accountId).toBe(owedAt.accountId);
  expect(toUnits(owedBack.balanceAfter)).toBe(0n);

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
  // Nothing more left the partner balance, and the window's keys still name those same two transactions.
  expect(toUnits(partnerBefore) - toUnits(await partnerUsdt())).toBe(toUnits(cost));
  expect((await ledgerTrace(browser, earnedKey(chargeKey))).transaction.txId).toBe(earned.transaction.txId);
  expect((await ledgerTrace(browser, collectedKey(paymentRef))).transaction.txId).toBe(collected.transaction.txId);
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
  await expect(selected).not.toContainText(QUESTION);

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
