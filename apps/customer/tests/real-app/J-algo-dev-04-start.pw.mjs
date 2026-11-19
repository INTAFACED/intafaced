// World: book
// Market: live
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, times, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, utcMinute } from './tape.mjs';
import { LABEL, dataOf, openStrategy, read, runRows, saveSignalStrategy, savedStrategyId, startForm, stopRun } from './paper-strategy.mjs';

// J-algo-dev-04 #2 to #4, in the running app (docs/roadmap/journeys.json): start a paper run of a saved strategy on the
// exchange's own prices, retry the start after a lost reply, and choose an outside feed. Run in order on one TEST developer
// of this file's own, who starts signed in with a saved signal-rules strategy version and no paper run; #3 and #4 count the
// run #2 started, so they stay after it here. #1 is in J-algo-dev-04.pw.mjs, #5 to #8 in J-algo-dev-04-alerts.pw.mjs. The
// paper run trades on the local TEST market maker's own 1 minute bars of BTC/USDT; every figure is paper and nothing here
// moves money (svc-quant imports no ledger client).
const J = 'J-algo-dev-04';
const run = journeyState(`${J}-start-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state() {
  const read = run.read();
  if (!read.account || !read.strategyId)
    throw new Error(`${J} starts (start) made no developer and strategy, so this step has no one to act as`);
  return read;
}

/** The runs #2's failed attempts left (the workflow retries a failed step once, JOURNEY_RETRIES=1): stopped and listed. */
const leftRuns = () => state().leftRuns ?? [];

test(`${J} starts (start): a TEST developer signed in with a saved signal-rules strategy version and no paper run`, async ({ page }) => {
  const who = await signUp(page, 'jp');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, who);
  await saveSignalStrategy(page);
  const strategyId = await savedStrategyId(page);
  const paper = await openStrategy(page, strategyId);
  await expect(paper.getByText('This strategy has no paper run yet.')).toBeVisible();
  run.write({ strategyId });
});

test(`${J} #2 sets cash TEST and an empty holdings list, keeps the own-exchange data feed, and starts: a run page with fills, positions and equity from the venue book, every figure labelled paper; no fill at a stale price before a price arrives`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId, runId: earlier } = state();
  // A retry of this step finds the run its failed attempt started (#8399: that run made the later steps count one run
  // too many). It is stopped, so it trades no more, and named, so the later steps count it as already there.
  if (earlier) {
    await stopRun(who, earlier);
    run.write({ runId: undefined, leftRuns: [...leftRuns(), earlier] });
  }
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  const form = await startForm(paper);
  const reply = page.waitForResponse((res) => res.url().includes('/api/quant/trpc/paper.start') && res.request().method() === 'POST');
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const begun = dataOf(await (await reply).json());
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('Version 1 is running on paper.');
  const view = paper.getByTestId('quant-paper-view');
  const runId = begun.runId;
  await expect(view).toHaveAttribute('data-run-id', runId);
  run.write({ runId });

  // The start's own reply: no whole bar has closed since the start, so there is no price and nothing has filled; no
  // earlier price is carried over. A bar closes at the earliest a minute after the start, so the first read is unpriced too.
  expect(begun).toMatchObject({
    cash: '1000',
    holdings: [],
    feed: 'own_venue',
    priced: false,
    pricedThrough: null,
    trades: [],
    equity: [],
  });
  expect(begun.position).toEqual({ symbol: 'BTC/USDT', qty: '0' });
  expect(begun.totals).toMatchObject({ startCash: '1000', fees: '0', net: '0', endEquity: '1000' });
  await expect(view).toHaveAttribute('data-priced', 'false');
  await expect(view.getByText('Waiting for the first price since the start.', { exact: false })).toBeVisible();
  await expect(view.getByTestId('quant-paper-fill')).toHaveCount(0);
  await expect(view.getByTestId('quant-paper-position')).toHaveAttribute('data-qty', '0');
  await expect(view.getByTestId('quant-paper-equity')).toHaveAttribute('data-equity', '1000');

  // Every figure on the run page is labelled paper, and the run says it is not live.
  await expect(view).toHaveAttribute('data-label', LABEL);
  await expect(view).toHaveAttribute('data-live', 'false');
  await expect(view.getByText(LABEL, { exact: true })).toBeVisible();
  await expect(view.getByTestId('quant-paper-position')).toContainText('Paper position:');
  await expect(view.getByTestId('quant-paper-equity')).toContainText('Paper equity:');
  await expect(view.getByTestId('quant-paper-equity')).toContainText('(started with 1000 simulated)');

  // The run fills on the venue's own bars as they close.
  await expect
    .poll(async () => (await read(who, 'quant', 'paper.get', { runId })).trades.length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the paper run made no fill on the TEST tape; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThan(0);

  // The run page shows the run as the service holds it; read both again if a bar closed in between.
  let after;
  await expect(async () => {
    after = await read(who, 'quant', 'paper.get', { runId });
    await page.reload();
    await paper
      .locator(`[data-testid="quant-paper-run"][data-run-id="${runId}"]`)
      .getByRole('button', { name: /^Show run/ })
      .click();
    await expect(view).toHaveAttribute('data-priced', 'true', { timeout: 5_000 });
    const shown = await view
      .getByTestId('quant-paper-fill')
      .evaluateAll((rows) =>
        rows.map((row) => ({ ts: row.dataset.ts, side: row.dataset.side, qty: row.dataset.qty, price: row.dataset.price })),
      );
    expect(shown).toEqual(after.trades.map(({ ts, side, qty, price }) => ({ ts, side, qty, price })));
    await expect(view.getByTestId('quant-paper-position')).toHaveAttribute('data-qty', after.position.qty, { timeout: 1_000 });
    await expect(view.getByTestId('quant-paper-equity')).toHaveAttribute('data-equity', after.totals.endEquity, { timeout: 1_000 });
  }).toPass({ timeout: 90_000 });
  await expect(view.getByRole('region', { name: 'Paper fills' }).getByRole('table')).toBeVisible();
  expect(after.claimLabel).toBe(LABEL);

  // Each fill is at the open of a closed bar of our exchange's own BTC/USDT tape, after the start: never an earlier price.
  const bars = await closedBarsSince(utcMinute(Math.ceil((Date.now() - Date.parse(after.startedAt)) / 60_000) + 1));
  for (const fill of after.trades) {
    expect(Date.parse(fill.ts)).toBeGreaterThan(Date.parse(after.startedAt));
    const bar = bars.find(([at]) => at === Date.parse(fill.ts));
    expect(bar, `a TEST bar at ${fill.ts}`).toBeTruthy();
    expect(toUnits(fill.barPrice)).toBe(toUnits(String(bar[1])));
  }

  // The position and equity follow from those fills: the position is what was bought less what was sold, and equity is
  // the cash left after every fill and its fee plus the position at the close of the last bar read, from the same tape.
  let qty = 0n;
  let cash = toUnits('1000');
  for (const fill of after.trades) {
    const notional = times(fill.price, fill.qty);
    if (fill.side === 'buy') {
      qty += toUnits(fill.qty);
      cash -= notional + toUnits(fill.fee);
    } else {
      qty -= toUnits(fill.qty);
      cash += notional - toUnits(fill.fee);
    }
  }
  expect(after.position).toEqual({ symbol: 'BTC/USDT', qty: fromUnits(qty) });
  const last = bars.find(([at]) => at + 60_000 === Date.parse(after.pricedThrough));
  expect(last, `the TEST bar ending ${after.pricedThrough}`).toBeTruthy();
  const mark = (qty * toUnits(String(last[4]))) / 10n ** 18n;
  expect(toUnits(after.totals.endEquity)).toBe(cash + mark);
});

test(`${J} #3 retries the start dialog after a lost reply: the same run, not a second one`, async ({ page }) => {
  const { account: who, strategyId, runId: first } = state();
  const left = leftRuns();
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  await expect(runRows(paper)).toHaveCount(1 + left.length);
  const form = await startForm(paper);
  // The start reaches svc-quant, but its reply is lost on the way back.
  let lost = false;
  let lostReply = '';
  await page.route('**/api/quant/trpc/paper.start*', async (route) => {
    if (lost) return route.continue();
    lost = true;
    lostReply = await (await route.fetch()).text();
    await route.abort('connectionreset');
  });
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(form.getByTestId('failure')).toBeVisible();
  // The lost reply did start a run on the server: it named a new run, and the service already lists it.
  const lostRunId = /"runId":"([^"]+)"/.exec(lostReply)?.[1];
  expect(lostRunId, `the lost reply names its run: ${lostReply.slice(0, 200)}`).toBeTruthy();
  expect(lostRunId).not.toBe(first);
  const before = await read(who, 'quant', 'paper.list', { strategyId, limit: 50 });
  expect(before.runs.map((row) => row.runId).sort()).toEqual([first, ...left, lostRunId].sort());
  expect(before.counts).toEqual([{ strategyVersion: 1, runs: 2 + left.length }]);
  // Pressed again from the same dialog: the run the lost reply started, not a second one.
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('Version 1 is running on paper.');
  const second = await paper.getByTestId('quant-paper-view').getAttribute('data-run-id');
  expect(second).toBe(lostRunId);
  await page.reload();
  await expect(runRows(paper)).toHaveCount(2 + left.length);
  const list = await read(who, 'quant', 'paper.list', { strategyId, limit: 50 });
  expect(list.runs.map((row) => row.runId).sort()).toEqual([first, ...left, second].sort());
  expect(list.counts).toEqual([{ strategyVersion: 1, runs: 2 + left.length }]);

  // This retry's run is stopped again, so the journey goes on with #2's run alone.
  await paper
    .locator(`[data-testid="quant-paper-run"][data-run-id="${second}"]`)
    .getByRole('button', { name: /^Stop the paper run/ })
    .click();
  await expect(paper.locator(`[data-testid="quant-paper-run"][data-run-id="${second}"]`)).toHaveAttribute('data-state', 'stopped');
});

test(`${J} #4 chooses an outside data feed: the notice that this needs an outside market feed and is switched off in this build, with no run row`, async ({
  page,
}) => {
  const { account: who, strategyId } = state();
  const runs = 2 + leftRuns().length;
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  await expect(runRows(paper)).toHaveCount(runs);
  const form = await startForm(paper, { feed: 'outside_market' });
  await expect(form.getByTestId('quant-paper-feed-notice')).toHaveText(
    'This needs an outside market feed, which is switched off in this build. Choose our exchange’s own prices to start.',
  );
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const refusal = form.getByTestId('quant-paper-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'feed.market');
  await expect(refusal).toHaveText(
    'This needs an outside market feed, which is switched off in this build. Nothing was started, and no run was added.',
  );
  await page.reload();
  await expect(runRows(paper)).toHaveCount(runs);
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).counts).toEqual([{ strategyVersion: 1, runs }]);
});
