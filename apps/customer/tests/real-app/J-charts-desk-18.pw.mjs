// World: market
// Market: live
import { createServer } from 'node:http';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUp } from './desk.mjs';
import { EDGE, HOOK_PORTS, api, bestPrices, signOutBrowser, tool } from './stack.mjs';
import { makerStatus, ownerValues } from './charts-desk.mjs';
import { answerAfterNavigation } from './navigation.mjs';

// J-charts-desk-18 "I watch the health of market feeds, chart usage and the alert engine, and set the module's owner
// values", in the founder console (apps/admin) against the running stack. One test per step, titled "J-charts-desk-18 #<n>".
// The founder is founder A. Every figure on a desk is checked against a source read on its own: the public trade tape for
// the last tick, svc-trade's public owner values for the two ages and the compare cap, and a customer's own alert, inbox,
// deliveries and alerts page for the alert counts and quota.
//
// #1 and #2 need a real-time market whose stream really stops: the TEST market maker is run on BTC/USDT only, so
// ETH/USDT gets no trade, its stream ages past the owner's stale age (a TEST 35 s on the stack; row d115, 17 Nov 2026:
// delayed and stale are the owner's two ages, the same on every screen) and the feed watcher journals a drop; the maker
// is then started on every market again, ETH/USDT trades, and a reconnect is journaled.
//
// #5 and #6 change platform-wide owner values (the compare cap, the price-alert quota of one plan), so each puts the value
// it found back before it ends, through the same page, with a reason.
const J = 'J-charts-desk-18';
const RUN = Date.now().toString(36);
const BTC = 'BTC/USDT';
const ETH = 'ETH/USDT';
const MINUTE = 60_000;
const SETTINGS = `${ADMIN}/trade-ops/charts/settings`;
// The owner's account plan table on the stack is a TEST table (tooling/profiles/test-owner-values/bank.json, the same
// table svc-bank reads): everyone is on its default plan, TEST Standard, until subscribing is built.
const PLAN = 'standard';
const PLAN_LABEL = 'Price alert quota, TEST Standard';

/** A market's id on the stack, as svc-trade lists it: alerts are kept by market id, never by symbol. */
async function marketIdOf(symbol) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`);
  expect(res.status).toBe(200);
  const market = (await res.json()).find((m) => m.symbol === symbol);
  expect(market, `${symbol} is listed on the stack`).toBeTruthy();
  return market.id;
}

/** The newest trade on the public tape, epoch ms, or null when the market has none. */
async function newestTrade(symbol) {
  const res = await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent(symbol)}?limit=1`);
  expect(res.status).toBe(200);
  const tape = await res.json();
  return tape.length > 0 ? tape[0].timestamp : null;
}

const feedRow = (page, symbol) => page.getByRole('table', { name: 'Candle streams', exact: true }).locator(`tr[data-symbol="${symbol}"]`);

async function openFeeds(page) {
  await page.goto(`${ADMIN}/trade-ops/feeds`);
  await expect(page.getByRole('heading', { name: 'Market feeds', exact: true })).toBeVisible();
}

test.describe(`${J} #1 #2 on a market whose candle stream stops and then resumes`, () => {
  test.describe.configure({ mode: 'serial' });
  let makerWasRunning = false;
  let lastTick = null;
  let boundary = null;

  test.beforeAll(() => {
    // Stopping cancels every resting maker order and starting funds it again: each may take up to the tool's 120 s.
    test.setTimeout(300_000);
    makerWasRunning = /^test market: (ok|STALE)/.test(makerStatus());
    tool('local-test-market.mjs', 'stop');
    tool('local-test-market.mjs', 'start', '--markets', BTC);
  });
  test.afterAll(() => {
    test.setTimeout(300_000);
    tool('local-test-market.mjs', 'stop');
    // Put the maker back as the stack had it: on every market (as the run starts it), or off if it was off.
    if (makerWasRunning) tool('local-test-market.mjs', 'start');
  });

  test(`${J} #1 opens the market feed desk: a stream 40 seconds old reads stale with its age and last tick time, and the drill-down lists its candle gaps`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const owner = await ownerValues(ETH);
    boundary = owner.staleAgeSeconds;
    expect(Number.isInteger(boundary) && boundary > 0 && boundary < 40, `the stale age is set below 40 s (${boundary})`).toBe(true);
    lastTick = await newestTrade(ETH);
    expect(lastTick, 'ETH/USDT has traded on the stack').not.toBeNull();
    // Wait until the stream is at least 40 s old and a whole minute after its last tick has closed with no trade.
    await expect
      .poll(
        async () =>
          (await newestTrade(ETH)) === lastTick && Date.now() >= Math.max(lastTick + 40_000, (Math.floor(lastTick / MINUTE) + 2) * MINUTE),
        {
          timeout: 200_000,
          intervals: [2_000],
        },
      )
      .toBe(true);

    await founderSignIn(page, 'a');
    await openFeeds(page);
    const row = feedRow(page, ETH);
    await expect(row).toHaveAttribute('data-state', 'stale');
    await expect(row.locator('[data-field=state]')).toHaveText('stale');
    const age = Number(await row.locator('[data-field=age]').getAttribute('data-seconds'));
    expect(age).toBeGreaterThanOrEqual(40);
    await expect(row.locator('[data-field=age]')).toHaveText(`${age} s`);
    // The last tick is the tape's own newest trade, to the millisecond, shown to the second in UTC.
    const shown = await row.locator('[data-field=last-tick]').getAttribute('data-at');
    expect(Date.parse(shown)).toBe(lastTick);
    await expect(row.locator('[data-field=last-tick]')).toHaveText(
      `${new Date(lastTick).toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    );
    // The desk judges by the owner's stale age, the one svc-trade serves to every screen.
    await expect(page.getByTestId('feed-boundary')).toHaveAttribute('data-seconds', String(boundary));
    await expect(page.getByTestId('feed-boundary')).toContainText(`older than ${boundary} s (the owner's stale age`);

    await row.getByRole('link', { name: ETH }).click();
    await expect(page.getByRole('heading', { name: `${ETH} feed`, exact: true })).toBeVisible();
    const gaps = page
      .getByRole('region', { name: 'Candle gaps', exact: true })
      .getByRole('table', { name: 'Candle gaps list', exact: true })
      .locator('tbody tr');
    // The newest gap starts at the first minute after the last tick's own minute: no candle was traded since.
    const firstEmpty = new Date((Math.floor(lastTick / MINUTE) + 1) * MINUTE).toISOString();
    await expect(gaps.first()).toHaveAttribute('data-from', firstEmpty);
    expect(Number(await gaps.first().locator('td').nth(2).textContent())).toBeGreaterThanOrEqual(1);
  });

  test(`${J} #2 opens the feed event journal for a market: each drop and reconnect with time, reason and actor (system), read-only`, async ({
    page,
  }) => {
    test.setTimeout(400_000);
    expect(lastTick, '#1 ran and read the last tick').not.toBeNull();
    await founderSignIn(page, 'a');
    const journalOf = async () => {
      await page.goto(`${ADMIN}/trade-ops/feeds/${encodeURIComponent(ETH)}`);
      return page.getByRole('region', { name: 'Feed event journal', exact: true });
    };
    // The drop: dated when the stream passed the stale age, from the system, with the reason.
    const dropAt = new Date(lastTick + boundary * 1000).toISOString();
    await expect
      .poll(async () => (await journalOf()).locator(`tr[data-kind=drop][data-at="${dropAt}"]`).count(), { timeout: 30_000 })
      .toBe(1);
    let journal = await journalOf();
    const drop = journal.locator(`tr[data-kind=drop][data-at="${dropAt}"]`);
    await expect(drop.locator('[data-field=event]')).toHaveText('drop');
    await expect(drop.locator('[data-field=actor]')).toHaveText('system');
    await expect(drop.locator('[data-field=reason]')).toContainText(`past the owner's ${boundary} s stale age`);
    await expect(drop.locator('[data-field=time]')).toHaveText(`${dropAt.slice(0, 19).replace('T', ' ')} UTC`);

    // The stream resumes: the maker trades ETH/USDT again, and the watcher journals the reconnect at that trade's time.
    tool('local-test-market.mjs', 'stop');
    tool('local-test-market.mjs', 'start', '--markets', `${BTC},${ETH}`);
    let resumed = null;
    await expect
      .poll(
        async () => {
          const t = await newestTrade(ETH);
          resumed = t !== null && t > lastTick ? t : null;
          return resumed !== null;
        },
        { timeout: 180_000, intervals: [3_000] },
      )
      .toBe(true);
    // A reconnect of this stop: dated at a trade after the drop's last tick (a stack run before may hold older ones).
    const newestReconnectAt = async () => {
      const at = await (
        await journalOf()
      )
        .locator('tr[data-kind=reconnect]')
        .first()
        .getAttribute('data-at', { timeout: 5_000 })
        .catch(() => null);
      return at === null ? 0 : Date.parse(at);
    };
    await expect.poll(newestReconnectAt, { timeout: 60_000 }).toBeGreaterThan(lastTick);
    journal = await journalOf();
    // Newest first: the reconnect sits above the drop, and is dated at a trade after the drop's last tick.
    const reconnect = journal.locator('tr[data-kind=reconnect]').first();
    const reconnectAt = Date.parse(await reconnect.getAttribute('data-at'));
    expect(reconnectAt).toBeGreaterThan(lastTick);
    expect(reconnectAt).toBeLessThanOrEqual(await newestTrade(ETH));
    await expect(reconnect.locator('[data-field=time]')).toHaveText(
      `${new Date(reconnectAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`,
    );
    await expect(reconnect.locator('[data-field=actor]')).toHaveText('system');
    await expect(reconnect.locator('[data-field=reason]')).toContainText('Candle ticks resumed after');
    const kinds = await journal.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-kind')));
    expect(kinds.indexOf('reconnect')).toBeLessThan(kinds.indexOf('drop'));
    // Read only: the journal offers nothing to press or type.
    await expect(journal.getByRole('button')).toHaveCount(0);
    await expect(journal.getByRole('textbox')).toHaveCount(0);
    await expect(journal.locator('input, select, textarea')).toHaveCount(0);
  });
});

/** A fresh customer and its API client. */
async function customer(page, prefix) {
  const who = await signUp(page, `${prefix}${RUN}`);
  await signOutBrowser(page.context());
  return { who, client: await api(who) };
}

async function createAlert(client, targetPrice, direction = 'above', extra = {}) {
  const res = await client.post('/api/notify/trpc/notify.createAlert', {
    marketId: await marketIdOf(BTC),
    direction,
    targetPrice,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const metric = (page, key) => page.getByRole('table', { name: 'Charts module metrics', exact: true }).locator(`tr[data-metric="${key}"]`);

async function openAlertsOnMetrics(page) {
  await page.goto(`${ADMIN}/trade-ops/charts/metrics`);
  await expect(page.getByRole('heading', { name: 'Charts metrics', exact: true })).toBeVisible();
  const row = metric(page, 'alerts');
  await expect(row).toHaveAttribute('data-served', 'true');
  return Number(await row.locator('[data-field=count]').getAttribute('data-open'));
}

test(`${J} #3 opens charts module metrics: chart opens, alerts, layouts and indicator use with real counts or named blockers`, async ({
  page,
  browser,
}) => {
  const { client } = await customer(page, 'cd18m');
  const context = await browser.newContext();
  const desk = await context.newPage();
  await founderSignIn(desk, 'a');
  const before = await openAlertsOnMetrics(desk);
  // A real count: one more alert held open moves it by exactly one (an alert far above the price never fires).
  await createAlert(client, '10000000');
  await expect.poll(async () => openAlertsOnMetrics(desk), { timeout: 20_000 }).toBe(before + 1);
  await expect(metric(desk, 'alerts').locator('[data-field=count]')).toHaveText(/^\d+ open, \d+ fired today$/);
  // The counts no service keeps are named, never drawn as zero.
  for (const [key, label, what] of [
    ['chart_opens', 'Chart opens', 'records no chart open on the server'],
    ['layouts', 'Saved layouts', "layouts are kept in the person's browser"],
    ['indicator_use', 'Indicator use', 'no server records which ones are used'],
  ]) {
    const row = metric(desk, key);
    await expect(row.getByRole('rowheader')).toHaveText(label);
    await expect(row).toHaveAttribute('data-served', 'false');
    await expect(row.locator('[data-field=count]')).toHaveText('Not served');
    await expect(row.locator('[data-field=source]')).toContainText(what);
    await expect(row.locator('[data-field=count]')).not.toHaveText(/\d/);
  }
  await context.close();
});

/** The alert engine desk's deliveries table: one row per channel, each status count, and failures, as the page shows them. */
async function deliveryRows(desk) {
  const table = desk.getByRole('table', { name: 'Alert deliveries by channel', exact: true });
  await expect(table).toBeVisible();
  return table.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => {
      const n = (f) => Number(tr.querySelector(`[data-field="${f}"]`).textContent);
      return {
        channel: tr.getAttribute('data-channel'),
        total: n('total'),
        pending: n('pending'),
        accepted: n('accepted'),
        refused: n('refused'),
        failed: n('failed'),
        abandoned: n('abandoned'),
        failures: n('failures'),
      };
    }),
  );
}

test(`${J} #4 opens alert engine and delivery health: evaluation lag, firings, deliveries and failures per channel`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // The person's own webhook endpoint, a TEST server on one of the stack's TEST webhook ports, answers 503 every time: the
  // alert's webhook delivery fails, is sent again under the owner's TEST schedule (5, 5 and 5 s), and is then given up.
  const hook = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 503;
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.listen(HOOK_PORTS.alert, '127.0.0.1', resolve);
  });
  try {
    const { client } = await customer(page, 'cd18a');
    const context = await browser.newContext();
    const desk = await context.newPage();
    await founderSignIn(desk, 'a');

    const openEngineDesk = async () => {
      await desk.goto(`${ADMIN}/trade-ops/alerts`);
      await expect(desk.getByRole('heading', { name: 'Alert engine', exact: true })).toBeVisible();
    };
    const firingsNow = async () => {
      await openEngineDesk();
      return Number(await desk.locator('[data-field=firings]').getAttribute('data-count'));
    };
    const webhookRow = async () => (await deliveryRows(desk)).find((r) => r.channel === 'webhook') ?? { abandoned: 0, failures: 0 };
    const before = await firingsNow();
    const hookBefore = await webhookRow();

    // An alert that is already crossed: above a price below the market fires on the next evaluation pass.
    const { bid } = await bestPrices();
    const target = String(Math.max(1, Math.floor(Number(bid) / 2)));
    const alert = await createAlert(client, target, 'above', { webhookUrl: `http://127.0.0.1:${HOOK_PORTS.alert}/down/${RUN}` });
    const inbox = async () => {
      const res = await client.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
      expect(res.status).toBe(200);
      const data = res.body.result.data;
      return (Array.isArray(data) ? data : (data.items ?? [])).filter((n) => String(n.kind).startsWith('alert.'));
    };
    // The sweep runs every minute: the fire reaches the person's own inbox within two passes.
    await expect.poll(async () => (await inbox()).length, { timeout: 150_000, intervals: [5_000] }).toBeGreaterThan(0);
    await expect.poll(firingsNow, { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 1);

    // Evaluation lag: a number of seconds since the last pass, within two passes of a sweep that runs every minute.
    const lag = desk.locator('[data-field=lag]');
    const lagSeconds = Number(await lag.getAttribute('data-seconds'));
    expect(Number.isInteger(lagSeconds)).toBe(true);
    expect(lagSeconds).toBeLessThanOrEqual(120);
    await expect(lag).toContainText(`${lagSeconds} s since the last pass`);
    await expect(desk.locator('[data-field=interval]')).toHaveText('60 s');
    await expect(desk.locator('[data-field=last-pass]')).toContainText(/UTC, took \d+ ms/);

    // The person's own webhook record for this firing, read as the person: every attempt answered 503, and it was given up.
    const ownHook = async () => {
      const res = await client.get(
        `/api/notify/trpc/notify.alertTriggers?input=${encodeURIComponent(JSON.stringify({ alertId: alert.id, limit: 5 }))}`,
      );
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      return res.body.result.data.items[0]?.webhook ?? null;
    };
    await expect.poll(async () => (await ownHook())?.status, { timeout: 90_000, intervals: [5_000] }).toBe('failed');
    const given = await ownHook();
    expect(given.attempts.length, 'the endpoint was tried and sent again').toBeGreaterThan(1);
    for (const a of given.attempts) expect(a.status, `attempt ${a.n}`).toBe(503);

    // Deliveries and failures per channel: each channel's row adds up, the webhook channel counts the person's given-up
    // delivery as one more failure, and every channel the person's own alert was delivered on is on the desk with at least
    // that many.
    await openEngineDesk();
    const rows = await deliveryRows(desk);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.total, r.channel).toBe(r.pending + r.accepted + r.refused + r.failed + r.abandoned);
      expect(r.failures, r.channel).toBe(r.failed + r.abandoned);
    }
    const hookNow = rows.find((r) => r.channel === 'webhook');
    expect(hookNow, 'the webhook channel is on the desk').toBeTruthy();
    expect(hookNow.abandoned, 'the given-up webhook delivery').toBeGreaterThanOrEqual(hookBefore.abandoned + 1);
    expect(hookNow.failures, 'the given-up webhook delivery is a failure').toBeGreaterThanOrEqual(hookBefore.failures + 1);
    const [fired] = await inbox();
    const own = await client.get(
      `/api/notify/trpc/notify.deliveries?input=${encodeURIComponent(JSON.stringify({ notificationId: fired.id }))}`,
    );
    expect(own.status, JSON.stringify(own.body).slice(0, 300)).toBe(200);
    const mine = own.body.result.data;
    expect(mine.length, 'the fired alert was delivered on at least one channel').toBeGreaterThan(0);
    for (const d of mine) {
      const row = rows.find((r) => r.channel === d.channel);
      expect(row, `channel ${d.channel} of the person's own alert delivery is on the desk`).toBeTruthy();
      expect(row[d.status], `${d.channel} ${d.status}`).toBeGreaterThanOrEqual(1);
    }
    await desk.locator('tr[data-channel="webhook"]').scrollIntoViewIfNeeded();
    await context.close();
  } finally {
    await new Promise((resolve) => hook.close(resolve));
  }
});

async function openSettings(page) {
  await page.goto(SETTINGS);
  await expect(page.getByRole('heading', { name: 'Charts settings', exact: true })).toBeVisible();
}

/** Types `value` (blank clears) into the row whose input is labelled `<label>: new value`, saves it with `reason`. */
async function saveValue(page, label, value, reason) {
  const input = page.getByLabel(`${label}: new value`, { exact: true });
  await input.fill(value);
  await page.getByRole('row').filter({ has: input }).getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Reason (kept in the audit)', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: 'Save value', exact: true }).click();
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
}

/** The owner's chart values svc-trade serves for BTC/USDT. */
const chartValues = () => ownerValues(BTC);

const alertRow = (page, key, plan) =>
  page
    .getByRole('table', { name: 'Alert owner values', exact: true })
    .locator(plan ? `tr[data-key="${key}"][data-plan="${plan}"]` : `tr[data-key="${key}"]`);

test(`${J} #5 opens the module's settings page: compare cap, alert quotas, retention and the delayed and stale ages each not set or set; a blank compare cap refuses the customer add with the cap-unset error`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  // What svc-notify serves a customer on the default plan: the price-alert quota, and the trigger log retention or its
  // unset refusal. The page's figures are checked against these.
  const shopper = await browser.newContext();
  const { client } = await customer(await shopper.newPage(), 'cd18s');
  await shopper.close();
  const quotaRes = await client.get('/api/notify/trpc/notify.alertQuota');
  expect(quotaRes.status, JSON.stringify(quotaRes.body).slice(0, 300)).toBe(200);
  const servedQuota = quotaRes.body.result.data.max;
  const triggersRes = await client.get(`/api/notify/trpc/notify.alertTriggers?input=${encodeURIComponent(JSON.stringify({ limit: 1 }))}`);
  const servedRetention = triggersRes.status === 200 ? triggersRes.body.result.data.retentionDays : null;
  if (servedRetention === null) expect(JSON.stringify(triggersRes.body)).toContain('alert_trigger_log_retention_unset');

  await founderSignIn(page, 'a');
  await openSettings(page);
  // Compare cap and the owner's two ages: what svc-trade serves is what the page shows, a number or "Not set".
  const served = await chartValues();
  const cap = served.compareCap;
  for (const [label, value] of [
    ['Compare cap', cap],
    ['Delayed boundary (seconds)', served.delayedBoundarySeconds],
    ['Stale age (seconds)', served.staleAgeSeconds],
  ]) {
    const input = page.getByLabel(`${label}: new value`, { exact: true });
    await expect(input, label).toHaveValue(value === null ? '' : String(value));
    await expect(page.getByRole('row').filter({ has: input }), label).toContainText(value === null ? 'Not set' : String(value));
  }
  // Alert quotas, one per plan of the owner's (TEST) plan table, and the trigger log retention: each a number or
  // "Not set", with where it comes from.
  await expect(page.getByTestId('alert-plans')).toHaveAttribute('data-default-plan', PLAN);
  const plans = await page
    .getByRole('table', { name: 'Alert owner values', exact: true })
    .locator('tr[data-key="priceQuota"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-plan')));
  expect(plans).toContain(PLAN);
  for (const plan of plans) {
    const row = alertRow(page, 'priceQuota', plan);
    await expect(row.locator('[data-field=current]')).toHaveText(/^(\d+|Not set)$/);
    await expect(row.locator('[data-field=source]')).toHaveText(
      /^(Set on this page, .+ UTC by .+|Deployment setting \(never set on this page\))$/,
    );
  }
  // The default plan's quota and the retention are the values the customer is served.
  await expect(alertRow(page, 'priceQuota', PLAN).locator('[data-field=current]')).toHaveText(
    servedQuota === null ? 'Not set' : String(servedQuota),
  );
  await expect(alertRow(page, 'triggerLogDays').locator('[data-field=current]')).toHaveText(
    servedRetention === null ? 'Not set' : String(servedRetention),
  );

  // A blank compare cap: the customer's compare add refuses with the cap-unset error, and nothing is added.
  expect(Number.isInteger(cap), `the stack sets a compare cap to put back (${cap})`).toBe(true);
  await saveValue(page, 'Compare cap', '', `${J} #5 clears the compare cap to see the customer refusal (TEST ${RUN})`);
  try {
    await expect.poll(async () => (await chartValues()).compareCap).toBeNull();
    await openSettings(page);
    await expect(page.getByRole('row').filter({ has: page.getByLabel('Compare cap: new value', { exact: true }) })).toContainText(
      'Not set',
    );

    const context = await browser.newContext();
    const chart = await context.newPage();
    // The chart reads the owner values as it opens; Add pressed before that answer says "Reading the compare limit": wait
    // for the chart's own read of the blank cap, then press once.
    const read = await answerAfterNavigation(
      chart,
      (r) => r.url().includes('/api/v1/charts/owner-values'),
      () => chart.goto('/charts/BTC-USDT'),
    );
    expect((await read.json()).compareCap).toBeNull();
    // The refusal is shown on a drawn chart: wait for its candles.
    await expect
      .poll(async () => Number(await chart.getByTestId('cw').getByTestId('wc-host').first().getAttribute('data-bars')), {
        message: 'the chart draws its candles',
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const tools = chart.getByRole('group', { name: 'Compare and share', exact: true }).first();
    const picker = tools.getByRole('combobox', { name: /Compare with/ });
    // The picker lists the other markets once the market list has loaded: wait for one before reading it.
    await expect(picker.locator('option').first()).toBeAttached({ timeout: 30_000 });
    const first = (await picker.locator('option').allTextContents())[0];
    await picker.selectOption(first);
    await tools.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(chart.getByTestId('compare-note')).toContainText('compare limit, which is not set. Nothing was added.');
    await expect(chart.getByTestId('compare-note')).toHaveAttribute('data-code', 'trade.chart.owner_value_unset');
    await expect(tools.getByRole('list', { name: 'Compared markets', exact: true }).getByRole('listitem')).toHaveCount(0);
    await context.close();
  } finally {
    await openSettings(page);
    await saveValue(page, 'Compare cap', String(cap), `${J} #5 puts the TEST compare cap back as it was (TEST ${RUN})`);
    await expect.poll(async () => (await chartValues()).compareCap).toBe(cap);
  }
});

test(`${J} #6 sets an alert quota for a plan and saves: the change is recorded with who and when, and customers see the new quota`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  // A fresh customer is on the default plan, TEST Standard: nobody can subscribe to another yet.
  const who = await signUp(page, `cd18q${RUN}`);
  const client = await api(who);
  const quotaLine = () => page.getByTestId('alerts-quota');
  await page.goto('/notifications?view=alerts');
  await expect(quotaLine()).toBeVisible();

  const context = await browser.newContext();
  const desk = await context.newPage();
  const founder = await founderSignIn(desk, 'a');
  await openSettings(desk);
  const row = alertRow(desk, 'priceQuota', PLAN);
  const before = await row.locator('[data-field=current]').textContent();
  // The customer sees what applies to their plan now.
  await expect(quotaLine()).toContainText(before === 'Not set' ? 'has not been set' : `0 of ${before} price alerts in use`);

  // A TEST quota of 2 for the plan (3 when 2 is already what applies, so the save changes something), saved with a reason.
  const quota = before === '2' ? 3 : 2;
  const label = PLAN_LABEL;
  const reason = `${J} #6 TEST quota of ${quota} for the TEST Standard plan (${RUN})`;
  const startedAt = Date.now();
  await saveValue(desk, label, String(quota), reason);
  try {
    await openSettings(desk);
    await expect(alertRow(desk, 'priceQuota', PLAN).locator('[data-field=current]')).toHaveText(String(quota));
    await expect(alertRow(desk, 'priceQuota', PLAN)).toHaveAttribute('data-source', 'page');
    // Recorded with who and when: the newest change names the founder, the time, the old and new value and the reason.
    const change = desk.getByRole('table', { name: 'Alert settings changes', exact: true }).locator('tbody tr').first();
    await expect(change).toHaveAttribute('data-plan', PLAN);
    await expect(change.locator('[data-field=who]')).toHaveText(founder.userId);
    const at = Date.parse(await change.locator('[data-field=at]').getAttribute('data-at'));
    expect(at).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
    await expect(change.locator('[data-field=old]')).toHaveText(before);
    await expect(change.locator('[data-field=new]')).toHaveText(String(quota));
    await expect(change.locator('[data-field=reason]')).toHaveText(reason);

    // The customer sees the new quota, and it holds: that many price alerts are taken, the next is refused at the quota.
    await page.reload();
    await expect(quotaLine()).toContainText(`0 of ${quota} price alerts in use`);
    const btcId = await marketIdOf(BTC);
    const create = (n) =>
      client.post('/api/notify/trpc/notify.createAlert', { marketId: btcId, direction: 'above', targetPrice: String(10_000_000 + n) });
    for (let n = 1; n <= quota; n += 1) expect((await create(n)).status).toBe(200);
    const third = await create(quota + 1);
    expect(third.status).not.toBe(200);
    expect(JSON.stringify(third.body)).toContain('alert.quota_reached');
    await page.reload();
    await expect(quotaLine()).toContainText(`${quota} of ${quota} price alerts in use`);
  } finally {
    await openSettings(desk);
    await saveValue(desk, label, before === 'Not set' ? '' : before, `${J} #6 puts the quota back as it was (TEST ${RUN})`);
    await context.close();
  }
});
