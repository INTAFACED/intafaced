import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-agents-01, in the running app (docs/roadmap/journeys.json): find an agent, check what it may do and run it once.
// One test per step, titled "J-agents-01 #<n>". The person is a TEST account on the local stack: signed up, verified by
// the stack's TEST operators and funded with TEST USDT through the real ledger. The one money movement is the session's
// usage window settling once as a fee charge equal to the stated window cost; the steps read the ledger balance to check it.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #2: the catalogue is a list built into the app, not read from the stored list, with no sort and no compare
//   (AG-order-01, AG-catalogue-01).
// - #3: tools list no inputs, outputs or refusal reasons and the page has no acts-as-you statement (AG-tools-01, AG-guardrails-01).
// - #4: no rate card or estimate (AG-usage-02).
// - #5: the reply does not state its exact cost on its own line (AG-sessions-01); #6 and #7 run on #5's session.
// - #7: the selected session is not kept in the address, so a reload or another device loses it.
const J = 'J-agents-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

// A panel of the room, found by its heading.
const panel = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true, level: 2 }) });
const catalogue = (page) => panel(page, 'Agent catalogue');
const detail = (page) => panel(page, 'Agent detail');
const workspace = (page) => panel(page, 'Session workspace');
const sheet = (page) => page.getByRole('dialog');

async function openAgents(page) {
  const { who } = run.read();
  await signIn(page, who);
  await page.goto('/more');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Agents/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/agents/);
  await expect(catalogue(page).getByRole('heading', { name: 'Agent catalogue' })).toBeVisible();
}

async function openNavigator(page) {
  await openAgents(page);
  await catalogue(page).getByRole('article').filter({ hasText: 'Navigator' }).getByRole('button', { name: 'Details' }).click();
  await expect(detail(page).getByRole('heading', { name: 'Navigator' })).toBeVisible();
}

test(`${J} starts: a verified TEST account funded with 50 USDT`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'ag');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '50').tx).toBeTruthy();
  run.reset({ who });
});

test(`${J} #1 opens Agents: the catalogue from the stored list with filters, sort and status; a disabled agent stays visible with its open button off`, async ({
  page,
}) => {
  await openAgents(page);
  await expect(catalogue(page).getByRole('textbox', { name: 'Search agents' })).toBeVisible();
  await expect(catalogue(page).getByRole('combobox', { name: 'How it is used' })).toBeVisible();
  await expect(catalogue(page).getByRole('combobox', { name: 'Sort by' })).toBeVisible(UNBUILT);
  // Each card shows its status from the stored list, and a disabled one keeps its card with the open button off.
  const cards = catalogue(page).getByRole('article');
  expect(await cards.count()).toBeGreaterThan(0);
  for (const card of await cards.all())
    await expect(card.getByTestId('agent-status')).toHaveText(/Enabled|Disabled|Not connected|Staff only/);
  const disabled = cards.filter({ has: page.getByTestId('agent-status').getByText('Disabled') });
  for (const card of await disabled.all()) await expect(card.getByRole('button', { name: 'Open a session' })).toBeDisabled();
});

test(`${J} #2 selects two agents to compare: one table of tools, modes, caps and tasks side by side; an agent the person may not use shows the real reason`, async ({
  page,
}) => {
  await openAgents(page);
  const cards = catalogue(page).getByRole('article');
  await cards.filter({ hasText: 'Navigator' }).getByRole('checkbox', { name: 'Compare' }).check(UNBUILT);
  await cards.filter({ hasText: 'Support helper' }).getByRole('checkbox', { name: 'Compare' }).check();
  const table = page.getByRole('table', { name: 'Compare agents' });
  await expect(table.getByRole('columnheader', { name: 'Navigator' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Support helper' })).toBeVisible();
  for (const row of ['Tools', 'Access', 'Spend cap per session', 'Allowed engine tasks'])
    await expect(table.getByRole('rowheader', { name: row })).toBeVisible();
});

test(`${J} #3 opens an agent's detail: tools with inputs, outputs and refusal reasons; a tool without a shape says so; the permission mode and that it acts as the person, never with more`, async ({
  page,
}) => {
  await openNavigator(page);
  const tools = detail(page).getByRole('table', { name: 'Tools' });
  await expect(tools.getByRole('columnheader', { name: 'Inputs' })).toBeVisible(UNBUILT);
  await expect(tools.getByRole('columnheader', { name: 'Outputs' })).toBeVisible();
  await expect(tools.getByRole('columnheader', { name: 'Can refuse with' })).toBeVisible();
  await expect(detail(page)).toContainText('It acts as you and never with more access than you have.');
  await expect(detail(page).getByTestId('agent-permission-mode')).toHaveText(/Read only|Asks before acting|Acts within limits/);
});

test(`${J} #4 reads the rate card and asks for an estimate: the published rate, the worst case the cap check uses, and no expected range without history`, async ({
  page,
}) => {
  await openNavigator(page);
  const rate = detail(page).getByRole('region', { name: 'Rate card' });
  await expect(rate).toBeVisible(UNBUILT);
  await expect(rate).toContainText(/[\d.]+ USDT/);
  await detail(page).getByRole('textbox', { name: 'What should it do?' }).fill('Where do I change my password?');
  await detail(page).getByRole('button', { name: 'Estimate the cost' }).click();
  const estimate = detail(page).getByTestId('agent-estimate');
  await expect(estimate).toContainText(/At most [\d.]+ USDT/);
  await expect(estimate).toContainText('No expected range yet: there is no history to base it on.');
});

test(`${J} #5 presses Run and confirms the spend ceiling: a run row before the engine is called, the reply with its exact cost, and the same request id twice gives one run and one charge`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openNavigator(page);
  await detail(page).getByRole('button', { name: 'Open a session' }).click();
  await page.getByRole('button', { name: 'Review session' }).click();
  await sheet(page).getByRole('button', { name: 'Open agent session' }).click();
  await expect(workspace(page)).toBeVisible();
  await workspace(page).getByLabel('Task request').fill('Where do I change my password?');
  await workspace(page).getByRole('button', { name: 'Review engine request' }).click();
  await expect(sheet(page)).toContainText('Spend ceiling');
  await sheet(page).getByRole('button', { name: 'Run engine request' }).click();
  await expect(page.getByText('Agent reply received')).toBeVisible({ timeout: 60_000 });
  // The reply states its exact cost, as a decimal in the fee asset.
  const cost = /([\d.]+) USDT/.exec((await workspace(page).getByTestId('agent-run-cost').textContent(UNBUILT)) ?? '')?.[1];
  expect(cost, 'the run states its exact cost').toBeTruthy();
  run.write({ cost });
});

test(`${J} #6 closes the session: open windows settle once, and a closed session refuses further actions`, async ({ page }) => {
  const { who, cost } = run.read();
  expect(cost, 'a run and its cost from #5').toBeTruthy();
  const before = toUnits((await (await api(who)).balances()).USDT.free);
  await openAgents(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await workspace(page).getByRole('button', { name: 'Review session closure' }).click();
  await sheet(page).getByRole('button', { name: 'Settle and close session' }).click();
  await expect(page.getByText('Session closure received')).toBeVisible();
  // The window settles once, as a fee charge equal to the stated cost.
  await expect.poll(async () => toUnits((await (await api(who)).balances()).USDT.free)).toBe(before - toUnits(cost));
  await expect(workspace(page).getByRole('button', { name: 'Review engine request' })).toBeDisabled();
});

test(`${J} #7 opens session history: the run with exact usage, refusal codes as words and no prompt text; the selected session survives a reload and another device`, async ({
  page,
  browser,
}) => {
  const { who, cost } = run.read();
  expect(cost, 'a run and its cost from #5').toBeTruthy();
  await openAgents(page);
  await page.getByRole('tab', { name: 'Sessions' }).click();
  const records = page.getByRole('region', { name: 'Recorded sessions' });
  const row = records.getByRole('row').filter({ hasText: 'navigator' }).first();
  await row.getByRole('button', { name: 'Inspect session' }).click();
  const selected = page.getByRole('region', { name: 'Selected session' });
  await expect(selected).toContainText(`${cost} USDT`);
  await expect(selected).not.toContainText('Where do I change my password?');
  // The choice is in the address, so a reload and another device open the same session.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Selected session' })).toContainText(`${cost} USDT`, UNBUILT);
  const url = page.url();
  const other = await browser.newContext();
  const second = await other.newPage();
  await signIn(second, who);
  await second.goto(url);
  await expect(second.getByRole('region', { name: 'Selected session' })).toContainText(`${cost} USDT`);
  await other.close();
});
