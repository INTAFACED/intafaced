import { test, expect } from '@playwright/test';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { api, toUnits, tool } from './stack.mjs';

// J-agents-02, in the running app (docs/roadmap/journeys.json): set my spending limits and see that a run I cannot pay
// for never starts. One test per step, titled "J-agents-02 #<n>", run in order on one verified TEST account funded with
// TEST USDT and an agent of the person's own. Per-call, per-session and per-period caps reserve before the engine is
// called; a refused run bills 0 and leaves no hold; charges equal sealed windows. Push and email delivery of an alert
// show their vendor notice (vendor.push, vendor.email); the in-app inbox row is written regardless.
// #1-#5 run on the agent's Limits, Test and Usage pages (AG-spend-01). Still unbuilt, failing at their first missing
// part within UNBUILT: usage alerts and the hard monthly limit (AG-usage-03, #6), and usage by agent, day and task
// (AG-usage-02, #7).
// Numbers: the agent's own cap is 1 USDT per session; the person sets 0.012 per call, 0.02 per session and 5 a month.
// One run's worst case on the stack's test engine is just over 0.01024 USDT (2048 output tokens at 5 per million, plus
// its input at 1 per million), so one fits the per-call cap and two together pass the per-session cap.
// Not checkable on this stack yet: #7's blank-rate refusal, since the stack publishes a rate for every task; it can be
// once the founder console can change a route's rate (J-agents-20).
const J = 'J-agents-02';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const limits = (page) => main(page).getByRole('form', { name: 'Spending limits' });
const session = (page) => main(page).getByRole('region', { name: 'Session' });
const pages = (page) => page.getByRole('group', { name: 'Agent pages' });
/** The person's ledger balances, every asset, as the ledger answers them through Edge. */
const ledgerBalances = async (who) => (await api(who)).balances();
/** Sets the agent's own cap per session on its Build page, where the person who built it stores it. */
async function setAgentCap(page, cap) {
  await pages(page).getByRole('button', { name: 'Build', exact: true }).click();
  const builder = page.getByRole('form', { name: 'Agent builder' });
  await builder.getByRole('textbox', { name: /^Spend cap per session/ }).fill(cap);
  await builder.getByRole('button', { name: 'Save draft' }).click();
  await expect(builder.getByRole('status')).toHaveText('Draft saved.');
  await pages(page).getByRole('button', { name: 'Limits', exact: true }).click();
}

/** A fresh TEST person's own agent, opened on Limits with the journey's caps saved (0.012 per call, 0.02, 5 a month). */
async function ownAgentWithLimits(page, who) {
  await signIn(page, who);
  await createOwnAgent(page);
  await page.goto('/agents');
  await main(page).getByRole('link', { name: OWN_AGENT, exact: true }).click(UNBUILT);
  await pages(page).getByRole('button', { name: 'Limits', exact: true }).click();
  await limits(page)
    .getByRole('textbox', { name: /^Per call/ })
    .fill('0.012');
  await limits(page)
    .getByRole('textbox', { name: /^Per session/ })
    .fill('0.02');
  await limits(page)
    .getByRole('textbox', { name: /^Per month/ })
    .fill('5');
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  await expect(limits(page).getByRole('status')).toHaveText('Limits saved.');
}
/**
 * The person's own bank spaces through Edge. Moving USDT from the main space into a savings pot is a real outflow: it
 * leaves the balance an agent's usage is charged from, as a withdrawal would.
 */
async function bankOf(who) {
  const client = await api(who);
  const answer = ({ status, body }) => {
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    return body.result.data;
  };
  const list = async () =>
    answer(await client.get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  return {
    main: async () => (await list()).find((s) => s.kind === 'primary' && s.assetId === 'USDT'),
    pot: async (name) => answer(await client.post('/api/bank/trpc/spaces.create', { assetId: 'USDT', name })),
    move: async (transferId, from, to, amount) =>
      answer(await client.post('/api/bank/trpc/transfers.create', { transferId, fromSpaceId: from, toSpaceId: to, amount })),
  };
}

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
  for (const name of [/^Per call/, /^Per session/, /^Per month/]) await expect(limits(page).getByRole('textbox', { name })).toHaveValue('');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('No cap per session applies yet, so no session opens.');
  await main(page).getByRole('button', { name: 'Open a session' }).click();
  const refusal = main(page).getByRole('alert');
  await expect(refusal).toContainText('Set this agent’s spending limits first');
  await expect(refusal.locator('code')).toHaveText('agents.spend.cap_unset');
  await expect(session(page).getByText('No session is open.')).toBeVisible();
  // No run exists: the runs table, read again from the service after a reload, has only its header.
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Limits', exact: true }).click();
  await expect(tableIn(main(page), 'Runs').getByRole('row')).toHaveCount(1);
  await expect(main(page).getByText('This agent has not run.')).toBeVisible();
});

test(`${J} #2 sets a per-call, a per-session and a per-period cap: the lower of the user value and the stored one applies; above the stored one is refused`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Limits');
  const field = (name) => limits(page).getByRole('textbox', { name });
  await field(/^Per call/).fill('0.012');
  await field(/^Per session/).fill('0.02');
  await field(/^Per month/).fill('5');
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  await expect(limits(page).getByRole('status')).toHaveText('Limits saved.');
  // The agent's own stored cap is 1 per session; the person's 0.02 is lower, so 0.02 applies.
  await expect(limits(page).getByTestId('agent-cap')).toHaveText('The agent’s own cap per session: 1 USDT.');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('0.02 USDT applies');
  // A user value above the stored cap is refused rather than raised, and the saved caps are unchanged.
  await field(/^Per session/).fill('3');
  await limits(page).getByRole('button', { name: 'Save limits' }).click();
  const refusal = limits(page).getByRole('alert');
  await expect(refusal).toContainText('That is above the agent’s own cap of 1 USDT.');
  await expect(refusal.locator('code')).toHaveText('agents.spend.above_agent_cap');
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Limits', exact: true }).click();
  await expect(field(/^Per call/)).toHaveValue('0.012');
  await expect(field(/^Per session/)).toHaveValue('0.02');
  await expect(field(/^Per month/)).toHaveValue('5');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('0.02 USDT applies');
  // The other direction: the agent's stored cap lowered to 0.01, below the person's 0.02, is the one that applies, and
  // a run whose worst case (just over 0.01024) is above it is refused before the engine and bills 0.
  await setAgentCap(page, '0.01');
  await expect(limits(page).getByTestId('agent-cap')).toHaveText('The agent’s own cap per session: 0.01 USDT.');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('0.01 USDT applies');
  await expect(field(/^Per session/)).toHaveValue('0.02');
  const before = await ledgerBalances(agents.account());
  await session(page).getByRole('button', { name: 'Open a session' }).click();
  await expect(session(page).getByText('Session open:')).toBeVisible();
  await session(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await session(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(session(page).getByRole('alert').locator('code')).toHaveText('agents.spend_limit');
  await expect(session(page).getByRole('region', { name: 'Reply' })).toHaveCount(0);
  const refusedRow = tableIn(main(page), 'Runs').getByRole('row').filter({ hasText: 'Refused' });
  await expect(refusedRow).toHaveCount(1);
  await expect(refusedRow.locator('code')).toHaveText('agents.spend_limit');
  await expect(refusedRow.getByTestId('run-cost')).toHaveText('0 USDT');
  expect(await ledgerBalances(agents.account())).toEqual(before);
  // Raised back to 1, the person's 0.02 is the lower again.
  await setAgentCap(page, '1');
  await expect(limits(page).getByTestId('effective-per-session')).toHaveText('0.02 USDT applies');
});

test(`${J} #3 starts two runs together whose worst cases are each more than half the cap: exactly one is admitted, the other refused before the engine and bills 0`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  await session(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  // The stack's test engine answers after 0.8 s (a LOCAL TEST value), so both runs are held at once.
  const runs = tableIn(main(page), 'Runs');
  const refusedBefore = await runs.getByRole('row').filter({ hasText: 'Refused' }).count();
  const before = await ledgerBalances(agents.account());
  await session(page).getByRole('button', { name: 'Run twice at once' }).click();
  await expect(session(page).getByRole('region', { name: 'Reply' })).toBeVisible();
  await expect(session(page).getByRole('alert').locator('code')).toHaveText('agents.spend.cap_exceeded');
  const admitted = runs.getByRole('row').filter({ hasText: 'Admitted' });
  await expect(admitted).toHaveCount(1);
  // One more refused row than before (#2 left one of its own), and it is this cap's.
  await expect(runs.getByRole('row').filter({ hasText: 'Refused' })).toHaveCount(refusedBefore + 1);
  const refused = runs.getByRole('row').filter({ hasText: 'agents.spend.cap_exceeded' });
  await expect(refused).toHaveCount(1);
  await expect(refused).toContainText('Refused');
  await expect(refused.getByTestId('run-cost')).toHaveText('0 USDT');
  // The admitted run's exact cost is the one its reply showed, above 0 and within the per-call cap.
  const cost = (await admitted.getByTestId('run-cost').innerText()).replace(/ USDT$/, '');
  await expect(session(page).getByTestId('reply-cost')).toHaveText(`${cost} USDT`);
  expect(toUnits(cost)).toBeGreaterThan(0n);
  expect(toUnits(cost)).toBeLessThanOrEqual(toUnits('0.012'));
  // Nothing is billed and nothing is held in the ledger: every balance, free and used, is as it was before the two
  // runs (the admitted run is charged only when its window seals).
  expect(await ledgerBalances(agents.account())).toEqual(before);
});

test(`${J} #4 asks for a run when the available balance is below the worst case: refused as insufficient funds, the engine never called, nothing billed; with the balance read down, the run does not start and says why`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A second TEST person with 0.005 USDT, the same kind of agent (cap 1 per session) and the same limits: one run's
  // worst case (just over 0.01024) is above the balance.
  const poor = await fundedTrader(page, 'ag02p', '0.005');
  await ownAgentWithLimits(page, poor);
  await session(page).getByRole('button', { name: 'Open a session' }).click();
  await expect(session(page).getByText('Session open:')).toBeVisible();
  await session(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  const before = await ledgerBalances(poor);
  await session(page).getByRole('button', { name: 'Run', exact: true }).click();
  const refusal = session(page).getByRole('alert');
  await expect(refusal).toContainText('Your available balance is below this run’s worst case, so it did not start.');
  await expect(refusal.locator('code')).toHaveText('agents.funds_insufficient');
  await expect(session(page).getByRole('region', { name: 'Reply' })).toHaveCount(0);
  const runs = tableIn(main(page), 'Runs').getByRole('row');
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(1)).toContainText('Refused');
  await expect(runs.nth(1).locator('code')).toHaveText('agents.funds_insufficient');
  await expect(runs.nth(1).getByTestId('run-cost')).toHaveText('0 USDT');
  expect(await ledgerBalances(poor)).toEqual(before);

  // With the balance read down (the stack's ledger stopped), the run does not start and says why: the balance could
  // not be read, which is not the same as short. The engine is never called and nothing is billed.
  try {
    tool('local-test-stack.mjs', 'stop', 'ledger');
    await session(page).getByRole('button', { name: 'Run', exact: true }).click();
    const unread = session(page).getByRole('alert');
    await expect(unread).toContainText('Your balance could not be read just now, so this run did not start. Nothing was charged', {
      timeout: 20_000,
    });
    await expect(unread.locator('code')).toHaveText('agents.funds_unread');
    await expect(session(page).getByRole('region', { name: 'Reply' })).toHaveCount(0);
    await expect(runs).toHaveCount(3);
    await expect(runs.filter({ hasText: 'agents.funds_unread' }).getByTestId('run-cost')).toHaveText('0 USDT');
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'ledger');
  }
  expect(await ledgerBalances(poor)).toEqual(before);
});

test(`${J} #5 leaves the overage grace value blank after a window could not be paid: the next run refuses with recovery text; the unpaid window retries on its charge key`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A third TEST person with 1 USDT and the same agent and limits. The stack publishes no overage grace (blank).
  const owes = await fundedTrader(page, 'ag02u', '1');
  await ownAgentWithLimits(page, owes);
  await expect(limits(page).getByTestId('overage-grace')).toHaveText(
    'Allowed unpaid before runs stop: not set. While any usage is unpaid, no run starts.',
  );

  // One admitted run: its usage sits on the session's open window, not yet charged.
  await session(page).getByRole('button', { name: 'Open a session' }).click();
  const first = await session(page).getByText('Session open:').locator('code').innerText();
  await session(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await session(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(session(page).getByRole('region', { name: 'Reply' })).toBeVisible();
  const cost = (await session(page).getByTestId('reply-cost').innerText()).replace(/ USDT$/, '');
  expect(toUnits(cost)).toBeGreaterThan(0n);
  const funded = await ledgerBalances(owes);

  // The person moves every USDT into a savings pot before the window is paid, so the close cannot charge it.
  const bank = await bankOf(owes);
  const home = await bank.main();
  const pot = await bank.pot('Agents TEST pot');
  await bank.move(`${J}#5:out:${pot.id}`, home.id, pot.id, '1');
  const drained = await ledgerBalances(owes);
  expect(toUnits(drained.USDT?.free ?? '0')).toBe(0n);

  // A window earlier could not be paid: the close is refused and says so; the session stays open; nothing moved.
  await session(page).getByRole('button', { name: 'Close session' }).click();
  const unpaidClose = session(page).getByRole('alert');
  await expect(unpaidClose).toContainText('A usage window could not be paid, so the session stays open.');
  await expect(unpaidClose.locator('code')).toHaveText('agents.window_unpaid');
  await expect(session(page).getByText('Session open:').locator('code')).toHaveText(first);
  expect(await ledgerBalances(owes)).toEqual(drained);

  // The window is sealed at the run's exact cost, unpaid, on its charge key.
  await pages(page).getByRole('button', { name: 'Usage', exact: true }).click();
  const windows = tableIn(main(page), 'Usage windows').getByRole('row').filter({ hasText: first });
  await expect(windows).toHaveCount(1);
  await expect(windows).toContainText('Unpaid');
  await expect(windows.getByTestId('window-cost')).toHaveText(`${cost} USDT`);
  const key = await windows.getByTestId('charge-key').innerText();
  expect(key).toMatch(new RegExp(`^agent\\.usage:${first}:`));
  await expect(main(page).getByRole('alert')).toHaveText('A usage window is unpaid. Add funds and it is retried on the same charge.');

  // With the grace blank, the next run refuses with recovery text, before the engine, and bills 0.
  await pages(page).getByRole('button', { name: 'Limits', exact: true }).click();
  await session(page).getByRole('button', { name: 'Open a session' }).click();
  const second = session(page).getByText('Session open:').locator('code');
  await expect(second).not.toHaveText(first);
  await session(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await session(page).getByRole('button', { name: 'Run', exact: true }).click();
  const refusal = session(page).getByRole('alert');
  await expect(refusal).toContainText(
    'Earlier usage is still unpaid and no allowance for unpaid usage is set, so this run did not start. It is retried on its same charge before each run; add funds if your balance is short.',
  );
  await expect(refusal.locator('code')).toHaveText('agents.overage_grace_unset');
  await expect(session(page).getByRole('region', { name: 'Reply' })).toHaveCount(0);
  const refusedRow = tableIn(main(page), 'Runs').getByRole('row').filter({ hasText: 'agents.overage_grace_unset' });
  await expect(refusedRow).toHaveCount(1);
  await expect(refusedRow).toContainText('Refused');
  await expect(refusedRow.getByTestId('run-cost')).toHaveText('0 USDT');
  expect(await ledgerBalances(owes)).toEqual(drained);

  // Funds back: the next run first retries the unpaid window on its same charge key, which now pays it once, then runs.
  await bank.move(`${J}#5:back:${pot.id}`, pot.id, home.id, '1');
  expect(await ledgerBalances(owes)).toEqual(funded);
  await session(page).getByRole('button', { name: 'Run', exact: true }).click();
  await expect(session(page).getByRole('region', { name: 'Reply' })).toBeVisible();
  const paid = await ledgerBalances(owes);
  expect(toUnits(funded.USDT.total) - toUnits(paid.USDT.total)).toBe(toUnits(cost));
  expect(toUnits(funded.USDT.free) - toUnits(paid.USDT.free)).toBe(toUnits(cost));
  await pages(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(windows).toHaveCount(1);
  await expect(windows).toContainText('Settled');
  await expect(windows.getByTestId('charge-key')).toHaveText(key);
  await expect(windows.getByTestId('window-cost')).toHaveText(`${cost} USDT`);
  await expect(main(page).getByRole('alert')).toHaveCount(0);
  // Paid once: reading the page again charges nothing more.
  expect(await ledgerBalances(owes)).toEqual(paid);
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
