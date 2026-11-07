// World: none
import http from 'node:http';
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN, api } from './stack.mjs';

// J-charts-desk-10 "I choose how an alert reaches me", in the running app. Independent tests (OWNER 212): written from
// the step's own words by someone other than the builder, one test per step, titled "J-charts-desk-10 #<n>", run in
// order on one TEST account in one browser.
//
// Where the product has no control yet, these name the ones the step needs:
// - on the alert form (`alerts-form`), a group "How this alert reaches me" with one checkbox per channel ("In-app",
//   "Popup", "Sound", "Email", "Push", "Webhook") and a "Webhook URL" field;
// - beside a channel that needs an outside vendor, its notice: `alert-channel-notice` with `data-channel`;
// - on the page, the published webhook retry policy: `alerts-webhook-policy`, with `data-max-attempts` (every attempt,
//   the first included) and `data-backoff-ms` (the wait before each retry, comma separated);
// - on an alert's row, its webhook deliveries: `alert-webhook-attempt` items with `data-attempt`, `data-http-status` and
//   `data-outcome` ("delivered" or "failed").
//
// Outside: email and push need vendor.email and vendor.push, which this build has not got, so those channels show their
// named notice and nothing claims a delivery. The webhook is our own adapter: the test's own TEST receiver on this machine
// takes its POSTs (the stack has to let a local TEST receiver through; a public deployment keeps its address checks).
// Firing: svc-notify sweeps once a minute; an "At or below" level above the market fires on the next sweep.
const J = 'J-charts-desk-10';
const ALERTS = '/notifications?view=alerts';
const SWEEP_MS = 60_000;
const EMAIL_NOTICE = 'Email needs an email delivery service. It is switched off in this build.';
const PUSH_NOTICE = 'Push needs a push delivery service. It is switched off in this build.';

test.describe.configure({ mode: 'serial' });

let page;
let who;
let receiver; // the TEST webhook receiver: every request it took, by path
const hits = new Map();
const failing = new Set(); // paths the receiver answers with a 500

test.beforeAll(async ({ browser }) => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url, 'http://receiver').pathname;
      const list = hits.get(path) ?? [];
      list.push({ at: Date.now(), method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      hits.set(path, list);
      const fail = failing.has(path);
      res.writeHead(fail ? 500 : 200, { 'content-type': 'text/plain' });
      res.end(fail ? 'TEST receiver: failing on purpose' : 'ok');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({ baseURL: ORIGIN });
  page = await context.newPage();
  who = await signUp(page, 'ijcd10');
  await page.goto(ALERTS);
  await expect(form()).toBeVisible();
  await expect(marketSelect(), 'the alert form opens once its data has loaded').toBeEnabled();
});
test.afterAll(async () => {
  await page?.context().close();
  await new Promise((resolve) => (receiver ? receiver.close(resolve) : resolve()));
});

const form = () => page.getByTestId('alerts-form');
const marketSelect = () => form().getByRole('combobox', { name: /^Market/ });
const channels = () => form().getByRole('group', { name: 'How this alert reaches me' });
const channel = (name) => channels().getByRole('checkbox', { name, exact: true });
const notice = (key) => page.locator(`[data-testid="alert-channel-notice"][data-channel="${key}"]`);
const rows = () => page.getByTestId('alerts-list').getByTestId('alert-row');
const rowWith = (text) => rows().filter({ hasText: text });
const hookUrl = (path) => `http://127.0.0.1:${receiver.address().port}${path}`;

/** BTC/USDT's last price as Edge serves it, as a decimal string. */
async function lastText() {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`);
  expect(res.status).toBe(200);
  const text = String((await res.json()).last);
  expect(text).toMatch(/^\d+(\.\d+)?$/);
  return text;
}

/** A TEST level on the 0.01 tick above the market (percent of the last price), so "At or below" fires on the next sweep. */
async function firingLevel(percent = 120) {
  const [whole, frac = ''] = (await lastText()).split('.');
  const cents = ((BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2))) * BigInt(percent)) / 100n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** A tRPC read of svc-notify as the person. */
async function notifyRead(procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(who)).get(`/api/notify/trpc/${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const alertNamed = async (name) => (await notifyRead('notify.alerts', { limit: 100 })).items.find((a) => a.name === name);

/** Fill the form for BTC/USDT with a firing level and a name, and tick the channels named. Returns the level. */
async function fillAlert(name, message) {
  await page.goto(ALERTS);
  await expect(marketSelect()).toBeEnabled();
  await marketSelect().selectOption({ label: 'BTC/USDT' });
  await form().getByLabel('Notify me when the price is').selectOption({ label: 'At or below' });
  const level = await firingLevel();
  await form().getByLabel('Price (USDT)').fill(level);
  await form().getByLabel('Name (optional)').fill(name);
  await form().getByLabel('Message (optional)').fill(message);
  await expect(channels()).toBeVisible();
  return level;
}

async function save(name) {
  await form().getByRole('button', { name: 'Review alert' }).click();
  await expect(page.getByRole('heading', { name: 'Review your alert' })).toBeVisible();
  await page.getByRole('button', { name: 'Save alert' }).click();
  await expect(rowWith(name)).toHaveCount(1);
  const saved = await alertNamed(name);
  expect(saved, `the alert "${name}" is stored`).toBeTruthy();
  return saved;
}

/** Wait until the alert has fired (one sweep or two). */
async function fired(name) {
  await expect(async () => {
    await page.reload();
    await expect(rowWith(name)).toHaveAttribute('data-status', 'fired', { timeout: 2_000 });
  }).toPass({ timeout: 3 * SWEEP_MS, intervals: [5_000] });
  return alertNamed(name);
}

test(`${J} #1 sets an alert to in-app and email: the in-app row is written on firing, the email channel names its missing delivery service, and the alert is never reported as emailed`, async () => {
  test.setTimeout(5 * SWEEP_MS);
  const name = 'TEST in-app and email';
  await fillAlert(name, 'TEST: BTC/USDT dipped');
  await channel('In-app').check();
  await expect(channel('In-app')).toBeChecked();
  // The person asks for email too. The channel reads its notice, in these words.
  if (await channel('Email').isEnabled()) await channel('Email').check();
  await expect(notice('email')).toHaveText(EMAIL_NOTICE);
  const alert = await save(name);
  // The notice is still beside the email channel once saved: nothing says it will email.
  await expect(rowWith(name)).not.toContainText(/will be emailed|by email/i);

  // Fired: the in-app row is written for this alert.
  const after = await fired(name);
  await expect
    .poll(
      async () =>
        (await notifyRead('notify.list', { limit: 100 })).items.filter(
          (n) => n.kind === 'alert.price.crossed' && n.params?.alertId === alert.id,
        ).length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  const row = (await notifyRead('notify.list', { limit: 100 })).items.find((n) => n.params?.alertId === alert.id);
  expect(row.title.length).toBeGreaterThan(0);

  // Never reported as emailed: not on the alert's row, not in the in-app row, not in what the service says of the alert.
  await page.reload();
  await expect(rowWith(name)).not.toContainText(/emailed|email sent|sent by email|delivered by email/i);
  expect(`${row.title} ${row.body}`).not.toMatch(/emailed|email sent|sent by email|delivered by email/i);
  const told = JSON.stringify(after);
  expect(told).not.toMatch(/emailed/i);
  expect(told).not.toMatch(/"email"[^{}\]]*"(sent|delivered)"/i);
});

test(`${J} #2 turns on push: the same notice, naming the push dependency`, async () => {
  await fillAlert('TEST push', 'TEST: push');
  if (await channel('Push').isEnabled()) await channel('Push').check();
  await expect(notice('push')).toHaveText(PUSH_NOTICE);
  // The same notice as email's, naming push's own dependency, not email's.
  await expect(notice('push')).not.toContainText(/email/i);
  if (await channel('Email').isEnabled()) await channel('Email').check();
  await expect(notice('email')).toHaveText(EMAIL_NOTICE);
});

test(`${J} #3 adds a webhook URL and fires the alert: one HTTP POST with the alert body, and the delivery is logged`, async () => {
  test.setTimeout(6 * SWEEP_MS);
  const name = 'TEST webhook';
  const message = 'TEST: BTC/USDT webhook';
  const path = `/TEST-hook-ok-${Date.now().toString(36)}`;
  const level = await fillAlert(name, message);
  await channel('Webhook').check();
  await form().getByLabel('Webhook URL').fill(hookUrl(path));
  const alert = await save(name);
  await fired(name);

  // One POST, carrying the alert.
  await expect.poll(() => (hits.get(path) ?? []).length, { timeout: SWEEP_MS }).toBeGreaterThanOrEqual(1);
  // Still one a full sweep later: the alert is delivered once.
  await page.waitForTimeout(SWEEP_MS + 10_000);
  const got = hits.get(path);
  expect(got).toHaveLength(1);
  expect(got[0].method).toBe('POST');
  expect(String(got[0].headers['content-type'])).toMatch(/application\/json/);
  const body = JSON.parse(got[0].body);
  const text = JSON.stringify(body);
  expect(text).toContain(alert.id);
  expect(text).toContain('BTC/USDT');
  expect(text).toContain(level);
  expect(text).toContain(message);

  // Logged: the alert's row shows the one delivery, delivered, with the receiver's answer.
  await page.reload();
  const attempts = rowWith(name).getByTestId('alert-webhook-attempt');
  await expect(attempts).toHaveCount(1);
  await expect(attempts.first()).toHaveAttribute('data-attempt', '1');
  await expect(attempts.first()).toHaveAttribute('data-outcome', 'delivered');
  await expect(attempts.first()).toHaveAttribute('data-http-status', '200');
});

test(`${J} #4 the webhook endpoint fails: retries under the published policy, and the error diagnostics show each attempt`, async () => {
  await page.goto(ALERTS);
  // The policy, as the page publishes it.
  const policy = page.getByTestId('alerts-webhook-policy');
  await expect(policy).toBeVisible();
  const maxAttempts = Number(await policy.getAttribute('data-max-attempts'));
  const backoff = String(await policy.getAttribute('data-backoff-ms'))
    .split(',')
    .map((n) => Number(n.trim()));
  expect(maxAttempts).toBeGreaterThan(1);
  expect(backoff).toHaveLength(maxAttempts - 1);
  for (const wait of backoff) expect(wait).toBeGreaterThan(0);
  await expect(policy).toContainText(String(maxAttempts));
  const totalWait = backoff.reduce((a, b) => a + b, 0);
  test.setTimeout(4 * SWEEP_MS + totalWait + 60_000);

  const name = 'TEST webhook fails';
  const path = `/TEST-hook-fail-${Date.now().toString(36)}`;
  failing.add(path);
  await fillAlert(name, 'TEST: failing endpoint');
  await channel('Webhook').check();
  await form().getByLabel('Webhook URL').fill(hookUrl(path));
  await save(name);
  await fired(name);

  // Every attempt the policy allows, and no more.
  await expect.poll(() => (hits.get(path) ?? []).length, { timeout: totalWait + SWEEP_MS, intervals: [1_000] }).toBe(maxAttempts);
  await page.waitForTimeout(Math.max(30_000, backoff.at(-1) + 10_000));
  const got = hits.get(path);
  expect(got).toHaveLength(maxAttempts);
  // Each retry waited at least the published backoff, and carried the same alert.
  for (let i = 1; i < got.length; i++) {
    expect(got[i].at - got[i - 1].at, `retry ${i} waits ${backoff[i - 1]} ms`).toBeGreaterThanOrEqual(backoff[i - 1] - 1_000);
    expect(got[i].method).toBe('POST');
    expect(got[i].body).toBe(got[0].body);
  }

  // The diagnostics: each attempt, numbered, with the receiver's failing answer.
  await page.reload();
  const attempts = rowWith(name).getByTestId('alert-webhook-attempt');
  await expect(attempts).toHaveCount(maxAttempts);
  for (let i = 0; i < maxAttempts; i++) {
    const attempt = attempts.nth(i);
    await expect(attempt).toHaveAttribute('data-attempt', String(i + 1));
    await expect(attempt).toHaveAttribute('data-outcome', 'failed');
    await expect(attempt).toHaveAttribute('data-http-status', '500');
    await expect(attempt).toContainText('500');
  }
});
