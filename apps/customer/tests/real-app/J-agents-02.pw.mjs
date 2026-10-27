import { test, expect } from '@playwright/test';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { toUnits } from './stack.mjs';

// J-agents-02, in the running app (docs/roadmap/journeys.json): set my spending limits and see that a run I cannot pay
// for never starts. One test per step, titled "J-agents-02 #<n>", run in order on one verified TEST account funded with
// TEST USDT and an agent of the person's own. Per-call, per-session and per-period caps reserve before the engine is
// called; a refused run bills 0 and leaves no hold; charges equal sealed windows. Push and email delivery of an alert
// show their vendor notice (vendor.push, vendor.email); the in-app inbox row is written regardless.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create an agent of their own (no builder at /agents/new, AG-builder-01), so there is no agent page
//   with a Limits tab (AG-spend-01), no usage alerts (AG-usage-03) and no usage view by agent, day and task (AG-usage-02);
// - opening any session is refused for a standard account ("agents:execute"), so no run is admitted or refused yet.
// Not checkable on this stack yet: #7's blank-rate refusal, since the stack publishes a rate for every task; it can be
// once the founder console can change a route's rate (J-agents-20).
const J = 'J-agents-02';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const limits = (page) => main(page).getByRole('form', { name: 'Spending limits' });

test(`${J} starts: a verified TEST account funded with TEST USDT and an agent of the person's own`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag02', '20');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 opens the agent's Limits page with no cap stored and opens a session: a refusal naming the missing cap and no run exists`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Limits');
  await expect(limits(page).getByRole('textbox', { name: /^Per call/ })).toHaveValue('');
  await main(page).getByRole('button', { name: 'Open a session' }).click();
  await expect(main(page).getByRole('alert')).toContainText('agents.spend.cap_unset');
  await expect(tableIn(main(page), 'Runs').getByRole('row')).toHaveCount(1);
});

test(`${J} #2 sets a per-call, a per-session and a per-period cap: the lower of the user value and the stored one applies; above the stored one is refused`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Limits');
  await limits(page)
    .getByRole('textbox', { name: /^Per call/ })
    .fill('0.2');
  await limits(page)
    .getByRole('textbox', { name: /^Per session/ })
    .fill('0.5');
  await limits(page)
    .getByRole('textbox', { name: /^Per month/ })
    .fill('5');
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  await expect(limits(page).getByRole('status')).toHaveText('Limits saved.');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('0.5 USDT applies');
  // The agent's own stored cap is 1 per session: a user value above it is refused rather than raised.
  await limits(page)
    .getByRole('textbox', { name: /^Per session/ })
    .fill('3');
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  await expect(limits(page).getByRole('alert')).toContainText('above the agent’s own cap of 1 USDT');
});

test(`${J} #3 starts two runs together whose worst cases are each more than half the cap: exactly one is admitted, the other refused before the engine and bills 0`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  const run = main(page).getByRole('button', { name: 'Run twice at once' });
  await run.click(UNBUILT);
  const runs = tableIn(main(page), 'Runs');
  await expect(runs.getByRole('row').filter({ hasText: 'Admitted' })).toHaveCount(1);
  const refused = runs.getByRole('row').filter({ hasText: 'Refused' });
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText('agents.spend.cap_exceeded');
  await expect(refused.getByTestId('run-cost')).toHaveText('0 USDT');
});

test(`${J} #4 asks for a run when the available balance is below the worst case: refused as insufficient funds, the engine never called, nothing billed`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A second TEST person with 0.1 USDT and the same kind of agent (cap 1 per session): the worst case is above the balance.
  const poor = await fundedTrader(page, 'ag02p', '0.1');
  await signIn(page, poor);
  await createOwnAgent(page);
  await page.goto('/agents');
  await main(page).getByRole('link', { name: OWN_AGENT, exact: true }).click(UNBUILT);
  await main(page).getByRole('button', { name: 'Open a session' }).click();
  await main(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await main(page).getByRole('button', { name: 'Run' }).click();
  await expect(main(page).getByRole('alert')).toContainText('Your available balance is below this run’s worst case, so it did not start.');
  await expect(tableIn(main(page), 'Runs').getByRole('row').nth(1).getByTestId('run-cost')).toHaveText('0 USDT');
});

test(`${J} #5 leaves the overage grace value blank after a window could not be paid: the next run refuses with recovery text; the unpaid window retries on its charge key`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Usage');
  const unpaid = tableIn(main(page), 'Usage windows').getByRole('row').filter({ hasText: 'Unpaid' });
  await expect(unpaid).toHaveCount(1, UNBUILT);
  await expect(main(page).getByRole('alert')).toContainText('A usage window is unpaid. Add funds and it is retried on the same charge.');
  await expect(unpaid.getByTestId('charge-key')).toHaveText(/^agents\.usage:/);
});

test(`${J} #6 sets a soft alert and a hard limit for the month: one inbox row at the alert; push or email shows its vendor notice; the hard limit refuses new runs`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Limits');
  await limits(page)
    .getByRole('textbox', { name: /^Alert me at/ })
    .fill('0.01', UNBUILT);
  await limits(page)
    .getByRole('textbox', { name: /^Hard limit for the month/ })
    .fill('0.02');
  await limits(page).getByRole('checkbox', { name: 'Also by email' }).check();
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  await expect(limits(page).getByRole('note').filter({ hasText: 'vendor.email' })).toBeVisible();
  // The inbox row is written whatever the email vendor does.
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('dialog', { name: /Notifications/ }).getByText('Agent spend passed your alert')).toHaveCount(1);
  await page.keyboard.press('Escape');
  // Past the hard limit a new run is refused (a run already in flight finishes).
  await main(page).getByRole('button', { name: 'Open a session' }).click();
  await main(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await main(page).getByRole('button', { name: 'Run' }).click();
  await expect(main(page).getByRole('alert')).toContainText('agents.usage.hard_limit_reached');
});

test(`${J} #7 opens usage by agent, day and task: totals match the sum of the sealed windows; a blank rate refuses the run with the rate named`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Usage');
  const usage = tableIn(main(page), 'Usage by day and task');
  await expect(usage).toBeVisible(UNBUILT);
  const sealed = tableIn(main(page), 'Usage windows');
  // Exact sums in scaled units, never floats: each cell is a decimal string such as "0.00012345 USDT".
  const sum = async (table, id) =>
    (await table.getByTestId(id).allInnerTexts()).reduce((total, text) => total + toUnits(text.replace(/ USDT$/, '')), 0n);
  expect(await sum(usage, 'usage-cost')).toBe(await sum(sealed, 'window-cost'));
});
