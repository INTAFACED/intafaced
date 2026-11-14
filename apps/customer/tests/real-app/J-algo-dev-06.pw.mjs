// World: none
// Market: live
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tapeWindow } from './tape.mjs';

// J-algo-dev-06, in the running app (docs/roadmap/journeys.json): promote a strategy to live under my own limits. One test
// per step, titled "J-algo-dev-06 #<n>", run in order on one TEST developer who starts signed in, verified, with a
// strategy version that holds a computed passing out-of-sample verdict, costs set and a paper run. The owner's criteria
// are TEST values an operator sets through svc-quant's own door, as the founder console would: for the one backtest that
// gives this journey its passing verdict, the out-of-sample criteria are set wide (TEST) and put back as they were right
// after; the gate's own criteria are TEST values this file sets and blanks again at its end. Every figure in Algo dev is
// simulated; nothing here moves money. Step 4 (the risk disclosure) is deferred until launch prep (owner decision
// 2026-10-27, OWNER 87). Steps #3 (RC-algo-dev-01), #5 (AL-risk-01), #6 to #8 (AL-live-02) and #9 (AL-live-05) are not
// built yet: each slice adds its step's test, checking every clause of the step's words against the screen it builds.
const J = 'J-algo-dev-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const STRATEGY = 'TEST promotion strategy';

test.describe.configure({ mode: 'default' });

function developer() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

function strategyId() {
  const id = run.read().strategyId;
  if (!id) throw new Error(`${J} #1 saved no strategy, so this step has nothing to act on`);
  return id;
}

/** svc-quant's owner-criteria door (AL-lifecycle-01), with the stack's TEST founder's operator token. */
async function criteriaDoor() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  const data = (res, what) => {
    const got = res.json?.result?.data;
    if (!got) throw new Error(`${what} refused: ${res.status} ${res.text.slice(0, 300)}`);
    return got;
  };
  let n = 0;
  const stamp = `${process.env.JOURNEY_RUN_ID ?? 'local'}:${Date.now()}`;
  return {
    async read() {
      return data(await ctx.edge.query('quant', 'ops.criteria.get', undefined, token), 'ops.criteria.get').criteria;
    },
    async set(name, value, toBoot = false) {
      n += 1;
      return data(
        await ctx.edge.mutate(
          'quant',
          'ops.criteria.set',
          { name, value, toBoot, reason: `LOCAL TEST ${J}`, idempotencyKey: `journey:${J}:${stamp}:${n}:${name}` },
          token,
        ),
        'ops.criteria.set',
      );
    },
  };
}

/** Saves a signal-rules strategy on 1 minute bars of BTC/USDT at version 1, with every risk limit set. TEST inputs. */
async function saveSignalStrategy(page, name) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** Runs a split backtest of version 1 on the latest TEST tape in the backtest room and returns its result section. */
async function splitBacktest(page, window) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: STRATEGY });
  await expect(room.getByTestId('quant-backtest-rules')).toHaveText('Version 1: BTC/USDT, 1m bars.');
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  return { room, result };
}

/** Starts a paper run of version 1 from the strategy's page, on our exchange's own prices. TEST inputs. */
async function startPaper(page) {
  const paper = page.getByTestId('quant-paper');
  await paper.getByRole('button', { name: 'Start a paper run' }).click();
  const form = paper.getByTestId('quant-paper-start');
  await form.getByLabel('Starting cash (simulated)').fill('1000');
  await form.getByRole('combobox', { name: /^Price data/ }).selectOption('own_venue');
  await form.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await form.getByLabel('Slippage (basis points)').fill('5');
  await form.getByLabel('Delay (bars)').fill('0');
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('Version 1 is running on paper.');
  return paper.locator('[data-testid="quant-paper-run"][data-state="running"]').first().getAttribute('data-run-id');
}

const OOS = ['oos.minTrades', 'oos.minReturnPercent', 'oos.maxDrawdownPercent', 'oos.maxShortfallPercent'];
const GATE = ['gate.paperMinutes', 'gate.maxDrawdownPercent'];

// The gate's TEST criteria go back to blank whatever happened, so no later file reads this journey's values.
test.afterAll(async () => {
  const door = await criteriaDoor();
  for (const name of GATE) await door.set(name, null, true);
});

test(`${J} #1 opens the strategy lifecycle and presses Promote with a gate criterion unset: a refusal naming it and nothing written; Preview sample windows are ignored`, async ({
  page,
}) => {
  test.setTimeout(20 * 60_000);
  const who = await signUp(page, 'jp');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, developer());
  await saveSignalStrategy(page, STRATEGY);
  await page.goto('/quant/strategies');
  const id = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(id).toBeTruthy();
  run.write({ strategyId: id });

  // The start: one backtest with a computed passing verdict. The owner's out-of-sample criteria are set wide (TEST) for
  // this one run and put back exactly as they were right after; the run keeps the criteria it was judged by.
  const door = await criteriaDoor();
  const before = await door.read();
  const window = await tapeWindow(60);
  let backtestRunId;
  try {
    await door.set('oos.minTrades', '0');
    await door.set('oos.minReturnPercent', '-100');
    await door.set('oos.maxDrawdownPercent', '100');
    await door.set('oos.maxShortfallPercent', '1000');
    const { room, result } = await splitBacktest(page, window);
    await expect(room.getByTestId('quant-verdict')).toHaveAttribute('data-status', 'passed');
    backtestRunId = await result.getAttribute('data-run-id');
  } finally {
    for (const name of OOS) {
      const was = before.find((row) => row.name === name);
      // The boot value stands again where it stood; an operator's value is written back as it was.
      await door.set(name, was?.value ?? null, was?.source !== 'operator');
    }
  }
  expect(backtestRunId).toBeTruthy();
  run.write({ backtestRunId });

  // A paper run of this version, on our exchange's own prices.
  await page.goto(`/quant/strategies/${encodeURIComponent(id)}`);
  const paperRunId = await startPaper(page);
  expect(paperRunId).toBeTruthy();
  run.write({ paperRunId });

  // The Preview tester shows its sample walk-forward windows; none of them is a stored run the gate can read.
  await page.goto('/quant/tester');
  await expect(page.getByText('Preview · sample data').first()).toBeVisible();

  // The owner has set the drawdown criterion but not the paper duration (TEST).
  await door.set('gate.maxDrawdownPercent', '100');
  await door.set('gate.paperMinutes', null);

  await page.goto(`/quant/strategies/${encodeURIComponent(id)}`);
  const life = page.getByTestId('quant-lifecycle-version');
  await expect(life).toHaveAttribute('data-stage', 'paper');
  const check = (name) => life.locator(`[data-testid="quant-gate-check"][data-check="${name}"]`);
  // The verdict the gate reads is this account's own stored backtest, never a Preview window.
  await expect(check('outOfSample')).toHaveAttribute('data-status', 'met');
  await expect(check('outOfSample')).toHaveAttribute('data-run-id', backtestRunId);
  await expect(check('paperDuration')).toHaveAttribute('data-status', 'not_set');
  await expect(check('paperDuration')).toHaveAttribute('data-run-id', paperRunId);
  await expect(check('paperDuration').locator('td').nth(2)).toHaveText('not set');

  const promotes = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/lifecycle.promote')) promotes.push(res.status());
  });
  await life.getByRole('button', { name: 'Promote version 1' }).click();
  const refusal = life.getByTestId('quant-promote-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.gate_criteria_unset');
  await expect(refusal).toHaveAttribute('data-unset', 'paperMinutes');
  await expect(refusal).toContainText('The owner has not set the shortest paper run. Nothing was promoted and nothing was recorded.');
  expect(promotes).toEqual([412]);

  // Nothing was written: read again from the service, the stage is still paper with no decision and no stage row.
  await page.reload();
  await expect(life).toHaveAttribute('data-stage', 'paper');
  const decisions = life.getByTestId('quant-gate-decisions');
  await expect(decisions).toHaveAttribute('data-count', '0');
  await expect(decisions).toHaveAttribute('data-stages', '0');
  await expect(decisions).toContainText('No decision is recorded for this version yet.');
});

test(`${J} #2 fixes the criteria and presses Promote again: the gate approves, one stage row and one audit row exist, the stage moves once even if pressed twice`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const id = strategyId();
  const { backtestRunId, paperRunId } = run.read();
  const door = await criteriaDoor();
  // The owner fixes the criteria (TEST): a paper run of at least one minute, a backtest drawdown of at most 100 %.
  await door.set('gate.paperMinutes', '1');
  await door.set('gate.maxDrawdownPercent', '100');

  await signIn(page, developer());
  const life = page.getByTestId('quant-lifecycle-version');
  const check = (name) => life.locator(`[data-testid="quant-gate-check"][data-check="${name}"]`);
  // The paper run started in #1 has now run its minute: every check reads met.
  await expect
    .poll(
      async () => {
        await page.goto(`/quant/strategies/${encodeURIComponent(id)}`);
        return check('paperDuration').getAttribute('data-status', { timeout: 30_000 });
      },
      { timeout: 3 * 60_000, intervals: [10_000] },
    )
    .toBe('met');
  for (const name of ['outOfSample', 'riskLimits', 'paperDuration', 'maxDrawdown']) {
    await expect(check(name)).toHaveAttribute('data-status', 'met');
  }
  await expect(check('paperDuration')).toHaveAttribute('data-criterion-value', '1');

  // The first press reaches the service but its reply is lost on the way back.
  let lost = false;
  await page.route('**/api/quant/trpc/lifecycle.promote', async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  const button = life.getByRole('button', { name: 'Promote version 1' });
  await button.click();
  await expect(life.locator('.failure')).toBeVisible();
  // Pressed again from the same reading: the stored answer comes back; the gate approved and the stage moved once.
  await button.click();
  const decision = life.getByTestId('quant-promote-decision');
  await expect(decision).toHaveAttribute('data-decision', 'approved');
  await expect(decision).toHaveText('The gate approved version 1: it moved from paper to candidate. Going live is a separate step.');
  await expect(life).toHaveAttribute('data-stage', 'candidate');

  // Pressed a third time from the fresh page: refused, the version is already past paper, and nothing more is written.
  await button.click();
  await expect(life.getByTestId('quant-promote-refusal')).toHaveAttribute('data-code', 'quant.stage_transition_invalid');
  await page.reload();
  await expect(life).toHaveAttribute('data-stage', 'candidate');
  const decisions = life.getByTestId('quant-gate-decisions');
  await expect(decisions).toHaveAttribute('data-count', '1');
  await expect(decisions).toHaveAttribute('data-stages', '1');
  const row = decisions.getByTestId('quant-gate-decision');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-decision', 'approved');
  await expect(row).toHaveAttribute('data-run-ids', `${backtestRunId},${paperRunId}`);
  await expect(row).toContainText('Paper → Candidate');

  // The paper run is stopped: its record stays, and it places nothing more.
  await page
    .getByTestId('quant-paper')
    .getByRole('button', { name: /^Stop the paper run started / })
    .click();
  await expect(page.getByTestId('quant-paper-note')).toContainText('The paper run is stopped.');
});
