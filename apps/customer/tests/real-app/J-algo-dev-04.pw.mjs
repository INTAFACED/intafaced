// World: book
// Market: live
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, times, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { closedBarsSince, tapeWindow, utcMinute } from './tape.mjs';

// J-algo-dev-04, in the running app (docs/roadmap/journeys.json): run a strategy on paper with the exchange's own prices
// and get notified. One test per step, titled "J-algo-dev-04 #<n>", run in order on one TEST developer who starts signed
// in with a saved signal-rules strategy version and a completed backtest. The paper run trades on the local TEST market
// maker's own 1 minute bars of BTC/USDT; every figure is paper and nothing here moves money (svc-quant imports no ledger
// client). No email sender is set on the stack, so email is the honest vendor notice and the notice still appears in the app.
const J = 'J-algo-dev-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const NAME = 'TEST paper alerts';
const LABEL = 'Paper — not live performance';
const TEMPLATE = '{strategy} v{version} paper {side} {qty} {symbol} at {price} ({time})';

test.describe.configure({ mode: 'default' });

function state() {
  const read = run.read();
  if (!read.account || !read.strategyId) throw new Error(`${J} #1 made no developer and strategy, so this step has no one to act as`);
  return read;
}

const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;

/** A signed-in read of one of the developer's own procedures, through Edge. */
async function read(who, service, procedure, input) {
  const client = await api(who);
  const res = await client.get(`/api/${service}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return dataOf(res.body);
}

/** The developer's paper strategy fill notices, as svc-notify stores them. */
async function fillNotices(who) {
  const list = await read(who, 'notify', 'notify.list', { limit: 100 });
  return list.items.filter((item) => item.kind === 'quant.fill');
}

/** The run's fills made at or after the alert was created: the ones the alert announces. */
async function announcedFills(who, runId, since) {
  const paper = await read(who, 'quant', 'paper.get', { runId });
  return paper.trades.filter((trade) => Date.parse(trade.ts) >= Date.parse(since));
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(NAME);
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

async function openStrategy(page, strategyId) {
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  await expect(page.getByTestId('quant-paper')).toBeVisible();
  return page.getByTestId('quant-paper');
}

/** Opens the start dialog and fills it: TEST cash (blank when given ''), no holdings, our own prices, taker, 5 bp, 0 bars. */
async function startForm(paper, { cash = '1000', feed = 'own_venue' } = {}) {
  await paper.getByRole('button', { name: 'Start a paper run' }).click();
  const form = paper.getByTestId('quant-paper-start');
  await form.getByLabel('Starting cash (simulated)').fill(cash);
  await expect(form.getByTestId('quant-paper-holdings')).toHaveText('Starting holdings: None: the run starts from cash only.');
  await form.getByRole('combobox', { name: /^Price data/ }).selectOption(feed);
  await form.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await form.getByLabel('Slippage (basis points)').fill('5');
  await form.getByLabel('Delay (bars)').fill('0');
  return form;
}

const runRows = (paper) => paper.getByTestId('quant-paper-run');

test(`${J} #1 opens the strategy and starts a paper run with starting cash left blank: a refusal naming the cash; nothing starts`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const who = await signUp(page, 'jp');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, who);
  await saveSignalStrategy(page);
  await page.goto('/quant/strategies');
  const strategyId = await page.getByTestId('quant-strategy-row').first().getAttribute('data-id');
  expect(strategyId).toBeTruthy();

  // The journey starts from a completed backtest of the saved version, on the TEST tape's last half hour.
  const window = await tapeWindow(30);
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: NAME });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByTestId('quant-backtest-run').click();
  await expect(room.getByTestId('quant-bar-result')).toBeVisible({ timeout: 60_000 });
  run.write({ strategyId });

  // Start with the cash blank: the refusal names the cash, next to it, and no run is added.
  const paper = await openStrategy(page, strategyId);
  await expect(paper.getByText('This strategy has no paper run yet.')).toBeVisible();
  const form = await startForm(paper, { cash: '' });
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  const refusal = form.getByTestId('quant-paper-refusal');
  await expect(refusal).toHaveAttribute('data-input', 'cash');
  await expect(refusal).toHaveAttribute('data-code', 'quant.paper_cash_unset');
  await expect(refusal).toContainText('Starting cash: starting cash is unset; no amount is assumed. Nothing was started.');
  await page.reload();
  await expect(paper.getByText('This strategy has no paper run yet.')).toBeVisible();
  await expect(runRows(paper)).toHaveCount(0);
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).runs).toEqual([]);
});

test(`${J} #2 sets cash TEST and an empty holdings list, keeps the own-exchange data feed, and starts: a run page with fills, positions and equity from the venue book, every figure labelled paper; no fill at a stale price before a price arrives`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId } = state();
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
  await expect(view.getByRole('table', { name: 'Paper fills' })).toBeVisible();
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
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  await expect(runRows(paper)).toHaveCount(1);
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
  expect(before.runs.map((row) => row.runId).sort()).toEqual([first, lostRunId].sort());
  expect(before.counts).toEqual([{ strategyVersion: 1, runs: 2 }]);
  // Pressed again from the same dialog: the run the lost reply started, not a second one.
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('Version 1 is running on paper.');
  const second = await paper.getByTestId('quant-paper-view').getAttribute('data-run-id');
  expect(second).toBe(lostRunId);
  await page.reload();
  await expect(runRows(paper)).toHaveCount(2);
  const list = await read(who, 'quant', 'paper.list', { strategyId, limit: 50 });
  expect(list.runs.map((row) => row.runId).sort()).toEqual([first, second].sort());
  expect(list.counts).toEqual([{ strategyVersion: 1, runs: 2 }]);

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
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  await expect(runRows(paper)).toHaveCount(2);
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
  await expect(runRows(paper)).toHaveCount(2);
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).counts).toEqual([{ strategyVersion: 1, runs: 2 }]);
});

test(`${J} #5 sets notification channels for the strategy, in-app, email and webhook: in-app on; email shows the vendor notice while the notice still appears in the app; webhook is refused as unavailable and is not saved`, async ({
  page,
}) => {
  const { account: who, strategyId } = state();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const section = page.getByTestId('quant-notify');
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp');
  // In-app is on and stays on.
  const inapp = section.getByRole('checkbox', { name: 'In the app (always on)' });
  await expect(inapp).toBeChecked();
  await expect(inapp).toBeDisabled();

  // Email: the vendor notice, saying the notice still appears in the app; saved.
  await section.getByRole('checkbox', { name: 'Email', exact: true }).check();
  const vendor = section.locator('[data-testid="quant-notify-vendor"][data-channel="email"]');
  await expect(vendor).toHaveAttribute('data-code', 'vendor.email');
  await expect(vendor).toHaveText(
    'Email needs a delivery provider, which is not connected in this build. The notice still appears in the app, and the Email attempt is recorded as not sent.',
  );
  await section.getByRole('button', { name: 'Save notification channels' }).click();
  await expect(section.getByTestId('quant-notify-note')).toHaveText('Saved. Notices go to: In the app, Email.');
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp,email');
  // With email chosen, the notice still goes to the app: in-app stays on, on the page and in what svc-quant stored, and
  // nothing has been sent anywhere yet (no alert exists until #6). #7 reads a real fill notice in the inbox with email on,
  // and its email row recorded as not sent.
  await expect(inapp).toBeChecked();
  await expect(inapp).toBeDisabled();
  expect((await read(who, 'quant', 'notify.get', { strategyId })).channels).toEqual(['inapp', 'email']);
  expect(await fillNotices(who)).toEqual([]);

  // Webhook: refused as unavailable, and nothing is saved.
  await section.getByRole('checkbox', { name: 'My own webhook' }).check();
  await section.getByRole('button', { name: 'Save notification channels' }).click();
  const refusal = section.getByTestId('quant-notify-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'quant.notify_channel_unavailable');
  await expect(refusal).toHaveText('My own webhook has no sender in this build, so it cannot be chosen. Nothing was saved.');
  await page.reload();
  await expect(section.getByTestId('quant-notify-current')).toHaveAttribute('data-channels', 'inapp,email');
  await expect(section.getByRole('checkbox', { name: 'My own webhook' })).not.toBeChecked();
  expect((await read(who, 'quant', 'notify.get', { strategyId })).channels).toEqual(['inapp', 'email']);
});

test(`${J} #6 adds a fill alert with a message template, then changes a strategy parameter: a fill produces one notice with the fields filled; the existing alert is unchanged by the parameter change; an unknown template field is refused`, async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId, runId } = state();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const alerts = page.getByTestId('quant-alerts');
  await expect(alerts.getByText('This strategy has no fill alert yet.')).toBeVisible();

  // An unknown field is refused by name, and nothing is added.
  await alerts.getByRole('button', { name: 'Add a fill alert' }).click();
  const form = alerts.getByTestId('quant-alert-form');
  await form.getByLabel('Message').fill('{strategy} made {profit}');
  await form.getByRole('button', { name: 'Save alert' }).click();
  const refusal = form.getByTestId('quant-alert-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'alert.template_invalid');
  await expect(refusal).toContainText('{profit} is not a field');
  await expect(alerts.getByTestId('quant-alert')).toHaveCount(0);

  // The template with allowed fields, previewed with TEST values, then saved for version 1.
  await form.getByLabel('Message').fill(TEMPLATE);
  await expect(form.getByTestId('quant-alert-preview')).toHaveText(
    'Preview with TEST values: TEST strategy v1 paper buy 0.01 TEST/USD at 100 (2026-01-01T00:00:00.000Z)',
  );
  await form.getByRole('button', { name: 'Save alert' }).click();
  await expect(alerts.getByTestId('quant-alerts-note')).toHaveText('The fill alert is saved for version 1.');
  const row = alerts.getByTestId('quant-alert');
  await expect(row).toHaveCount(1);
  const before = (await read(who, 'quant', 'alert.list', { strategyId })).alerts;
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ strategyVersion: 1, event: 'fill', template: TEMPLATE });
  run.write({ alert: before[0] });

  // A parameter change in Studio: a new version; the alert stays as it was, on version 1.
  await page.goto('/quant/studio');
  const open = page.getByRole('button', { name: `Open ${NAME}` });
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel('Strategy name')).toHaveValue(NAME);
  await page.getByTestId('quant-signal-builder').getByLabel('Slow average (bars)').fill('3');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 2.');
  expect((await read(who, 'quant', 'alert.list', { strategyId })).alerts).toEqual(before);
  await openStrategy(page, strategyId);
  await expect(row).toHaveAttribute('data-version', '1');
  await expect(row).toHaveAttribute('data-alert-id', before[0].alertId);
  await expect(row.getByTestId('quant-alert-template')).toHaveText(TEMPLATE);

  // A fill of #2's run after the alert: one notice, with the template's fields filled from that fill.
  await expect
    .poll(async () => (await announcedFills(who, runId, before[0].createdAt)).length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the paper run made no fill since the alert; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThan(0);
  const [fill] = await announcedFills(who, runId, before[0].createdAt);
  const matching = async () => (await fillNotices(who)).filter((n) => n.params.runId === runId && n.params.filledAt === fill.ts);
  await expect.poll(async () => (await matching()).length, { timeout: 90_000, intervals: [5_000] }).toBe(1);
  const [notice] = await matching();
  expect(notice.params).toMatchObject({
    message: `${NAME} v1 paper ${fill.side} ${fill.qty} BTC/USDT at ${fill.price} (${fill.ts})`,
    mode: 'paper',
    alertId: before[0].alertId,
    strategyId,
    side: fill.side,
    qty: fill.qty,
    price: fill.price,
  });
});

/**
 * The newest `intafaced.quant.order.filled` of this developer, published again twice on the stack's bus with its payload
 * unchanged (same event id) under new envelope keys, so the bus does not drop it as its own duplicate and svc-notify's
 * consumer is what must hold. Returns the payload.
 */
function redeliverFill(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.quantOrderFilled.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.quantOrderFilled.service, prefix);
    const { state } = await jsm.streams.info(stream);
    let payload;
    for (let seq = state.last_seq; seq >= state.first_seq && !payload; seq -= 1) {
      const m = await jsm.streams.getMessage(stream, { seq }).catch(() => null);
      if (m?.subject !== subject) continue;
      const env = decodeEnvelope(m.data);
      if (env.payload.userId === userId) payload = env.payload;
    }
    await nc.close();
    if (!payload) throw new Error('no ' + subject + ' for ' + userId + ' in ' + stream);
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-quant', streamPrefix: prefix });
    for (const n of [1, 2]) {
      await bus.publish('quantOrderFilled', payload, { idempotencyKey: payload.eventId + ':again:' + n + ':' + Date.now() });
    }
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the fill event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-notify's paper fill consumer has taken and acknowledged every message on the bus. */
async function notifyConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .filter((st) => st.name === 'LOCAL_TEST_QUANT')
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'notify-quant-order-filled');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

test(`${J} #7 lets the run fill, then closes the browser: the notice is still created server-side, once per fill even if the event is delivered twice`, async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const { account: who, strategyId, runId, alert } = state();
  if (!alert) throw new Error(`${J} #6 added no alert, so nothing announces a fill`);
  // The developer looks at the run, then closes the browser.
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  await openStrategy(page, strategyId);
  const seen = (await announcedFills(who, runId, alert.createdAt)).length;
  await context.close();

  // With no browser open, the run fills again and the server writes the notice.
  await expect
    .poll(async () => (await announcedFills(who, runId, alert.createdAt)).length, {
      timeout: 12 * 60_000,
      intervals: [15_000],
      message: 'the paper run made no new fill with the browser closed; is the TEST market maker running (pnpm local:market)?',
    })
    .toBeGreaterThan(seen);
  const onePerFill = async () => {
    const fills = await announcedFills(who, runId, alert.createdAt);
    const notices = (await fillNotices(who)).filter((n) => n.params.runId === runId);
    return fills.every((fill) => notices.filter((n) => n.params.filledAt === fill.ts && n.params.side === fill.side).length === 1);
  };
  await expect.poll(onePerFill, { timeout: 90_000, intervals: [5_000] }).toBe(true);

  // The same fill event delivered twice more: still one notice for that fill.
  const userId = (await api(who)).userId;
  const again = redeliverFill(userId);
  expect(again.mode).toBe('paper');
  await notifyConsumerCaughtUp();
  const same = (await fillNotices(who)).filter((n) => n.params.runId === again.runId && n.params.filledAt === again.filledAt);
  expect(same).toHaveLength(1);
  expect(await onePerFill()).toBe(true);

  // Email was chosen with no email sender: the notice is in the app, and its email row says it was not sent.
  const deliveries = await read(who, 'notify', 'notify.deliveries', { notificationId: same[0].id });
  const email = deliveries.find((row) => row.channel === 'email');
  expect(email, JSON.stringify(deliveries)).toBeTruthy();
  expect(email.acceptedAt).toBeNull();
  expect(email.refusalCode).toBe('channel.not_configured');

  // Opened again, the app shows the notice, labelled paper.
  const later = await browser.newContext();
  const reopened = await later.newPage();
  await signIn(reopened, who);
  await reopened.getByRole('button', { name: /^Notifications/ }).click();
  await expect(
    reopened
      .getByRole('dialog', { name: /Notifications/ })
      .getByText('Paper strategy fill (not a real order)')
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await later.close();
});

test(`${J} #8 stops the paper run: no new orders; the record stays`, async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const { account: who, strategyId, runId } = state();
  await signIn(page, who);
  const paper = await openStrategy(page, strategyId);
  const row = paper.locator(`[data-testid="quant-paper-run"][data-run-id="${runId}"]`);
  await row.getByRole('button', { name: /^Stop the paper run/ }).click();
  await expect(paper.getByTestId('quant-paper-note')).toHaveText('The paper run is stopped. It places no new order, and its record stays.');
  await expect(row).toHaveAttribute('data-state', 'stopped');
  const stopped = await read(who, 'quant', 'paper.get', { runId });
  expect(stopped.state).toBe('stopped');
  expect(stopped.stoppedAt).toBeTruthy();

  // Three more closed bars later, nothing new has filled, and nothing filled after the stop.
  await page.waitForTimeout(3 * 60_000);
  const later = await read(who, 'quant', 'paper.get', { runId });
  expect(later.trades).toEqual(stopped.trades);
  for (const trade of later.trades) expect(Date.parse(trade.ts)).toBeLessThan(Date.parse(stopped.stoppedAt));
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  await row.getByRole('button', { name: /^Show run/ }).click();
  await expect(paper.getByTestId('quant-paper-view')).toHaveAttribute('data-state', 'stopped');
  await expect(paper.getByTestId('quant-paper-fill')).toHaveCount(stopped.trades.length);
  // The record stays: the run is still listed, with its fills.
  expect((await read(who, 'quant', 'paper.list', { strategyId, limit: 50 })).runs.map((r) => r.runId)).toContain(runId);
});
