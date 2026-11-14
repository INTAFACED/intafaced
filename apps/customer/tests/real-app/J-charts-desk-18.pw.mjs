// World: none
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUp } from './desk.mjs';
import { api, bestPrices, signOutBrowser } from './stack.mjs';

// J-charts-desk-18 "I watch the health of market feeds, chart usage and the alert engine, and set the module's owner
// values", in the founder console (apps/admin) against the running stack. One test per step, titled "J-charts-desk-18 #<n>".
// The founder is founder A. Every count on the desk is checked against a change this test makes and reads back on its own:
// a customer's own price alert, its own inbox and its own delivery list.
const J = 'J-charts-desk-18';
const RUN = Date.now().toString(36);

/** A fresh customer and its API client. */
async function customer(page, prefix) {
  const who = await signUp(page, `${prefix}${RUN}`);
  await signOutBrowser(page.context());
  return { who, client: await api(who) };
}

async function createAlert(client, targetPrice, direction = 'above') {
  const res = await client.post('/api/notify/trpc/notify.createAlert', { marketId: 'BTC-USDT', direction, targetPrice });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const metric = (page, key) => page.getByRole('table', { name: 'Charts module metrics' }).locator(`tr[data-metric="${key}"]`);

async function openAlertsOnMetrics(page) {
  await page.goto(`${ADMIN}/trade-ops/charts/metrics`);
  await expect(page.getByRole('heading', { name: 'Charts metrics' })).toBeVisible();
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

test(`${J} #4 opens alert engine and delivery health: evaluation lag, firings, deliveries and failures per channel`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const { client } = await customer(page, 'cd18a');
  const context = await browser.newContext();
  const desk = await context.newPage();
  await founderSignIn(desk, 'a');

  const firingsNow = async () => {
    await desk.goto(`${ADMIN}/trade-ops/alerts`);
    await expect(desk.getByRole('heading', { name: 'Alert engine' })).toBeVisible();
    return Number(await desk.locator('[data-field=firings]').getAttribute('data-count'));
  };
  const before = await firingsNow();

  // An alert that is already crossed: above a price below the market fires on the next evaluation pass.
  const { bid } = await bestPrices();
  const target = String(Math.max(1, Math.floor(Number(bid) / 2)));
  await createAlert(client, target);
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

  // Deliveries and failures per channel: each channel's row adds up, and every channel the person's own alert was
  // delivered on is on the desk with at least that many.
  const table = desk.getByRole('table', { name: 'Alert deliveries by channel' });
  await expect(table).toBeVisible();
  const rows = await table.locator('tbody tr').evaluateAll((trs) =>
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
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.total, r.channel).toBe(r.pending + r.accepted + r.refused + r.failed + r.abandoned);
    expect(r.failures, r.channel).toBe(r.failed + r.abandoned);
  }
  // The person's own alert notification and its deliveries, read as the person: each of its channels is on the desk,
  // and that channel counts at least one delivery in the same status.
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
  await context.close();
});
