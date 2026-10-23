import { test, expect } from '@playwright/test';
import { EDGE, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-algo-dev-01, in the running app (docs/roadmap/journeys.json): build a first strategy, save it and backtest it on
// history. One test per step this build serves, titled "J-algo-dev-01 #<n>", run in order on one TEST developer who
// starts signed in, verified and with no strategy. Every figure in Algo dev is simulated; nothing here moves money.
const J = 'J-algo-dev-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function developer() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const ROOMS = ['Start', 'Studio', 'Backtest', 'Sandbox', 'Execution'];

test(`${J} #1 opens Algo dev from the Trade menu: every room listed, quick start at zero of three, no strategy saved`, async ({ page }) => {
  const who = await signUp(page, 'ja');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, developer());

  // The Trade menu opens on hover; Algo dev sits in its list (under Advanced in Simple mode).
  await page.goto('/home');
  await page.locator('.tb-tab', { hasText: 'Trade' }).hover();
  await page
    .locator('.tb-menu')
    .getByRole('link', { name: /Algo dev/ })
    .click();
  await expect(page).toHaveURL(/\/quant$/);
  await expect(page.getByRole('heading', { name: 'Algo dev', level: 1 })).toBeVisible();

  // Every room is listed, none hidden, and each one opens.
  const rooms = page.getByRole('navigation', { name: 'Algo dev rooms' });
  for (const name of ROOMS) await expect(rooms.getByRole('link', { name })).toBeVisible();
  await expect(rooms.getByRole('link', { name: 'Start' })).toHaveAttribute('aria-current', 'page');

  // The quick start is ticked from this account's own rows: nothing yet, and no sample strategy anywhere.
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('0 of 3 steps done');
  await expect(page.locator('.quant-quick-start li[data-done=true]')).toHaveCount(0);
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your strategies' }).getByRole('table')).toHaveCount(0);
  await expect(page.getByText('Simulated only.')).toBeVisible();

  // Each room in the list opens its own page.
  for (const [name, path] of [
    ['Studio', /\/quant\/studio$/],
    ['Backtest', /\/quant\/backtest$/],
    ['Sandbox', /\/quant\/sandbox$/],
  ]) {
    await page.goto('/quant');
    await page.getByRole('navigation', { name: 'Algo dev rooms' }).getByRole('link', { name }).click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('navigation', { name: 'Algo dev rooms' }).getByRole('link', { name })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});

/** The next write to `procedure` reaches the service, but its reply is lost on the way back, as on a dropped line. */
/** The TEST starter template the journey reads, published by the stack's TEST founder through the operator write. */
async function publishTestTemplate() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const res = await ctx.edge.mutate(
    'quant',
    'ops.template.publish',
    {
      id: 'test-ma-cross',
      name: 'TEST moving-average cross',
      description: 'Buys when a fast average crosses above a slow one and sells when it crosses back below.',
      rules: {
        symbol: 'BTC/USDT',
        barSize: '1h',
        signal: { kind: 'ma_cross', average: 'sma', fast: '', slow: '' },
        sizing: { kind: 'quantity', value: '' },
        exit: { stopLossPercent: '', takeProfitPercent: '' },
      },
      releaseNote: 'LOCAL TEST template for the algo journey.',
      reason: 'LOCAL TEST journey template',
      // One key for every run: a replay returns the first version instead of stacking new ones.
      idempotencyKey: 'journey:J-algo-dev-01:test-ma-cross:v1',
    },
    // The operator write scope, as svc-trade's admin doors take it; a plain founder session is an ordinary user.
    await founders.a.tradeOpsToken(),
  );
  if (!res.json?.result?.data?.version) throw new Error(`template publish refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

test(`${J} #2 picks a starter template and presses Use: a draft with every number blank and no return claim; Use again after a lost reply leaves one draft`, async ({
  page,
}) => {
  const template = await publishTestTemplate();
  await signIn(page, developer());
  await page.goto('/quant/studio');
  const templates = page.getByTestId('quant-templates');
  const row = templates.getByRole('row', { name: new RegExp(template.name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`Version ${template.version}`);
  // No return, win rate or other performance figure is claimed for a template.
  expect(await row.innerText()).not.toMatch(/\d\s*%|return|profit/i);

  // The first Use reads the template but the reply is lost: nothing lands in the form.
  await loseNextReply(page, 'template.get');
  const use = row.getByRole('button', { name: `Use ${template.name}` });
  await use.click();
  await expect(templates.locator('.failure')).toBeVisible();
  await expect(page.getByLabel('How the strategy trades')).toHaveValue('blocks');

  // Pressing Use again reads it again and fills one draft.
  await use.click();
  await expect(page.getByTestId('quant-template-used')).toContainText(`${template.name} version ${template.version} is in the form`);
  await expect(page.getByLabel('Strategy name')).toHaveValue(template.name);
  await expect(page.getByLabel('How the strategy trades')).toHaveValue('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await expect(builder.getByLabel('Symbol')).toHaveValue('BTC/USDT');
  for (const label of [
    'Fast average (bars)',
    'Slow average (bars)',
    'Size',
    'Stop loss (percent, optional)',
    'Take profit (percent, optional)',
  ]) {
    await expect(builder.getByLabel(label, { exact: true })).toHaveValue('');
  }
  await expect(page.getByLabel('Simulated starting cash')).toHaveValue('');
  await expect(page.getByTestId('quant-save-state')).toContainText('Fill in a name, the starting cash');

  // One draft: nothing was saved, and the form is the only copy. Clear it for the next step (the second press confirms).
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  await fresh.click();
  await fresh.click();
  await expect(page.getByLabel('How the strategy trades')).toHaveValue('blocks');
});

test(`${J} #3 types the signal rule inputs: a blank required input refuses by name and nothing runs; filled, the builder shows the generated source`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/studio');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await expect(builder).toBeVisible();
  // Every number starts blank: nothing is filled in for the developer.
  for (const label of ['Fast average (bars)', 'Slow average (bars)', 'Size', 'Stop loss (percent, optional)']) {
    await expect(builder.getByLabel(label, { exact: true })).toHaveValue('');
  }

  // TEST inputs, with the slow average left blank.
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1h');
  await builder.getByLabel('Fast average (bars)').fill('3');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  const compiled = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/studio.compile')) compiled.push(res.status());
  });
  await builder.getByRole('button', { name: 'Build source' }).click();
  await expect(builder.getByTestId('quant-rule-refusal')).toHaveText('Fill in Slow average (bars) first. Nothing ran.');
  await expect(builder.getByLabel('Slow average (bars)')).toHaveAttribute('aria-invalid', 'true');
  await expect(builder.getByTestId('quant-generated-source')).toHaveCount(0);
  expect(compiled).toEqual([400]);

  // A slow average no slower than the fast one is out of range, by name.
  await builder.getByLabel('Slow average (bars)').fill('3');
  await builder.getByRole('button', { name: 'Build source' }).click();
  await expect(builder.getByTestId('quant-rule-refusal')).toContainText('Slow average (bars) is outside its range');

  await builder.getByLabel('Slow average (bars)').fill('5');
  await builder.getByRole('button', { name: 'Build source' }).click();
  const source = builder.getByTestId('quant-generated-source');
  await expect(source).toBeVisible();
  await expect(builder.getByTestId('quant-rule-refusal')).toHaveCount(0);
  for (const line of [
    'const closes = bars("BTC/USDT", "1h").close;',
    'const fast = sma(closes, 3);',
    'const slow = sma(closes, 5);',
    'oms.buy("BTC/USDT", size.quantity("0.01"));',
    'oms.sell("BTC/USDT", position("BTC/USDT").qty);',
  ]) {
    await expect(source).toContainText(line);
  }
  // A changed rule marks the shown source as out of date until it is built again.
  await builder.getByRole('combobox', { name: /^Average/ }).selectOption('ema');
  await expect(source).toContainText('The rules changed since this source was built.');
  await builder.getByRole('button', { name: 'Build source' }).click();
  await expect(source).toContainText('const fast = ema(closes, 3);');
  await expect(source).not.toContainText('The rules changed');

  // Nothing was saved: the library is still empty. Clear the form for the next step (the second press confirms).
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  await fresh.click();
  await expect(page.getByTestId('quant-replace-warning')).toBeVisible();
  await fresh.click();
  await expect(page.getByLabel('How the strategy trades')).toHaveValue('blocks');
});

async function loseNextReply(page, procedure) {
  let lost = false;
  await page.route(`**/api/quant/trpc/${procedure}*`, async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
}

async function studioRules(page, { name, cash, symbol, qty, drawdown, notional, kill }) {
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill(cash);
  await page.getByLabel('Block 1 symbol').fill(symbol);
  await page.getByLabel('Block 1 quantity').fill(qty);
  await page.getByLabel('Max drawdown (service unit unspecified)').fill(drawdown);
  await page.getByLabel('Max notional (service unit unspecified)').fill(notional);
  await page.getByLabel('Kill threshold (service unit unspecified)').fill(kill);
}

test(`${J} #4 saves the strategy at version 1; Save again after a lost reply makes no duplicate, and a change makes one version 2`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/studio');
  const library = page.getByRole('region', { name: 'Your strategy library' }).getByRole('table');
  const save = page.getByRole('button', { name: 'Save to library', exact: true });
  const state = page.getByTestId('quant-save-state');
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();

  // TEST rules: every figure is a simulation input typed by the developer.
  await studioRules(page, {
    name: 'TEST first strategy',
    cash: '1000',
    symbol: 'BTC/USDT',
    qty: '0.01',
    drawdown: '100',
    notional: '500',
    kill: '50',
  });
  await expect(state).toHaveText('Unsaved. Saving keeps the rules in your library on this account.');

  // The first reply is lost: the service saved it, the screen never heard. Pressing Save again returns the same row.
  await loseNextReply(page, 'studio.save');
  await save.click();
  await expect(page.locator('.quant-save .failure')).toBeVisible();
  await save.click();
  await expect(state).toHaveText('Saved as version 1.');
  await expect(save).toBeDisabled();
  await expect(library.getByRole('row')).toHaveCount(2); // the header and one strategy
  await expect(library).toContainText('TEST first strategy');
  await expect(library).toContainText('Version 1');

  // A change, saved with its reply lost and saved again: one version 2, still one strategy.
  await page.getByLabel('Block 1 quantity').fill('0.02');
  await expect(state).toHaveText('Changed since version 1. Save to keep these rules as the next version.');
  await loseNextReply(page, 'studio.update');
  await save.click();
  await expect(page.locator('.quant-save .failure')).toBeVisible();
  await save.click();
  await expect(state).toHaveText('Saved as version 2.');
  await expect(library.getByRole('row')).toHaveCount(2);
  await expect(library).toContainText('Version 2');

  // Unsaved rules are never dropped on one press: starting a new strategy warns first and leaves the form as it is.
  await page.getByLabel('Block 1 quantity').fill('0.03');
  await page.getByRole('button', { name: 'Start a new strategy' }).click();
  await expect(page.getByTestId('quant-replace-warning')).toHaveText('The rules in the form are not saved. Press again to replace them.');
  await expect(page.getByLabel('Block 1 quantity')).toHaveValue('0.03');
  await page.getByLabel('Block 1 quantity').fill('0.02');
  await expect(state).toHaveText('Saved as version 2.');

  // The library holds it after a reload, and the Algo dev home ticks the first quick-start step.
  await page.reload();
  await expect(page.getByLabel('Block 1 quantity')).toHaveValue('0.02');
  await expect(state).toHaveText('Saved as version 2.');
  await page.goto('/quant');
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('1 of 3 steps done');
  const home = page.getByRole('region', { name: 'Your strategies' }).getByRole('table');
  await expect(home.getByRole('row')).toHaveCount(2);
  await expect(home).toContainText('Version 2');
  run.write({ strategy: 'TEST first strategy' });
});

/** A UTC minute as a datetime-local value, `minutesAgo` before the current minute. */
function utcMinute(minutesAgo) {
  const at = Math.floor(Date.now() / 60_000) * 60_000 - minutesAgo * 60_000;
  return new Date(at).toISOString().slice(0, 16);
}

/** The TEST market maker's closed 1m bars of BTC/USDT since a datetime-local UTC minute, read from Edge's public route. */
async function closedBarsSince(minute) {
  const since = Date.parse(`${minute}:00Z`);
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&since=${since}&limit=720`);
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.filter(([at]) => at >= since && at + 60_000 <= Date.now());
}

// The window both backtest steps run on: the last hour of the TEST tape, fixed once so #6 repeats #5's inputs exactly.
const WINDOW_MINUTES = 60;

test(`${J} #5 sets cash, a window, the fee, slippage and delay, and runs with slippage blank: a refusal names slippage and nothing runs; the published fee rates show`, async ({
  page,
}) => {
  await signIn(page, developer());
  // The strategy now trades by signal rules: TEST inputs on 1 minute bars of the local TEST market, saved as version 3.
  await page.goto('/quant/studio');
  // This browser holds no draft: the saved version 2 is opened from the library.
  await page.getByRole('button', { name: 'Open TEST first strategy' }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 2.');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 3.');

  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: 'TEST first strategy' });
  await expect(room.getByTestId('quant-backtest-rules')).toHaveText('Version 3: BTC/USDT, 1m bars.');
  // The published schedule is read before anything runs: the rates the run will charge, with the schedule version.
  await expect(room.getByTestId('quant-fee-ledger')).toContainText(
    /Published fee schedule .+ for BTC\/USDT: taker \d+ basis points, maker \d+ basis points\./,
  );
  // The saved starting cash is offered; the developer keeps it.
  await expect(room.getByLabel('Starting cash')).toHaveValue('1000');
  const from = utcMinute(WINDOW_MINUTES);
  const to = utcMinute(0);
  run.write({ window: { from, to } });
  await room.getByLabel('From (UTC)').fill(from);
  await room.getByLabel('To (UTC)').fill(to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');

  const started = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/backtest.start')) started.push(res.status());
  });
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-backtest-refusal')).toHaveText('Fill in Slippage (basis points) first. Nothing ran.');
  await expect(room.getByLabel('Slippage (basis points)')).toHaveAttribute('aria-invalid', 'true');
  await expect(room.getByTestId('quant-bar-result')).toHaveCount(0);
  expect(started).toEqual([400]);
  // Nothing ran: the quick start's backtest step is still open.
  await page.goto('/quant');
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('1 of 3 steps done');
});

test(`${J} #6 runs on the TEST tape: sided trades, equity moving with them, fees subtracted from gross, no fill inside a gap; the same inputs again read back the same stored run`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { window } = run.read();
  if (!window) throw new Error(`${J} #5 fixed no window, so this step has nothing to repeat`);
  // The TEST market maker trades about once a minute. Wait until the window holds enough closed bars for the averages.
  await expect
    .poll(async () => (await closedBarsSince(window.from)).filter(([at]) => at < Date.parse(`${window.to}:00Z`)).length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the window needs at least 8 closed TEST bars of BTC/USDT; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThanOrEqual(8);

  await signIn(page, developer());
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: 'TEST first strategy' });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');

  // The first reply is lost after the service stored the run; Run again with the same inputs reads it back.
  await loseNextReply(page, 'backtest.start');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.locator('.failure')).toBeVisible();
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  const runId = await result.getAttribute('data-run-id');
  expect(runId).toMatch(/^run_/);
  // The run lists how it was modelled, so nobody reads a choice the engine made as a fact about the market.
  await expect(result.getByTestId('quant-bar-assumptions').locator('[data-assumption="long_only"]')).toHaveCount(1);
  await expect(result.getByTestId('quant-bar-assumptions').locator('[data-assumption="averages_over_traded_bars"]')).toHaveCount(1);

  // Coverage: how many bar intervals traded, and each gap with no trade on the market.
  await expect(result.getByTestId('quant-bar-coverage')).toHaveText(/^\d+ of \d+ bars traded in the window\.$/);
  const gaps = await result
    .getByTestId('quant-bar-gap')
    .evaluateAll((rows) => rows.map((row) => [Date.parse(row.dataset.from), Date.parse(row.dataset.to)]));

  // Sided trades: the long-only rules alternate, buy first; none fills inside a gap.
  const trades = await result.getByTestId('quant-bar-trade').evaluateAll((rows) => rows.map((row) => [row.dataset.side, row.dataset.ts]));
  expect(trades.length).toBeGreaterThan(0);
  trades.forEach(([side], i) => expect(side).toBe(i % 2 === 0 ? 'buy' : 'sell'));
  for (const [, ts] of trades) {
    const at = Date.parse(ts);
    expect(gaps.some(([a, b]) => at >= a && at < b)).toBe(false);
  }

  // Fees are taken off the result before costs, with slippage: net = gross - fees - slippage, exactly.
  const total = async (key) => (await result.getByTestId(`quant-bar-total-${key}`).getAttribute('data-value')) ?? '';
  const [gross, fees, slip, net] = await Promise.all(['gross', 'fees', 'slippageTotal', 'net'].map(total));
  expect(toUnits(fees)).toBeGreaterThan(0n);
  expect(toUnits(net)).toBe(toUnits(gross) - toUnits(fees) - toUnits(slip));

  // Equity moves with the position: it changes from bar to bar while the strategy holds BTC.
  const equity = await result.getByTestId('quant-bar-equity').evaluateAll((rows) => rows.map((row) => row.dataset.equity));
  expect(new Set(equity).size).toBeGreaterThan(1);

  // The same inputs again: the same stored run, not a second one.
  await room.getByTestId('quant-backtest-run').click();
  await expect(result).toHaveAttribute('data-run-id', runId);
  run.write({ backtest: { runId, net, trades: trades.length } });
  await page.goto('/quant');
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('2 of 3 steps done');
});

/** Fills the backtest form with the inputs #6 ran, for a window, and presses Run. */
async function runBacktest(page, window) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: 'TEST first strategy' });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  return result;
}

test(`${J} #7 opens the Metrics tab: net, drawdown, run-up, profit factor and trade statistics from the run's own trades; win rate reads "no trades" on an empty run and Sharpe is not set while the risk-free rate is blank`, async ({
  page,
}) => {
  const { window, backtest } = run.read();
  if (!window || !backtest) throw new Error(`${J} #6 stored no run, so this step has no metrics to read`);
  await signIn(page, developer());

  // The same inputs read back #6's stored run; its Metrics tab reports on that run's own trades.
  const result = await runBacktest(page, window);
  await expect(result).toHaveAttribute('data-run-id', backtest.runId);
  await result.getByRole('button', { name: 'Metrics' }).click();
  const metrics = result.getByTestId('quant-bar-metrics');
  const figure = (key) => metrics.getByTestId(`quant-metric-${key}`);
  await expect(figure('net')).toHaveAttribute('data-value', backtest.net);
  for (const key of ['maxDrawdown', 'maxDrawdownPercent', 'maxRunUp', 'maxRunUpPercent']) {
    await expect(figure(key)).toHaveAttribute('data-value', /^\d/);
  }
  const roundTrips = Math.floor(backtest.trades / 2);
  await expect(figure('roundTrips')).toHaveAttribute('data-value', String(roundTrips));
  const wins = Number(await figure('wins').getAttribute('data-value'));
  const losses = Number(await figure('losses').getAttribute('data-value'));
  expect(wins + losses).toBeLessThanOrEqual(roundTrips);
  // Profit factor is gross profit over gross loss, or "not defined" with its reason when nothing lost.
  await expect(figure('profitFactor')).toHaveAttribute(losses ? 'data-value' : 'data-reason', losses ? /^\d/ : 'no_losing_trades');
  // Sharpe and Sortino need the owner's risk-free rate, which is blank: they say so, and nothing reads 0.
  for (const key of ['sharpe', 'sortino']) {
    await expect(figure(key)).toHaveAttribute('data-reason', 'quant.risk_free_unset');
    await expect(figure(key)).toContainText('Not set: the risk-free rate is not published');
  }

  // An empty run: a window of the first two closed bars has no cross, so no trade. Win rate reads "no trades", not 0.
  const [first] = await closedBarsSince(window.from);
  if (!first) throw new Error('the TEST tape has no closed bar in the window');
  const from = new Date(first[0]).toISOString().slice(0, 16);
  const to = new Date(first[0] + 2 * 60_000).toISOString().slice(0, 16);
  const empty = await runBacktest(page, { from, to });
  await expect(empty).not.toHaveAttribute('data-run-id', backtest.runId);
  await expect(empty.getByTestId('quant-bar-trade')).toHaveCount(0);
  await empty.getByRole('button', { name: 'Metrics' }).click();
  const winRate = empty.getByTestId('quant-metric-winRate');
  await expect(winRate).toHaveAttribute('data-reason', 'no_trades');
  await expect(winRate.locator('dd').first()).toHaveText('No trades');
});
