import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, openAgents, openNavigatorSession, tableIn } from './agents.mjs';
import { toUnits } from './stack.mjs';

// J-agents-13, in the running app (docs/roadmap/journeys.json): review what my agents did: analytics, a run trace and my
// activity log. One test per step, titled "J-agents-13 #<n>", run in order on one verified TEST account with a metered
// Navigator session. Read only: displayed spend equals the sum of sealed windows, and an export covers the full range.
// What is built: the Activity section ("Your agent action log"). Steps not built yet fail at their first missing part,
// quickly (UNBUILT):
// - there is no dashboard, run trace, outcome filter, export or usage breakdown (AG-analytics-01, AG-audit-01,
//   AG-usage-02), and opening a session is refused for a standard account ("agents:execute"), so nothing is recorded.
// Not drivable on the stack: sessions across several days (one run makes one day's rows) and #4's 600 actions; #4
// checks that the export holds every row the log counts, however many are loaded.
const J = 'J-agents-13';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const dashboard = (page) => main(page).getByRole('region', { name: 'Agent dashboard' });

/** Sums a column of decimal USDT cells as scaled bigints. */
const sum = (cells) => cells.reduce((total, cell) => total + toUnits(cell.replace(/[^\d.]/g, '') || '0'), 0n);

test(`${J} starts: a verified TEST account with a metered Navigator session that ran`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag13', '20');
  await openNavigatorSession(page, agents);
});

test(`${J} #1 opens the dashboard for a date range: counts, outcomes by day and spend equal to the stored rows; test runs out unless included; a blank range refuses`, async ({
  page,
}) => {
  await openAgents(page, agents, 'Dashboard');
  await dashboard(page).getByRole('textbox', { name: /^To/ }).fill('', UNBUILT);
  await dashboard(page).getByRole('button', { name: 'Show' }).click();
  await expect(dashboard(page).getByRole('alert')).toContainText('To');
  const today = new Date().toISOString().slice(0, 10);
  await dashboard(page).getByRole('textbox', { name: /^From/ }).fill(today);
  await dashboard(page).getByRole('textbox', { name: /^To/ }).fill(today);
  await dashboard(page).getByRole('button', { name: 'Show' }).click();
  const byDay = tableIn(dashboard(page), 'Outcomes by day');
  await expect(byDay.getByRole('row')).toHaveCount(2);
  await expect(dashboard(page).getByRole('checkbox', { name: 'Include test and dry runs' })).not.toBeChecked();
  const spend = await dashboard(page).getByTestId('dashboard-spend').innerText();
  await openAgents(page, agents, 'Sessions');
  const costs = tableIn(main(page), 'Usage windows').getByTestId('window-cost');
  await expect(costs).not.toHaveCount(0);
  expect(sum([spend])).toBe(sum(await costs.allInnerTexts()));
});

test(`${J} #2 opens one run's trace: tool calls, timing, cost and the plan as timed steps`, async ({ page }) => {
  await openAgents(page, agents, 'Sessions');
  await main(page).getByRole('button', { name: 'Open trace' }).first().click(UNBUILT);
  const trace = tableIn(main(page), 'Run trace');
  for (const column of ['Step', 'Tool', 'Started', 'Took', 'Cost'])
    await expect(trace.getByRole('columnheader', { name: column })).toBeVisible();
  await expect(trace.getByRole('row').filter({ hasText: 'Plan' })).not.toHaveCount(0);
});

test(`${J} #3 opens Activity and filters to refused: only refused rows, the code as words, no prompt text`, async ({ page }) => {
  await openAgents(page, agents, 'Activity');
  await expect(main(page).getByRole('heading', { name: 'Your agent action log' })).toBeVisible();
  await main(page).getByRole('combobox', { name: 'Outcome' }).selectOption({ label: 'Refused' }, UNBUILT);
  const log = tableIn(main(page), 'Agent actions');
  await expect(log.getByTestId('action-outcome')).not.toHaveCount(0);
  await expect(log.getByTestId('action-outcome').filter({ hasNotText: /^Refused$/ })).toHaveCount(0);
  await expect(log.getByTestId('action-reason').filter({ hasText: /^[a-z_.]+$/ })).toHaveCount(0);
  await expect(log).not.toContainText('TEST: list the markets');
});

test(`${J} #4 presses Export on the log: the file holds every row the log counts with the same filter, in two formats`, async ({
  page,
}) => {
  await openAgents(page, agents, 'Activity');
  await main(page).getByRole('combobox', { name: 'Outcome' }).selectOption({ label: 'All' }, UNBUILT);
  const total = Number(await main(page).getByTestId('log-total').innerText());
  await expect(main(page).getByRole('combobox', { name: 'Export format' }).getByRole('option')).toHaveText(['CSV', 'JSON']);
  const download = page.waitForEvent('download');
  await main(page).getByRole('button', { name: 'Export' }).click();
  const file = readFileSync(await (await download).path(), 'utf8')
    .trim()
    .split('\n');
  expect(file.length - 1).toBe(total);
});

test(`${J} #5 opens usage by agent, user and task: totals match the sum of the windows`, async ({ page }) => {
  await openAgents(page, agents, 'Usage');
  await expect(tableIn(main(page), 'By agent')).toBeVisible(UNBUILT);
  await expect(tableIn(main(page), 'Usage windows').getByTestId('window-cost')).not.toHaveCount(0);
  const windows = sum(await tableIn(main(page), 'Usage windows').getByTestId('window-cost').allInnerTexts());
  for (const breakdown of ['By agent', 'By user', 'By task'])
    expect(sum(await tableIn(main(page), breakdown).getByTestId('usage-cost').allInnerTexts())).toBe(windows);
});
