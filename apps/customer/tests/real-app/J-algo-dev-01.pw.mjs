import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { EDGE, journeyState, times, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, tapeWindow } from './tape.mjs';

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
  await page.getByTestId('tb-tab').filter({ hasText: 'Trade' }).hover();
  await page
    .getByTestId('tb-menu')
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
  await expect(page.getByTestId('quant-quick-start').locator('li[data-done=true]')).toHaveCount(0);
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
const TEST_TEMPLATE = {
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
};

/** The operator's publish door, as the founder console calls it. */
async function opsPublish(input) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  // The operator write scope, as svc-trade's admin doors take it; a plain founder session is an ordinary user.
  return ctx.edge.mutate('quant', 'ops.template.publish', input, await founders.a.tradeOpsToken());
}

async function publishTestTemplate() {
  const res = await opsPublish(TEST_TEMPLATE);
  if (!res.json?.result?.data?.version) throw new Error(`template publish refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** The numbers a template's rules hold: each must be blank for the person to fill in after Use. */
const templateNumbers = (rules) => [
  rules.signal.fast,
  rules.signal.slow,
  rules.sizing.value,
  rules.exit.stopLossPercent,
  rules.exit.takeProfitPercent,
];

test(`${J} #2 picks a starter template and presses Use: a draft with every number blank and no return claim; Use again after a lost reply leaves one draft`, async ({
  page,
}) => {
  // The product keeps a template's numbers blank, not this fixture: the publish door refuses a template with one set.
  const numbered = await opsPublish({
    ...TEST_TEMPLATE,
    rules: { ...TEST_TEMPLATE.rules, signal: { ...TEST_TEMPLATE.rules.signal, fast: '5' } },
    idempotencyKey: 'journey:J-algo-dev-01:test-ma-cross:number-set',
  });
  expect(numbered.json?.result?.data).toBeUndefined();
  expect(numbered.text).toContain('quant.template_number_set');
  expect(numbered.text).toContain('signal.fast is set');
  const template = await publishTestTemplate();
  expect(template.name).toMatch(/^TEST /);

  await signIn(page, developer());
  const listed = page.waitForResponse((r) => r.url().includes('/api/quant/trpc/template.list') && r.ok());
  await page.goto('/quant/studio');
  // Every starter template the product serves, not only this one, holds no number: no starter value to label.
  const served = (await (await listed).json()).result.data.templates;
  expect(served.length).toBeGreaterThan(0);
  for (const each of served) expect(templateNumbers(each.rules), each.id).toEqual(['', '', '', '', '']);
  const templates = page.getByTestId('quant-templates');
  await expect(templates.getByRole('row')).toHaveCount(served.length + 1); // the header and every template served
  const row = templates.getByRole('row', { name: new RegExp(template.name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`Version ${template.version}`);
  // No return, win rate or other performance figure is claimed for any template.
  for (const text of await templates.getByRole('row').allInnerTexts()) expect(text).not.toMatch(/\d\s*%|return|profit|win rate/i);

  // The first Use reads the template but the reply is lost: nothing lands in the form.
  await loseNextReply(page, 'template.get');
  const use = row.getByRole('button', { name: `Use ${template.name}` });
  await use.click();
  await expect(templates.getByTestId('failure')).toBeVisible();
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

  // One draft: this account's one Studio draft slot holds the template, once, with every number still blank, and the
  // account has no saved strategy.
  const drafts = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('intafaced.quant.studio-draft.v1:') && !key.endsWith(':signed-out'))
      .map((key) => JSON.parse(localStorage.getItem(key))),
  );
  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({ name: template.name, cash: '', drawdown: '', notional: '', kill: '' });
  expect(templateNumbers(drafts[0].modules)).toEqual(['', '', '', '', '']);
  await expect(page.getByText('No strategy is saved yet.')).toBeVisible();
  const list = await page.context().newPage();
  await list.goto('/quant/strategies');
  await expect(list.getByTestId('quant-strategies')).toContainText('No strategy is saved on this account.');
  await list.close();
  // Clear it for the next step (the second press confirms).
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
  await expect(page.getByTestId('quant-save').getByTestId('failure')).toBeVisible();
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
  await expect(page.getByTestId('quant-save').getByTestId('failure')).toBeVisible();
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

// The window both backtest steps run on: the last hour of the TEST tape, fixed once so #6 repeats #5's inputs exactly.
const WINDOW_MINUTES = 60;

test(`${J} #5 sets cash, a window, the fee, slippage and delay, and runs with slippage blank: a refusal names slippage and nothing runs; the published fee rates show`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  // The TEST market maker trades about once a minute: fix the window once the last hour holds enough closed bars.
  const { from, to } = await tapeWindow(WINDOW_MINUTES);
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
  // The published schedule is read before anything runs: the rates the run will charge, with the schedule version,
  // exactly as the exchange publishes them to everyone.
  const schedule = await (await fetch(`${EDGE}/api/v1/fees/published`)).json();
  const rates = schedule.fees['BTC/USDT'];
  expect(rates, 'the published schedule has a BTC/USDT rate').toBeTruthy();
  await expect(room.getByTestId('quant-fee-ledger')).toContainText(
    `Published fee schedule ${schedule.version} for BTC/USDT: taker ${rates.takerBps} basis points, maker ${rates.makerBps} basis points.`,
  );
  // The saved starting cash is offered; the developer keeps it.
  await expect(room.getByLabel('Starting cash')).toHaveValue('1000');
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
  await expect(room.getByTestId('failure')).toBeVisible();
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  const runId = await result.getAttribute('data-run-id');
  expect(runId).toMatch(/^run_/);
  // The run lists how it was modelled, so nobody reads a choice the engine made as a fact about the market.
  await expect(result.getByTestId('quant-bar-assumptions').locator('[data-assumption="long_only"]')).toHaveCount(1);
  await expect(result.getByTestId('quant-bar-assumptions').locator('[data-assumption="averages_over_traded_bars"]')).toHaveCount(1);

  // Coverage: how many bar intervals traded, and each gap with no trade on the market, checked against the tape itself:
  // every minute of the window with no closed TEST bar is inside a recorded gap, and no recorded gap holds a bar.
  const fromMs = Date.parse(`${window.from}:00Z`);
  const toMs = Date.parse(`${window.to}:00Z`);
  const tape = new Set((await closedBarsSince(window.from)).map(([at]) => at).filter((at) => at < toMs));
  const expectedGaps = [];
  for (let at = fromMs; at < toMs; at += 60_000) {
    if (tape.has(at)) continue;
    const last = expectedGaps.at(-1);
    if (last && last[1] === at) last[1] = at + 60_000;
    else expectedGaps.push([at, at + 60_000]);
  }
  await expect(result.getByTestId('quant-bar-coverage')).toHaveText(
    `${tape.size} of ${(toMs - fromMs) / 60_000} bars traded in the window.`,
  );
  const gaps = await result
    .getByTestId('quant-bar-gap')
    .evaluateAll((rows) => rows.map((row) => [Date.parse(row.dataset.from), Date.parse(row.dataset.to)]));
  expect(gaps).toEqual(expectedGaps);
  // The TEST market maker leaves quiet minutes, so the window has a gap and "no fill inside a gap" is tested, not vacuous.
  expect(gaps.length, 'the TEST tape has a quiet minute in this window').toBeGreaterThan(0);

  // Sided trades: the long-only rules alternate, buy first; none fills inside a gap.
  await result.getByRole('button', { name: 'Orders and trades' }).click();
  const trades = await result
    .getByTestId('quant-bar-trade')
    .evaluateAll((rows) =>
      rows.map((row) => [row.dataset.side, row.dataset.ts, ...[3, 5, 6].map((cell) => row.cells[cell].textContent.trim())]),
    );
  expect(trades.length).toBeGreaterThan(0);
  trades.forEach(([side], i) => expect(side).toBe(i % 2 === 0 ? 'buy' : 'sell'));
  for (const [, ts] of trades) {
    const at = Date.parse(ts);
    expect(gaps.some(([a, b]) => at >= a && at < b)).toBe(false);
  }

  // Fees are taken off the result before costs, with slippage: net = gross - fees - slippage, exactly.
  await result.getByRole('button', { name: 'Summary' }).click();
  const total = async (key) => (await result.getByTestId(`quant-bar-total-${key}`).getAttribute('data-value')) ?? '';
  const [gross, fees, slip, net] = await Promise.all(['gross', 'fees', 'slippageTotal', 'net'].map(total));
  expect(toUnits(fees)).toBeGreaterThan(0n);
  expect(toUnits(net)).toBe(toUnits(gross) - toUnits(fees) - toUnits(slip));

  // Equity moves with the trades, checked against the tape: every point is the cash left after the fills up to that bar
  // (a buy pays quantity times price plus fee, a sell receives it less fee) plus what is held, marked at the bar's close.
  const startCash = toUnits(await room.getByLabel('Starting cash').inputValue());
  await result.getByRole('button', { name: 'Charts' }).click();
  const equity = await result
    .getByTestId('quant-bar-equity')
    .evaluateAll((rows) =>
      rows.map((row) => ({ at: Date.parse(`${row.cells[0].textContent.replace(' ', 'T')}:00Z`), equity: row.dataset.equity })),
    );
  const closes = new Map((await closedBarsSince(window.from)).map(([at, , , , close]) => [at, String(close)]));
  const fills = trades.map(([side, ts, qty, price, fee]) => ({ side, at: Date.parse(ts), qty, price, fee }));
  const TOLERANCE = 10n ** 10n; // 0.00000001: the engine rounds each product half-up
  let cash = startCash;
  let held = '0';
  let next = 0;
  const marks = new Set();
  for (const point of equity) {
    for (; next < fills.length && fills[next].at <= point.at; next += 1) {
      const fill = fills[next];
      if (fill.side === 'buy') {
        cash -= times(fill.qty, fill.price) + toUnits(fill.fee);
        held = fill.qty;
      } else {
        cash += times(fill.qty, fill.price) - toUnits(fill.fee);
        held = '0';
      }
    }
    const close = closes.get(point.at);
    if (!close) throw new Error(`the run marked ${new Date(point.at).toISOString()}, a minute the tape has no closed bar for`);
    const expected = cash + times(held, close);
    const off = toUnits(point.equity) - expected;
    expect(off < TOLERANCE && off > -TOLERANCE, `equity ${point.equity} at ${new Date(point.at).toISOString()}, expected ${expected}`).toBe(
      true,
    );
    marks.add(point.equity);
  }
  expect(next, 'every fill falls on a marked bar').toBe(fills.length);
  // It moves: with BTC held across closes, the curve takes more than one value.
  expect(marks.size).toBeGreaterThan(1);

  // The same inputs again: the same stored run, not a second one.
  await room.getByTestId('quant-backtest-run').click();
  await expect(result).toHaveAttribute('data-run-id', runId);
  run.write({ backtest: { runId, net, trades: trades.length } });
  await page.goto('/quant');
  await expect(page.getByTestId('quant-quick-start-count')).toHaveText('2 of 3 steps done');
});

/** Fills the backtest form with the inputs #6 ran, for a window, and presses Run. */
async function runBacktest(page, window, slippage = '5') {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: 'TEST first strategy' });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill(slippage);
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

  // The run's own fills and equity, read from its other tabs, give every figure below independently of the report.
  await result.getByRole('button', { name: 'Orders and trades' }).click();
  const fills = await result.getByTestId('quant-bar-trade').evaluateAll((rows) =>
    rows.map((row) => ({
      side: row.dataset.side,
      qty: row.cells[3].textContent.trim(),
      price: row.cells[5].textContent.trim(),
      fee: row.cells[6].textContent.trim(),
    })),
  );
  expect(fills).toHaveLength(backtest.trades);
  await result.getByRole('button', { name: 'Charts' }).click();
  const curve = (await result.getByTestId('quant-bar-equity').evaluateAll((rows) => rows.map((row) => row.dataset.equity))).map(toUnits);
  await result.getByRole('button', { name: 'Metrics' }).click();

  // Round trips: each buy closed by the next sell; profit is the sale less the purchase, both after their fees.
  const profits = [];
  for (let i = 0; i + 1 < fills.length; i += 2) {
    const [buy, sell] = [fills[i], fills[i + 1]];
    profits.push(times(sell.qty, sell.price) - toUnits(sell.fee) - (times(buy.qty, buy.price) + toUnits(buy.fee)));
  }
  await expect(figure('roundTrips')).toHaveAttribute('data-value', String(profits.length));
  const wins = profits.filter((profit) => profit > 0n);
  const losses = profits.filter((profit) => profit < 0n);
  await expect(figure('wins')).toHaveAttribute('data-value', String(wins.length));
  await expect(figure('losses')).toHaveAttribute('data-value', String(losses.length));
  // Profit factor is gross profit over gross loss, or "not defined" with its reason when nothing lost.
  if (losses.length) {
    const gained = wins.reduce((sum, profit) => sum + profit, 0n);
    const lost = -losses.reduce((sum, profit) => sum + profit, 0n);
    const shown = Number(await figure('profitFactor').getAttribute('data-value'));
    expect(shown).toBeCloseTo(Number((gained * 10_000n) / lost) / 10_000, 2);
  } else {
    await expect(figure('profitFactor')).toHaveAttribute('data-reason', 'no_losing_trades');
  }

  // Drawdown is the largest fall from a running peak of the equity curve, run-up the largest rise from a running trough.
  let peak = curve[0];
  let trough = curve[0];
  let fall = 0n;
  let rise = 0n;
  for (const point of curve) {
    if (point > peak) peak = point;
    if (point < trough) trough = point;
    if (peak - point > fall) fall = peak - point;
    if (point - trough > rise) rise = point - trough;
  }
  expect(toUnits(await figure('maxDrawdown').getAttribute('data-value'))).toBe(fall);
  expect(toUnits(await figure('maxRunUp').getAttribute('data-value'))).toBe(rise);
  for (const key of ['maxDrawdownPercent', 'maxRunUpPercent']) await expect(figure(key)).toHaveAttribute('data-value', /^\d/);
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
  await empty.getByRole('button', { name: 'Orders and trades' }).click();
  await expect(empty.getByTestId('quant-bar-trades')).toContainText('The rules made no trade in this window.');
  await expect(empty.getByTestId('quant-bar-trade')).toHaveCount(0);
  await empty.getByRole('button', { name: 'Metrics' }).click();
  const winRate = empty.getByTestId('quant-metric-winRate');
  await expect(winRate).toHaveAttribute('data-reason', 'no_trades');
  await expect(winRate.locator('dd').first()).toHaveText('No trades');
});

test(`${J} #8 opens Charts and Orders and trades and presses Download CSV: the equity curve with a marker on each fill, the trades with their side, and a CSV of one row per trade with formula cells neutralised`, async ({
  page,
}) => {
  const { window, backtest } = run.read();
  if (!window || !backtest) throw new Error(`${J} #6 stored no run, so this step has nothing to chart`);
  await signIn(page, developer());
  const result = await runBacktest(page, window);
  await expect(result).toHaveAttribute('data-run-id', backtest.runId);

  // Orders and trades: every fill with its side.
  await result.getByRole('button', { name: 'Orders and trades' }).click();
  const shown = await result.getByTestId('quant-bar-trade').evaluateAll((rows) => rows.map((row) => [row.dataset.ts, row.dataset.side]));
  expect(shown).toHaveLength(backtest.trades);

  // Download CSV: one row per trade, in order, with its side. The TEST run's cells are times, sides and decimals, none of
  // which contains a comma.
  const csvOf = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), result.getByTestId('quant-bar-csv').click()]);
    expect(download.suggestedFilename()).toBe(`backtest-${backtest.runId}-trades.csv`);
    return readFileSync(await download.path(), 'utf8')
      .trimEnd()
      .split('\r\n');
  };
  const csv = await csvOf();
  expect(csv[0]).toBe('time_utc,side,reason,quantity,bar_price,fill_price,fee,slippage');
  const rows = csv.slice(1).map((line) => line.split(','));
  expect(rows.map(([ts, side]) => [ts, side])).toEqual(shown);

  // Charts: the equity curve, with a marker on the bar of each fill and the same side.
  await result.getByRole('button', { name: 'Charts' }).click();
  await expect(result.getByTestId('quant-bar-equity-chart').locator('polyline')).toHaveCount(1);
  const markers = await result.getByTestId('quant-bar-marker').evaluateAll((dots) => dots.map((dot) => [dot.dataset.ts, dot.dataset.side]));
  expect(markers).toEqual(shown);
  await expect(result.getByText(/^Equity by bar\. A triangle pointing up marks a buy/)).toBeVisible();

  // Formula cells are neutralised in the file this screen saves: the run's reply is read again with one TEST cell
  // that begins with an equals sign (the service never sends one), and the saved file starts that cell with an apostrophe.
  const crafted = '=1+1 TEST formula cell';
  await page.route('**/api/quant/trpc/backtest.start*', async (route) => {
    const reply = await route.fetch();
    const body = await reply.json();
    body.result.data.trades[0].ts = crafted;
    await route.fulfill({ response: reply, json: body });
  });
  const reread = page.waitForResponse((r) => r.url().includes('/api/quant/trpc/backtest.start'));
  await page.getByTestId('quant-backtest-run').click();
  await reread;
  await expect(result).toHaveAttribute('data-run-id', backtest.runId);
  await result.getByRole('button', { name: 'Orders and trades' }).click();
  // The screen shows the reply with the crafted cell before the file is saved.
  await expect(result.getByTestId('quant-bar-trade').first()).toHaveAttribute('data-ts', crafted);
  const neutral = await csvOf();
  expect(neutral[1].split(',')[0]).toBe(`'${crafted}`);
  expect(neutral.slice(2)).toEqual(csv.slice(2));
  await page.unroute('**/api/quant/trpc/backtest.start*');
});

test(`${J} #9 opens run history, renames a run, compares two side by side and filters the log to warnings: newest first with label, version and outcome; the result stays the same; no ranking by return; only warning lines show`, async ({
  page,
}) => {
  const { window, backtest } = run.read();
  if (!window || !backtest) throw new Error(`${J} #6 stored no run, so the history has nothing to show`);
  await signIn(page, developer());
  await page.goto('/quant/backtest');
  const history = page.getByTestId('quant-run-history');
  const rows = history.getByTestId('quant-run-row');
  // #6 stored a run and #7 an empty one: newest first, each with a version and an outcome.
  await expect(rows).toHaveCount(2);
  const started = await rows.evaluateAll((list) => list.map((row) => row.dataset.started));
  expect([...started].sort().reverse()).toEqual(started);
  for (const row of await rows.all()) {
    await expect(row.locator('td').nth(2)).toHaveText(/^v\d+$/);
    await expect(row.locator('td').nth(3)).toHaveText('Finished');
    await expect(row.getByTestId('quant-run-label')).toHaveText('Unnamed run');
  }

  // Rename #6's run: the label shows, and opening it reads the same stored result, figure for figure.
  const mine = history.locator(`[data-testid="quant-run-row"][data-run-id="${backtest.runId}"]`);
  const totals = (from) =>
    from
      .getByTestId('quant-bar-totals')
      .locator('[data-value]')
      .evaluateAll((list) => list.map((row) => [row.dataset.testid, row.dataset.value]));
  await mine.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('quant-bar-result')).toHaveAttribute('data-run-id', backtest.runId);
  const before = await totals(page.getByTestId('quant-bar-result'));
  await mine.getByRole('button', { name: 'Rename' }).click();
  await mine.getByLabel('Label').fill('TEST hourly cross');
  await mine.getByRole('button', { name: 'Save label' }).click();
  await expect(mine.getByTestId('quant-run-label')).toHaveText('TEST hourly cross');
  await mine.getByRole('button', { name: 'Open' }).click();
  const result = page.getByTestId('quant-bar-result');
  await expect(result).toHaveAttribute('data-run-id', backtest.runId);
  await expect(result.getByTestId('quant-bar-total-net')).toHaveAttribute('data-value', backtest.net);
  expect(await totals(result)).toEqual(before);

  // A third run: #6's inputs with heavier TEST slippage make the same trades and cost more, so it returns less than #6.
  // Newest, it heads the list without the best return: a ranking by return could never put it first.
  const costly = await runBacktest(page, window, '100');
  const costlyId = await costly.getAttribute('data-run-id');
  expect(costlyId).not.toBe(backtest.runId);
  expect(toUnits(await costly.getByTestId('quant-bar-total-net').getAttribute('data-value'))).toBeLessThan(toUnits(backtest.net));
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute('data-run-id', costlyId);

  // Compare the costly run with #6's (two at a time): the same figures side by side, columns in the list's order (newest
  // first), never by return. Ticked oldest first, so the columns follow neither the ticks nor the returns.
  const ids = [costlyId, backtest.runId];
  for (const id of [...ids].reverse()) await history.locator(`[data-run-id="${id}"] input[type="checkbox"]`).check();
  const compare = history.getByTestId('quant-run-compare');
  const netRow = compare.locator('[data-testid="quant-compare-row"][data-metric="net"]');
  await expect(netRow.locator('td[data-run-id]')).toHaveCount(2);
  const cells = await netRow
    .locator('td[data-run-id]')
    .evaluateAll((list) => list.map((cell) => ({ runId: cell.dataset.runId, net: cell.textContent.replace(/[^\d.-]/g, '') })));
  expect(cells.map((cell) => cell.runId)).toEqual(ids);
  // The first column is the newest run, which is not the best return: the columns are not ranked best first.
  const best = cells.reduce((top, cell) => (toUnits(cell.net) > toUnits(top.net) ? cell : top));
  expect(cells[0].runId).toBe(costlyId);
  expect(best.runId).not.toBe(costlyId);
  // And no part of the compare view offers a ranking: no sortable heading and no sort control.
  await expect(compare.locator('[aria-sort]')).toHaveCount(0);
  await expect(compare.getByRole('button', { name: /sort|rank|best/i })).toHaveCount(0);
  await expect(compare.getByRole('combobox', { name: /sort|rank|order/i })).toHaveCount(0);
  const figures = await compare.getByTestId('quant-compare-row').evaluateAll((list) => list.map((row) => row.dataset.metric));
  expect(figures).toEqual([
    'net',
    'netPercent',
    'profitFactor',
    'expectedPayoff',
    'maxDrawdown',
    'maxDrawdownPercent',
    'maxRunUp',
    'roundTrips',
    'winRate',
  ]);

  // #6's run again, then its log, then warnings only: every line left is a warning, and as many as the full log holds.
  await mine.getByRole('button', { name: 'Open' }).click();
  await expect(result).toHaveAttribute('data-run-id', backtest.runId);
  await result.getByRole('button', { name: 'Log' }).click();
  const lines = result.getByTestId('quant-log-line');
  const levels = await lines.evaluateAll((list) => list.map((line) => line.dataset.level));
  expect(levels.filter((level) => level === 'info').length).toBeGreaterThan(0);
  await result.getByRole('combobox', { name: /^Show/ }).selectOption('warn');
  // The TEST tape has quiet minutes and the strategy sets risk limits, so the run always carries warnings.
  const warnings = levels.filter((level) => level === 'warn').length;
  expect(warnings).toBeGreaterThan(0);
  await expect(lines).toHaveCount(warnings);
  expect(new Set(await lines.evaluateAll((list) => list.map((line) => line.dataset.level)))).toEqual(new Set(['warn']));
});
