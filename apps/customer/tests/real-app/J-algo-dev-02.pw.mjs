import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, tapeWindow, utcMinute } from './tape.mjs';

// J-algo-dev-02, in the running app (docs/roadmap/journeys.json): check that a backtest result is honest before trusting
// or sharing it. One test per step this build serves, titled "J-algo-dev-02 #<n>", run in order on one TEST developer
// who starts signed in, verified, with a saved signal-rules strategy and one completed backtest. The out-of-sample
// criteria and the holdout come from the local stack's TEST owner values (tooling/profiles/test-owner-values/quant.json):
// minimum one round trip, minimum return 0 %, maximum drawdown 10 %, the holdout the last 15 minutes, and the maximum
// shortfall left blank on purpose. Every figure in Algo dev is simulated; nothing here moves money.
const J = 'J-algo-dev-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function developer() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page, name, sizing = { kind: 'quantity', value: '0.01' }) {
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
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption(sizing.kind);
  await builder.getByLabel('Size', { exact: true }).fill(sizing.value);
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** Opens the backtest room on a strategy and fills the run inputs; the split and holdout stay as the caller sets them. */
async function backtestForm(page, strategy, { from, to, slippage = '5' }) {
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: strategy });
  await expect(room.getByTestId('quant-backtest-rules')).toHaveText('Version 1: BTC/USDT, 1m bars.');
  await room.getByLabel('From (UTC)').fill(from);
  await room.getByLabel('To (UTC)').fill(to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill(slippage);
  return room;
}

const STRATEGY = 'TEST honest strategy';
const WINDOW_MINUTES = 60;

test(`${J} #1 sets the one-third preset: the out-of-sample part is the latest third, in UTC with no overlap; a window touching the owner holdout is refused`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  // The start: a verified developer with a saved strategy and one completed backtest on the TEST tape.
  const who = await signUp(page, 'jh');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, developer());
  await saveSignalStrategy(page, STRATEGY);
  const window = await tapeWindow(WINDOW_MINUTES);
  let room = await backtestForm(page, STRATEGY, window);
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();
  // Unsplit, the run has no out-of-sample part, so its verdict is inconclusive and says why.
  await expect(room.getByTestId('quant-verdict')).toHaveAttribute('data-status', 'inconclusive');
  await expect(room.getByTestId('quant-verdict-reasons').locator('[data-reason="not_split"]')).toHaveCount(1);

  // The one-third preset: before anything runs, the preview cuts the window at its latest third, in UTC.
  const toMs = Date.parse(`${window.to}:00Z`);
  const cut = new Date(toMs - (WINDOW_MINUTES / 3) * 60_000);
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  const preview = room.getByTestId('quant-split-preview');
  await expect(preview).toHaveAttribute('data-oos-from', cut.toISOString());
  const minute = (at) => at.toISOString().slice(0, 16).replace('T', ' ');
  await expect(preview).toHaveText(
    `In sample ${window.from.replace('T', ' ')} to ${minute(cut)} UTC, then out of sample ${minute(cut)} to ${window.to.replace('T', ' ')} UTC. No overlap; the out-of-sample part is always the latest.`,
  );

  // The holdout is the last 15 minutes. A 30 minute window cut at its latest third has its in-sample part running into
  // the holdout: refused by name, and nothing runs.
  const started = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/backtest.start')) started.push(res.status());
  });
  await room.getByLabel('From (UTC)').fill(utcMinute(30));
  await room.getByRole('checkbox', { name: /owner’s holdout/ }).check();
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-backtest-refusal')).toContainText('the in-sample part runs to');
  await expect(room.getByTestId('quant-bar-result')).toHaveCount(0);
  expect(started).toEqual([400]);

  // The hour-long window clears it: the in-sample part ends 20 minutes back, before the holdout. The run is cut into two
  // ordered parts that meet at the preview's minute and do not overlap.
  room = await backtestForm(page, STRATEGY, window);
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  await room.getByRole('checkbox', { name: /owner’s holdout/ }).check();
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();
  await expect(room.getByTestId('quant-holdout')).toHaveAttribute('data-enforced', 'true');
  const inSample = room.getByTestId('quant-section-inSample');
  const outOfSample = room.getByTestId('quant-section-outOfSample');
  await expect(inSample).toHaveAttribute('data-from', `${window.from}:00.000Z`);
  await expect(inSample).toHaveAttribute('data-to', cut.toISOString());
  await expect(outOfSample).toHaveAttribute('data-from', cut.toISOString());
  await expect(outOfSample).toHaveAttribute('data-to', `${window.to}:00.000Z`);
  run.write({ window });
});

test(`${J} #2 runs with a typed verdict of "passed" in the request: the verdict shown is the computed one, the typed field is listed as ignored, and a blank criterion reads inconclusive with its name`, async ({
  page,
}) => {
  const { window } = run.read();
  if (!window) throw new Error(`${J} #1 fixed no window, so this step has nothing to run on`);
  await signIn(page, developer());
  const room = await backtestForm(page, STRATEGY, { ...window, slippage: '6' });
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');

  // The developer edits the request on its way out, adding a verdict and a variant count of their own.
  await page.route('**/api/quant/trpc/backtest.start', (route) =>
    route.continue({
      postData: JSON.stringify({ ...route.request().postDataJSON(), outOfSampleStatus: 'passed', strategyVariantCount: 1 }),
    }),
  );
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible();

  // The service computed the verdict. The owner left the maximum shortfall blank, so it cannot pass: it reads
  // inconclusive and names the missing criterion; the others show as set.
  const verdict = room.getByTestId('quant-verdict');
  await expect(verdict).toHaveAttribute('data-status', 'inconclusive');
  await expect(room.getByTestId('quant-verdict-status')).toHaveText('Inconclusive');
  await expect(room.getByTestId('quant-verdict-reasons').locator('[data-reason="criteria_unset"]')).toHaveCount(1);
  await expect(room.getByTestId('quant-verdict-unset')).toHaveAttribute('data-unset', 'maxShortfallPercent');
  await expect(room.getByTestId('quant-verdict-unset')).toHaveText(
    'Not set by the owner: Maximum shortfall against in sample (percentage points).',
  );
  const criterion = (name) => room.getByTestId('quant-verdict-criteria').locator(`[data-criterion="${name}"]`);
  await expect(criterion('minTrades')).toHaveAttribute('data-value', '1');
  await expect(criterion('maxShortfallPercent')).toHaveAttribute('data-value', '');
  await expect(criterion('maxShortfallPercent').locator('dd')).toHaveText('not set');

  // The typed fields changed nothing and are named as ignored.
  await expect(room.getByTestId('quant-ignored-inputs')).toHaveAttribute('data-fields', 'outOfSampleStatus,strategyVariantCount');
  await expect(room.getByTestId('quant-variant-count')).not.toHaveAttribute('data-count', '1');
});

test(`${J} #3 runs one strategy five times with different inputs: the variant count reads five on the result`, async ({ page }) => {
  const { window } = run.read();
  if (!window) throw new Error(`${J} #1 fixed no window, so this step has nothing to run on`);
  await signIn(page, developer());
  // A second strategy starts its own count; each run with a different slippage is a new variant, counted by the service.
  const strategy = 'TEST variant strategy';
  await saveSignalStrategy(page, strategy);
  for (const [i, slippage] of ['1', '2', '3', '4', '5'].entries()) {
    const room = await backtestForm(page, strategy, { ...window, slippage });
    await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
    await room.getByTestId('quant-backtest-run').click();
    await expect(room.getByTestId('quant-bar-result')).toBeVisible();
    await expect(room.getByTestId('quant-variant-count')).toHaveAttribute('data-count', String(i + 1));
  }
  const room = page.getByTestId('quant-bar-backtest');
  await expect(room.getByTestId('quant-variant-count')).toHaveText('Variants tried: 5');

  // Running the fifth inputs again reads back the stored run: still five, not six.
  const runId = await room.getByTestId('quant-bar-result').getAttribute('data-run-id');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toHaveAttribute('data-run-id', runId ?? '');
  await expect(room.getByTestId('quant-variant-count')).toHaveText('Variants tried: 5');
  run.write({ variants: { strategy, runId } });
});

const CHECK_NAMES = ['sample_gap', 'variant_count', 'bar_offset', 'bar_type', 'look_ahead', 'repainting'];

test(`${J} #4 opens the checks panel: overfitting, look-ahead and repainting findings, each with its evidence; none is hidden`, async ({
  page,
}) => {
  const { window, variants } = run.read();
  if (!window || !variants) throw new Error(`${J} #3 stored no fifth variant, so this step has no checks to read`);
  await signIn(page, developer());
  // The fifth variant's inputs read back #3's stored run, and its Checks tab lists every check the service made.
  const room = await backtestForm(page, variants.strategy, { ...window, slippage: '5' });
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toHaveAttribute('data-run-id', variants.runId);
  await result.getByRole('button', { name: 'Checks' }).click();
  const panel = result.getByTestId('quant-bar-checks');
  await expect(panel.locator('[data-status]')).toHaveCount(CHECK_NAMES.length);
  const check = (name) => panel.getByTestId(`quant-check-${name}`);
  for (const name of CHECK_NAMES) await expect(check(name)).toBeVisible();

  // Overfitting: five variants against the owner's TEST maximum of three warns, with the count as evidence.
  await expect(check('variant_count')).toHaveAttribute('data-status', 'warning');
  await expect(check('variant_count')).toHaveAttribute('data-threshold', '3');
  await expect(check('variant_count')).toHaveAttribute('data-variants', '5');
  await expect(check('variant_count')).toContainText('Warning');
  await expect(check('variant_count')).toContainText('Warns above 3.');

  // Overfitting: the in-sample to out-of-sample gap is measured against the TEST maximum of 5 points, from the run's
  // own two parts, which the verdict card shows too.
  const gap = check('sample_gap');
  await expect(gap).toHaveAttribute('data-threshold', '5');
  await expect(gap).toHaveAttribute('data-status', /^(warning|clear|not_applicable)$/);
  if ((await gap.getAttribute('data-status')) !== 'not_applicable') {
    const [is, oos, measured] = await Promise.all(
      ['data-insamplereturnpercent', 'data-outofsamplereturnpercent', 'data-gappercent'].map((name) => gap.getAttribute(name)),
    );
    expect(Number(measured)).toBeCloseTo(Number(is) - Number(oos), 6);
    await expect(gap).toHaveAttribute('data-status', Number(measured) > 5 ? 'warning' : 'clear');
  }

  // Sensitivity: the same run from one bar later, made by the service, with how far the return moved. "One bar later" is
  // the window's second traded bar, so a window that opens in a gap of the tape still starts one bar later.
  const offset = check('bar_offset');
  await expect(offset).toHaveAttribute('data-threshold', '1');
  const [, second] = (await closedBarsSince(window.from)).filter(([at]) => at < Date.parse(`${window.to}:00Z`));
  if (!second) throw new Error(`${J} #1's window holds fewer than two closed bars, so there is no later bar to start from`);
  await expect(offset).toHaveAttribute('data-offsetfrom', new Date(second[0]).toISOString());
  const shift = Number(await offset.getAttribute('data-shiftpercent'));
  await expect(offset).toHaveAttribute('data-status', shift > 1 ? 'warning' : 'clear');

  // Bars, look-ahead and repainting: named, with how the engine rules each out.
  await expect(check('bar_type')).toHaveAttribute('data-status', 'clear');
  await expect(check('bar_type')).toContainText('Time bars of 1m, built from the exchange’s own trades.');
  for (const name of ['look_ahead', 'repainting']) {
    await expect(check(name)).toHaveAttribute('data-status', 'by_construction');
    await expect(check(name)).toContainText('Ruled out by design');
  }
  await expect(check('look_ahead')).toContainText('A test of the engine proves a bar cannot change anything that happened before it.');
});

const MARGIN_SLIPPAGE = '15';

test(`${J} #5 opens the simulated account, sets leverage, and runs again: margin calls and stop-outs in the stated order; a blank leverage refuses by name`, async ({
  page,
}) => {
  const { window } = run.read();
  if (!window) throw new Error(`${J} #1 fixed no window, so this step has nothing to run on`);
  await signIn(page, developer());
  // Every entry spends all the simulated equity on margin, so the leverage decides how far the price may move. At 100x
  // a 15 basis-point slippage alone costs 15 % of the equity on entry: the margin level falls under the 90 % stop-out
  // in the bar it entered, whatever the TEST tape does, so the run shows the call and the stop-out every time.
  const strategy = 'TEST margin strategy';
  await saveSignalStrategy(page, strategy, { kind: 'percent_equity', value: '100' });
  const room = await backtestForm(page, strategy, { ...window, slippage: MARGIN_SLIPPAGE });
  const account = room.getByTestId('quant-account');
  await expect(account).toContainText('Cash account: no order spends more than the simulated cash.');
  await account.getByRole('checkbox', { name: 'Trade on margin' }).check();

  // The owner's published rules show read only, with the netting mode; the developer sets only the leverage.
  const rule = (name) => account.getByTestId('quant-account-rules').locator(`[data-rule="${name}"]`);
  await expect(rule('maxLeverage')).toHaveAttribute('data-value', '100');
  await expect(rule('marginCallPercent')).toHaveAttribute('data-value', '100');
  await expect(rule('stopOutPercent')).toHaveAttribute('data-value', '90');
  await expect(account).toContainText('One position, netted');

  // A blank leverage refuses by name and nothing runs.
  const started = [];
  page.on('response', (res) => {
    if (res.url().includes('/trpc/backtest.start')) started.push(res.status());
  });
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-backtest-refusal')).toHaveText('Fill in Leverage first. Nothing ran.');
  await expect(room.getByTestId('quant-bar-result')).toHaveCount(0);
  expect(started).toEqual([400]);

  await account.getByLabel('Leverage').fill('100');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toBeVisible();
  await expect(result.getByTestId('quant-bar-account')).toHaveText(
    'Margin account at 100x leverage: margin call at 100 %, stop-out at 90 %, one netted position.',
  );
  await result.getByRole('button', { name: 'Orders and trades' }).click();
  const events = await result
    .getByTestId('quant-margin-event')
    .evaluateAll((rows) =>
      rows.map((row) => ({ kind: row.dataset.kind, ts: row.dataset.ts, level: row.dataset.level, price: row.dataset.price })),
    );
  const trades = await result
    .getByTestId('quant-bar-trade')
    .evaluateAll((rows) => rows.map((row) => ({ side: row.dataset.side, ts: row.dataset.ts, text: row.textContent })));
  const stopOuts = events.filter((event) => event.kind === 'stop_out');
  expect(stopOuts.length, 'the TEST tape gave no stop-out at 100x; rerun on a later window').toBeGreaterThan(0);

  // The stated order: a position's margin call comes before its stop-out, at a level at or under each rule, and each
  // stop-out closes the whole position with a sell at the same bar and price.
  for (const stop of stopOuts) {
    const index = events.indexOf(stop);
    const call = events
      .slice(0, index)
      .reverse()
      .find((event) => event.kind === 'margin_call');
    expect(call, `stop-out at ${stop.ts} has no margin call before it`).toBeTruthy();
    expect(Date.parse(call.ts)).toBeLessThanOrEqual(Date.parse(stop.ts));
    expect(Number(call.level)).toBeLessThanOrEqual(100);
    expect(Number(stop.level)).toBeLessThanOrEqual(90);
    const sell = trades.find((trade) => trade.side === 'sell' && trade.ts === stop.ts && trade.text.includes('Stop-out'));
    expect(sell, `no stop-out sell at ${stop.ts}`).toBeTruthy();
    expect(sell.text).toContain(stop.price);
  }

  // The margin level is a column of the series (blank on a bar that ends with no position held, as every one does when
  // each entry stops out in its own bar), and the run lists how it was checked.
  await result.getByRole('button', { name: 'Charts' }).click();
  await result.locator('summary', { hasText: 'Equity by bar' }).click();
  await expect(result.getByRole('columnheader', { name: 'Margin level (%)' })).toBeVisible();
  await result.getByRole('button', { name: 'Summary' }).click();
  await expect(result.getByTestId('quant-bar-assumptions').locator('[data-assumption="margin_level_at_bar_low"]')).toHaveCount(1);
});

const REPORT_SECTIONS = ['parameters', 'statistics', 'charts', 'coverage', 'warnings', 'labels'];
const CLAIM = 'Historical simulation — not a forecast';

/** Opens #3's fifth variant again: its inputs read back the stored run, so the result tabs are that run's. */
async function storedVariant(page) {
  const { window, variants } = run.read();
  if (!window || !variants) throw new Error(`${J} #3 stored no fifth variant, so this step has no result to report on`);
  await signIn(page, developer());
  const room = await backtestForm(page, variants.strategy, { ...window, slippage: '5' });
  await room.getByRole('combobox', { name: /^Out-of-sample split/ }).selectOption('1/3');
  await room.getByTestId('quant-backtest-run').click();
  const result = room.getByTestId('quant-bar-result');
  await expect(result).toHaveAttribute('data-run-id', variants.runId);
  return { result, runId: variants.runId, strategy: variants.strategy };
}

test(`${J} #6 presses Print: parameters, statistics, charts and labels on paper with no empty section, under the historical-simulation label`, async ({
  page,
}) => {
  const { result, runId } = await storedVariant(page);
  await result.getByRole('button', { name: 'Report' }).click();
  const report = result.getByTestId('quant-report-document');
  await expect(report).toHaveAttribute('data-run-id', runId);
  await expect(result.getByTestId('quant-report-claim')).toHaveText(CLAIM);
  await expect(result.getByTestId('quant-report-claim')).toHaveAttribute('data-simulated', 'true');
  await expect(result.getByTestId('quant-report-claim')).toHaveAttribute('data-live', 'false');
  // Six sections in order, none empty: a print layout has no blank section.
  for (const id of REPORT_SECTIONS) {
    const section = report.getByTestId(`quant-report-section-${id}`);
    await expect(section).toBeVisible();
    expect(await section.getByTestId('quant-report-row').count(), `report section ${id} has no rows`).toBeGreaterThan(0);
  }
  // The statistics are this run's own: its net result matches the Summary tab's.
  await result.getByRole('button', { name: 'Summary' }).click();
  const net = await result.getByTestId('quant-bar-total-net').getAttribute('data-value');
  await result.getByRole('button', { name: 'Report' }).click();
  await expect(report.getByTestId('quant-report-section-statistics')).toContainText(net ?? '<no net>');
  // On paper the report prints alone: every section shows, the Print button and the app around it do not.
  await page.emulateMedia({ media: 'print' });
  for (const id of REPORT_SECTIONS) await expect(report.getByTestId(`quant-report-section-${id}`)).toBeVisible();
  await expect(result.getByTestId('quant-report-print')).toBeHidden();
  await expect(page.getByTestId('quant-backtest-run')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  // Print opens the browser's print window, which also saves a PDF.
  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
  });
  await result.getByTestId('quant-report-print').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
});

test(`${J} #7 creates a share link twice, opens it signed out, then revokes it: one active link; the result under its label with no source; revoked, not found`, async ({
  page,
  browser,
}) => {
  const { result, strategy } = await storedVariant(page);
  await result.getByRole('button', { name: 'Share' }).click();
  const share = result.getByTestId('quant-share');
  const state = share.getByTestId('quant-share-state');
  // A link left active by an earlier try is revoked first, so this step starts from no active link.
  await expect(state).toBeVisible();
  if ((await state.getAttribute('data-active')) === 'true') {
    await share.getByTestId('quant-share-revoke').click();
    await expect(state).toHaveAttribute('data-active', 'false');
  }
  const before = Number(await state.getAttribute('data-links'));
  // Create pressed twice: one link is stored and active, and the address is shown once.
  await share.getByTestId('quant-share-create').dblclick();
  const link = await share.getByTestId('quant-share-link').inputValue();
  expect(link).toMatch(/\/quant\/share\/[^/]+$/);
  await expect(state).toHaveAttribute('data-active', 'true');
  await expect(state).toHaveAttribute('data-links', String(before + 1));
  await expect(share.getByTestId('quant-share-create')).toHaveCount(0);
  // The embed code frames that same link by its full address. The site's own frame policy still refuses outside frames,
  // and the room says so rather than promising a frame that would show blank.
  await expect(share.getByTestId('quant-share-embed-code')).toHaveValue(`<iframe src="${link}" title="${CLAIM}"></iframe>`);
  await expect(share.getByTestId('quant-share-embed-blocked')).toContainText('frame policy');

  // A signed-out reader opens the link: the result under its label, with its checks and coverage, and nothing private.
  const visitor = await browser.newContext();
  try {
    const reader = await visitor.newPage();
    await reader.goto(link);
    const shared = reader.getByTestId('quant-shared-document');
    await expect(shared).toBeVisible();
    await expect(reader.getByTestId('quant-shared-claim')).toHaveText(CLAIM);
    await expect(reader.getByTestId('quant-shared-window')).toContainText('BTC/USDT');
    await expect(reader.getByTestId('quant-shared-coverage')).toContainText('Bars read:');
    for (const name of CHECK_NAMES) await expect(shared.getByTestId(`quant-check-${name}`)).toHaveCount(1);
    await expect(reader.getByTestId('quant-shared-variants')).toHaveText('Variants tried on this strategy: 5.');
    const text = await shared.innerText();
    expect(text).not.toContain(developer().email);
    expect(text).not.toContain(strategy);
    expect(text).not.toContain('Fast average');

    // Revoked, the same link reads not found, and the owner's room says so.
    await share.getByTestId('quant-share-revoke').click();
    await expect(share.getByTestId('quant-share-revoked')).toBeVisible();
    await expect(state).toHaveAttribute('data-active', 'false');
    await reader.goto(link);
    await expect(reader.getByTestId('quant-shared-result')).toContainText('This shared result was not found.');
    await expect(reader.getByTestId('quant-shared-document')).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});
