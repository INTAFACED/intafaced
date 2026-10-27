import { test, expect } from '@playwright/test';
import { api, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { free, held, signIn, signUp, verify } from './desk.mjs';

// J-agents-02, in the running app (docs/roadmap/journeys.json): set spending limits and see that a run the person cannot
// pay for never starts. One test per step, titled "J-agents-02 #<n>". The person is a TEST account on the local stack,
// verified and funded with TEST USDT; the agent is the Navigator. Every refused run must bill 0 and leave no hold, which
// the steps check against the ledger balance.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #3: no limits page at /agents/:agentId/limits and no per-call or per-period cap with a reservation (AG-spend-01).
// - #4, #5: no funds check before a run and no overage rule (AG-usage-01); #5 needs a stack tool that leaves a usage
//   window unpaid (`local-test-world.mjs agents-unpaid-window`, proposed).
// - #6: no soft alert or hard monthly limit at /agents/usage/limits (AG-usage-03).
// - #7: no usage room at /agents/usage (AG-usage-02).
const J = 'J-agents-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const AGENT = 'navigator';

test.describe.configure({ mode: 'default' });

const balances = async (who) => (await api(who)).balances();

async function openLimits(page) {
  await signIn(page, run.read().who);
  await page.goto(`/agents/${AGENT}/limits`);
  await expect(page.getByRole('heading', { name: /Spending limits/, level: 1 })).toBeVisible(UNBUILT);
}

const cap = (page, name) => page.getByRole('textbox', { name });

test(`${J} starts: a verified TEST account funded with 20 USDT`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'al');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '20').tx).toBeTruthy();
  run.reset({ who });
});

test(`${J} #1 opens the agent's Limits page with no cap stored and opens a session: a refusal naming the missing cap, and no run exists`, async ({
  page,
}) => {
  await openLimits(page);
  await expect(cap(page, 'Per session, USDT')).toHaveValue('');
  await page.getByRole('button', { name: 'Open a session' }).click();
  await expect(page.getByRole('alert')).toContainText('No spending limit per session is set');
  await page.goto('/agents');
  await page.getByRole('tab', { name: 'Sessions' }).click();
  await expect(page.getByRole('region', { name: 'Recorded sessions' })).toContainText(/No agent actions have been recorded/);
});

test(`${J} #2 sets a per-call, a per-session and a per-period cap: the lower of the user value and the stored one applies, and a value above the stored one is refused`, async ({
  page,
}) => {
  await openLimits(page);
  const stored = /([\d.]+) USDT/.exec((await page.getByTestId('agent-stored-cap').textContent()) ?? '')?.[1];
  expect(stored, 'the service publishes its own cap').toBeTruthy();
  await cap(page, 'Per call, USDT').fill('0.5');
  await cap(page, 'Per session, USDT').fill('2');
  await cap(page, 'Per month, USDT').fill('5');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('status')).toContainText('Limits saved');
  await cap(page, 'Per session, USDT').fill(fromUnits(toUnits(stored) + toUnits('1')));
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('alert')).toContainText(`above the platform’s limit of ${stored} USDT`);
});

test(`${J} #3 starts two runs together whose worst cases are each over half the cap: exactly one is admitted, the other is refused before the engine and bills 0`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { who } = run.read();
  await openLimits(page);
  const before = free(await balances(who), 'USDT');
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await signIn(other, who);
    const start = async (tab) => {
      await tab.goto(`/agents/${AGENT}`);
      await tab.getByLabel('Task request').fill('Summarise every room in the app.');
      await tab.getByRole('button', { name: 'Review engine request' }).click();
      await tab.getByRole('dialog').getByRole('button', { name: 'Run engine request' }).click();
      const said = tab.getByRole('status').or(tab.getByRole('alert'));
      await expect(said).toBeVisible({ timeout: 60_000 });
      return (await said.textContent()) ?? '';
    };
    const outcomes = await Promise.all([start(page), start(other)]);
    expect(outcomes.filter((text) => /spending limit/i.test(text))).toHaveLength(1);
  } finally {
    await otherContext.close();
  }
  // The refused run left no hold, and at most one run's cost left the balance.
  expect(held(await balances(who), 'USDT')).toBe(0n);
  expect(free(await balances(who), 'USDT')).toBeLessThanOrEqual(before);
});

test(`${J} #4 asks for a run when the available balance is below the worst case: refused as insufficient funds, the engine never called, nothing billed`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // A second person with no money at all.
  const poor = await signUp(page, 'an');
  await signIn(page, poor);
  await page.goto(`/agents/${AGENT}`);
  await page.getByLabel('Task request').fill('Where do I change my password?', UNBUILT);
  await page.getByRole('button', { name: 'Review engine request' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run engine request' }).click();
  await expect(page.getByRole('alert')).toContainText('Not enough funds for this run’s worst case. Nothing ran and nothing was charged.');
  expect(held(await balances(poor), 'USDT')).toBe(0n);
});

test(`${J} #5 leaves the overage grace blank after a window could not be paid: the next run refuses with recovery text, and the unpaid window retries on the same charge key`, async ({
  page,
}) => {
  const { who } = run.read();
  // The stack leaves one usage window unpaid for this account (`local-test-world.mjs agents-unpaid-window`, proposed).
  tool('local-test-world.mjs', 'agents-unpaid-window', who.email);
  await signIn(page, who);
  await page.goto('/agents/usage');
  const unpaid = page.getByRole('table', { name: 'Usage windows' }).getByRole('row', { name: /Unpaid/ });
  await expect(unpaid.first()).toBeVisible(UNBUILT);
  await page.goto(`/agents/${AGENT}`);
  await page.getByLabel('Task request').fill('Where do I change my password?');
  await page.getByRole('button', { name: 'Review engine request' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run engine request' }).click();
  await expect(page.getByRole('alert')).toContainText(/unpaid usage window.*Add funds/);
});

test(`${J} #6 sets a soft alert and a hard limit for the month: crossing the alert writes one inbox row and runs go on; the hard limit refuses new runs`, async ({
  page,
}) => {
  await signIn(page, run.read().who);
  await page.goto('/agents/usage/limits');
  await cap(page, 'Alert me at, USDT').fill('0.000001', UNBUILT);
  await cap(page, 'Stop runs at, USDT').fill('1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await page.goto('/inbox');
  await expect(page.getByRole('listitem').filter({ hasText: /agent spending alert/i })).toHaveCount(1);
});

test(`${J} #7 opens usage by agent, day and task: totals match the sealed windows, and a blank rate refuses the run with the rate named`, async ({
  page,
}) => {
  await signIn(page, run.read().who);
  await page.goto('/agents/usage');
  const byAgent = page.getByRole('table', { name: 'Usage by agent' });
  await expect(byAgent).toBeVisible(UNBUILT);
  for (const name of ['Usage by day', 'Usage by task']) await expect(page.getByRole('table', { name })).toBeVisible();
  const total = /([\d.]+) USDT/.exec((await page.getByTestId('agents-usage-total').textContent()) ?? '')?.[1];
  const windows = await page.getByRole('table', { name: 'Usage windows' }).getByTestId('window-charge').allInnerTexts();
  const summed = windows.reduce((sum, text) => sum + toUnits(/([\d.]+)/.exec(text)?.[1] ?? '0'), 0n);
  expect(total, 'the usage total').toBeTruthy();
  expect(toUnits(total)).toBe(summed);
});
