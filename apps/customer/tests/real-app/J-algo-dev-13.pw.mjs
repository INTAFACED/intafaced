// World: restart
// Market: live
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tapeWindow } from './tape.mjs';
import { userIdOf } from './copy.mjs';

// J-algo-dev-13, in the running app (docs/roadmap/journeys.json): check disclosures and promotion records before anything
// goes live. One test per step, titled "J-algo-dev-13 #<n>". The compliance operator is the stack's LOCAL TEST founder A
// (admin.mjs) on the console's quant desk, /more-ops/quant, whose promotion audit reads svc-quant's stored gate decisions
// and stage rows (`ops.lifecycle.audit`, admin:read). Step #1 (disclosure versions and acceptance counts) is deferred
// until launch prep (owner decision 2026-10-27, OWNER 87). Step #2 (a new disclosure version asks again on the next
// deploy) needs the deploy's disclosure ask, which is J-algo-dev-06 #4, deferred by the same decision: it is not built
// here. The promotion this file audits is a TEST developer's own, pressed in the customer app; the gate's criteria are
// TEST values set through svc-quant's own door, as the founder console would, and blanked again at the end. Every
// figure in Algo dev is simulated; nothing here moves money.
const J = 'J-algo-dev-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const STRATEGY = 'TEST audited strategy';

test.describe.configure({ mode: 'default' });

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
async function saveSignalStrategy(page) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(STRATEGY);
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

/** Runs a split backtest of version 1 on the latest TEST tape and returns its result section. */
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

test(`${J} #3 opens the promotion audit: one stage row and one audit row for each promotion, with the criteria used`, async ({
  page,
  browser,
}) => {
  test.setTimeout(20 * 60_000);
  // The start: a TEST developer's strategy version with a computed passing out-of-sample verdict and a paper run. The
  // out-of-sample criteria are set wide (TEST) for this one backtest and put back exactly as they were right after.
  const who = await signUp(page, 'ja');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, who);
  await saveSignalStrategy(page);
  await page.goto('/quant/strategies');
  const strategyId = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(strategyId).toBeTruthy();

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
      await door.set(name, was?.value ?? null, was?.source !== 'operator');
    }
  }
  expect(backtestRunId).toBeTruthy();
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const paperRunId = await startPaper(page);
  expect(paperRunId).toBeTruthy();

  // The owner's gate criteria (TEST): any paper run counts, a backtest drawdown of at most 100 %.
  await door.set('gate.paperMinutes', '0');
  await door.set('gate.maxDrawdownPercent', '100');

  // The developer presses Promote: the gate approves. A second press is refused, the version is already past paper.
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const life = page.getByTestId('quant-lifecycle-version');
  const button = life.getByRole('button', { name: 'Promote version 1' });
  await button.click();
  await expect(life.getByTestId('quant-promote-decision')).toHaveAttribute('data-decision', 'approved');
  await expect(life).toHaveAttribute('data-stage', 'candidate');
  await button.click();
  await expect(life.getByTestId('quant-promote-refusal')).toHaveAttribute('data-code', 'quant.stage_transition_invalid');
  const developerId = await userIdOf(who);

  // The compliance operator opens the promotion audit on the quant desk.
  const ops = await (await browser.newContext()).newPage();
  await founderSignIn(ops, 'a');
  await ops.goto(`${ADMIN}/more-ops/quant`);
  await expect(ops.getByRole('heading', { name: 'Quant desk' })).toBeVisible();
  const audit = ops.getByTestId('quant-promotion-audit');
  await expect(audit.getByRole('heading', { name: 'Promotion audit' })).toBeVisible();
  await expect(audit.getByTestId('promotion-audit-failed')).toHaveCount(0);

  // One audit row for this promotion: the second press wrote nothing.
  const rows = audit.locator(`[data-testid="promotion-audit-row"][data-strategy-id="${strategyId}"]`);
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toHaveAttribute('data-strategy-version', '1');
  await expect(row).toHaveAttribute('data-decision', 'approved');

  // Its audit row: the decision, who pressed and the runs the gate read.
  const decision = row.getByTestId('promotion-audit-decision');
  await expect(decision).toHaveAttribute('data-run-ids', `${backtestRunId},${paperRunId}`);
  await expect(decision).toContainText('Approved at');
  await expect(decision).toHaveAttribute('data-actor', developerId);

  // The criteria used: the owner's gate values as they stood when the gate decided.
  const criterion = (name) => row.locator(`[data-testid="promotion-audit-criterion"][data-name="${name}"]`);
  await expect(criterion('paperMinutes')).toHaveAttribute('data-value', '0');
  await expect(criterion('paperMinutes')).toHaveText('Shortest paper run (minutes): 0');
  await expect(criterion('maxDrawdownPercent')).toHaveAttribute('data-value', '100');
  await expect(criterion('maxDrawdownPercent')).toHaveText('Largest backtest drawdown (percent): 100');

  // Its one stage row: paper to candidate.
  await expect(row).toHaveAttribute('data-stages', '1');
  const stage = row.getByTestId('promotion-audit-stage');
  await expect(stage).toHaveAttribute('data-from', 'paper');
  await expect(stage).toHaveAttribute('data-to', 'candidate');
  await expect(stage).toContainText('Paper → Candidate');

  // The criteria changed afterwards do not rewrite the record: the audit still shows the values the gate used.
  await door.set('gate.paperMinutes', '600');
  await ops.reload();
  await expect(audit.locator(`[data-testid="promotion-audit-row"][data-strategy-id="${strategyId}"]`)).toHaveCount(1);
  await expect(criterion('paperMinutes')).toHaveAttribute('data-value', '0');

  // The paper run is stopped: its record stays, and it places nothing more.
  await page
    .getByTestId('quant-paper')
    .getByRole('button', { name: /^Stop the paper run started / })
    .click();
  await expect(page.getByTestId('quant-paper-note')).toContainText('The paper run is stopped.');
});
