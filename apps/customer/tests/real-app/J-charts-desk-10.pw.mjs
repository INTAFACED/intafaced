// World: market, restart
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN, restartWithSetting, stackFile } from './stack.mjs';

// J-charts-desk-10, in the running app (docs/roadmap/journeys.json): where a price alert reaches the person. One test per step,
// titled "J-charts-desk-10 #<n>", run in order on one TEST account in one browser. The alert engine is the stack's own svc-notify,
// sweeping once a minute over the TEST market maker's book. The webhook endpoint is this test's own TEST server on the stack's
// machine (port 14590, one of the stack's TEST webhook ports). Email has no sender on the stack, as in this build, until #5
// restarts notify with the TEST email stand-in, which writes each email to a file in the stack's state folder.
const J = 'J-charts-desk-10';
const ALERTS = '/notifications?view=alerts';
const SETTINGS = '/notifications?view=settings';
// svc-notify sweeps every minute (ALERT_SWEEP_INTERVAL_MS, services/svc-notify/src/alerts/service.ts).
const SWEEP_MS = 60_000;
const HOOK_PORT = 14590;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const NOTIFY = 'http://127.0.0.1:14510';
const EMAIL_OFF = 'Email needs an email delivery service. It is switched off in this build.';
const PUSH_OFF = 'Push needs a push delivery service. It is switched off in this build.';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

let page;
let who;
let hook;
/** Every request the TEST endpoint took, in order: the path, when, the headers and the body as parsed JSON. */
const posts = [];
test.beforeAll(async ({ browser }) => {
  // The person's own endpoint: `/ok/...` takes the alert, `/down/...` answers 503 every time.
  hook = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      posts.push({ method: req.method, path: req.url, at: Date.now(), headers: req.headers, body });
      res.statusCode = req.url?.startsWith('/down/') ? 503 : 200;
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    hook.once('error', reject);
    hook.listen(HOOK_PORT, '127.0.0.1', resolve);
  });
  const context = await browser.newContext({ baseURL: ORIGIN });
  page = await context.newPage();
  who = await signUp(page, 'jcd10');
  await openAlerts();
});
test.afterAll(async () => {
  await page?.context().close();
  await new Promise((resolve) => (hook ? hook.close(() => resolve()) : resolve()));
});

const form = () => page.getByTestId('alerts-form');
const marketSelect = () => form().getByRole('combobox', { name: /^Market/ });
const delivery = () => page.getByTestId('alerts-delivery');
const log = () => page.getByTestId('alerts-log');

async function openAlerts() {
  await page.goto(ALERTS);
  await expect(form()).toBeVisible();
  await expect(marketSelect(), 'the alert form opens once its data has loaded').toBeEnabled();
  await expect(page.getByTestId('alerts-webhook-policy')).not.toHaveText(/Loading/);
}

/** BTC/USDT's last price as Edge serves it: a decimal string. */
async function lastText() {
  const res = await fetch(`${EDGE}/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`);
  expect(res.status).toBe(200);
  const text = String((await res.json()).last);
  expect(text).toMatch(/^\d+(\.\d+)?$/);
  return text;
}
/** A decimal string in hundredths (BTC/USDT's 0.01 tick), as a bigint. */
const cents = (text) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
};
const fromCents = (n) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
/** A TEST price on the 0.01 tick: the last price times percent / 100, worked in scaled bigint. */
const testPrice = (percent, last) => fromCents((cents(last) * BigInt(percent)) / 100n);
const lastSweepAt = async () => (await (await fetch(`${NOTIFY}/ready`)).json()).alerts.sweep.lastAt;

/** Ticks or unticks a delivery channel the way the person does: the label, since the page draws its own box. */
async function setChannel(name, on) {
  const label = delivery().getByTestId(`alerts-delivery-${name}`);
  const box = label.getByRole('checkbox');
  if ((await box.isChecked()) !== on) await label.click();
  await expect(box).toBeChecked({ checked: on });
}

/**
 * Fills the form for BTC/USDT at or below a level above the market, so the next sweep fires it, and saves it through the
 * review. Returns the level.
 */
async function createFiringAlert({ email = false, push = false, webhookUrl = '' } = {}) {
  const target = testPrice(120, await lastText());
  await marketSelect().selectOption({ label: 'BTC/USDT' });
  await form().getByLabel('Notify me when the price is').selectOption({ label: 'At or below' });
  await form().getByLabel('Price (USDT)').fill(target);
  await setChannel('email', email);
  await setChannel('push', push);
  await delivery().getByLabel('Webhook URL (optional)').fill(webhookUrl);
  await form().getByRole('button', { name: 'Review alert' }).click();
  await expect(page.getByRole('heading', { name: 'Review your alert' })).toBeVisible();
  const reaches = ['In the app (always on)', ...(email ? ['Email'] : []), ...(push ? ['Push notification'] : [])].join(', ');
  await expect(page.getByTestId('alerts-review-delivery')).toHaveText(reaches);
  if (webhookUrl) await expect(page.getByTestId('alerts-review-webhook')).toHaveText(webhookUrl);
  else await expect(page.getByTestId('alerts-review-webhook')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save alert' }).click();
  await expect(page.getByTestId('alerts-notices').getByRole('status')).toHaveText('Alert saved. It is active and appears in your list.');
  return target;
}

/** The trigger history row for the alert at `target`, once the sweep has fired it. */
async function firing(target) {
  const row = log()
    .getByTestId('alert-trigger')
    .filter({ hasText: `At or below ${target}.` });
  await expect(async () => {
    await page.getByTestId('alerts-log-refresh').click();
    await expect(row).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 3 * SWEEP_MS, intervals: [5_000] });
  return row;
}

/** The LOCAL-TEST lines the TEST email stand-in wrote, oldest first. */
function mailbox() {
  const file = stackFile('notify-mail-outbox.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)));
}

test(`${J} #1 sets an alert to in-app and email: the in-app row is written on firing, email names its missing service and is never reported as emailed`, async () => {
  test.setTimeout(4 * SWEEP_MS);
  await setChannel('email', true);
  // Beside the ticked email: the dependency, and its code, before anything is saved.
  const emailNote = delivery().getByTestId('alerts-delivery-email-note');
  await expect(emailNote).toContainText(EMAIL_OFF);
  await expect(emailNote.locator('[data-not-connected="vendor.email"]')).toHaveCount(1);
  const target = await createFiringAlert({ email: true });
  const row = await firing(target);
  // The in-app row was written: the trigger history says so, and the inbox holds it.
  await expect(row.locator('[data-testid="alert-trigger-channel"][data-channel="inapp"]')).toHaveText(
    'In the app: written to your notifications.',
  );
  const email = row.locator('[data-testid="alert-trigger-channel"][data-channel="email"]');
  await expect(email).toContainText('Email: not sent.');
  await expect(email).toContainText(EMAIL_OFF);
  await expect(email).not.toContainText('handed');
  await expect(row).not.toContainText(/emailed|sent to your email/i);
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-row').filter({ hasText: `BTC/USDT crossed below ${target}` })).toHaveCount(1);
  await openAlerts();
});

test(`${J} #2 turns on push: the same notice names the push dependency`, async () => {
  await setChannel('push', true);
  const pushNote = delivery().getByTestId('alerts-delivery-push-note');
  await expect(pushNote).toContainText(PUSH_OFF);
  await expect(pushNote.locator('[data-not-connected="vendor.push"]')).toHaveCount(1);
  await setChannel('push', false);
  await expect(delivery().getByTestId('alerts-delivery-push-note')).toHaveCount(0);
});

test(`${J} #3 adds a webhook URL and fires the alert: one HTTP POST with the alert body, and the delivery is logged`, async () => {
  test.setTimeout(4 * SWEEP_MS);
  await expect(page.getByTestId('alerts-webhook-policy')).toHaveText(
    'A webhook may use port 443 and 14590. If your endpoint answers with a 5xx error other than 504, or cannot be reached, it is sent again after 5, 5 and 5 seconds. Any other answer is not sent again.',
  );
  const url = `${HOOK}/ok/${who.handle}`;
  const target = await createFiringAlert({ webhookUrl: url });
  const row = await firing(target);
  await expect(row.getByTestId('alert-webhook-state')).toHaveText('Webhook: delivered.');
  const mine = posts.filter((p) => p.path === `/ok/${who.handle}`);
  expect(mine, 'exactly one POST for one firing').toHaveLength(1);
  const [post] = mine;
  expect(post.method).toBe('POST');
  expect(post.headers['content-type']).toMatch(/^application\/json/);
  expect(post.headers['idempotency-key']).toMatch(/^alert:[0-9a-f-]{36}:1$/);
  expect(post.body).toMatchObject({ type: 'alert.fired', fireNumber: 1, market: 'BTC/USDT', condition: 'less_than', targetPrice: target });
  expect(cents(post.body.markPrice) <= cents(target), `mark ${post.body.markPrice} at or below ${target}`).toBe(true);
  expect(Number.isNaN(Date.parse(post.body.firedAt))).toBe(false);
  // Logged: one attempt, answered 200.
  const attempts = row.getByTestId('alert-webhook-attempt');
  await expect(attempts).toHaveCount(1);
  await expect(attempts.first()).toHaveAttribute('data-status', '200');
  await expect(attempts.first()).toContainText('Attempt 1');
  await expect(attempts.first()).toContainText('HTTP 200');
});

test(`${J} #4 the webhook endpoint fails: it is sent again under the published policy, and the diagnostics show each attempt`, async () => {
  test.setTimeout(5 * SWEEP_MS);
  const url = `${HOOK}/down/${who.handle}`;
  const target = await createFiringAlert({ webhookUrl: url });
  const row = await firing(target);
  // The published schedule: three resends, 5 s apart, then it stops.
  await expect(row.getByTestId('alert-webhook-state')).toHaveText('Webhook: not delivered after 4 attempts.', { timeout: 60_000 });
  const mine = posts.filter((p) => p.path === `/down/${who.handle}`);
  expect(mine, 'the first send and three resends').toHaveLength(4);
  for (let i = 1; i < mine.length; i++) {
    const gap = mine[i].at - mine[i - 1].at;
    expect(gap, `resend ${i} waits the 5 s the policy publishes`).toBeGreaterThanOrEqual(4_500);
    expect(gap, `resend ${i} goes out soon after its 5 s`).toBeLessThan(15_000);
  }
  // Every resend is the same alert firing: the same body and the same idempotency key.
  expect(new Set(mine.map((p) => p.headers['idempotency-key'])).size).toBe(1);
  expect(new Set(mine.map((p) => JSON.stringify(p.body))).size).toBe(1);
  const attempts = row.getByTestId('alert-webhook-attempt');
  await expect(attempts).toHaveCount(4);
  for (let n = 0; n < 4; n++) {
    await expect(attempts.nth(n)).toContainText(`Attempt ${n + 1}`);
    await expect(attempts.nth(n)).toContainText('HTTP 503');
    await expect(attempts.nth(n)).toHaveAttribute('data-cause', 'unavailable');
    await expect(attempts.nth(n)).toContainText('Your endpoint could not take it right now (a 5xx error). Sent again on the schedule.');
  }
});

test(`${J} #5 with the TEST email stand-in set, an alert fires: one email labelled TEST to the person's address with its market, level and time; a second firing sends none`, async () => {
  test.setTimeout(8 * SWEEP_MS);
  restartWithSetting('notify', 'LOCAL_STACK_NOTIFY_EMAIL', 'on');
  try {
    // The person confirms their address with the code the stand-in wrote to it.
    await page.goto(SETTINGS);
    const card = page.locator('[data-testid="nf-channelcard"][data-channel="email"]');
    await card.getByRole('button', { name: 'Add address' }).click();
    await card.getByLabel('Email address').fill(who.email);
    const seen = mailbox().length;
    await card.getByRole('button', { name: 'Save and send a code' }).click();
    let code;
    await expect
      .poll(
        () => {
          const line = mailbox()
            .slice(seen)
            .find((m) => m.to === who.email && m.kind === 'notify.channel.verify');
          code = line ? /Your confirmation code is (\d{6})\b/.exec(line.text)?.[1] : undefined;
          return code;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);
    await card.getByLabel('Six-digit code').fill(code);
    await card.getByRole('button', { name: 'Confirm address' }).click();
    await expect(card).toContainText('Address confirmed.');
    await expect(card).toContainText('Confirmed');

    await openAlerts();
    await setChannel('email', true);
    await expect(delivery().getByTestId('alerts-delivery-email-note')).toHaveText(
      'It goes to the address you confirmed in notification settings.',
    );
    const target = await createFiringAlert({ email: true });
    const row = await firing(target);
    await expect(row.locator('[data-testid="alert-trigger-channel"][data-channel="email"]')).toHaveText(
      'Email: handed to the delivery service.',
    );

    const alertMail = () => mailbox().filter((m) => m.to === who.email && m.kind === 'alert.price.crossed');
    await expect.poll(() => alertMail().length, { timeout: 30_000 }).toBe(1);
    const [mail] = alertMail();
    expect(mail.subject).toMatch(/^TEST · /);
    expect(mail.text).toMatch(/^TEST — written by the LOCAL TEST email stand-in, not sent\./);
    expect(mail.text).toContain('BTC/USDT');
    expect(mail.text).toContain(target);
    expect(mail.text).toMatch(/at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\./);

    // A second firing of the same alert sends none: the sweeps after it pass, and asking for the alert to be evaluated again
    // does not fire it a second time.
    const firedSweep = await lastSweepAt();
    await expect.poll(async () => await lastSweepAt(), { timeout: SWEEP_MS + 30_000, intervals: [2_000] }).not.toBe(firedSweep);
    await page.getByTestId('alerts-log-refresh').click();
    await expect(
      log()
        .getByTestId('alert-trigger')
        .filter({ hasText: `At or below ${target}.` }),
    ).toHaveCount(1);
    expect(alertMail(), 'still one email for the one firing').toHaveLength(1);
    // #4's spent schedule, minutes on: no fifth send to the failing endpoint.
    expect(
      posts.filter((p) => p.path.startsWith('/down/')),
      'no send after the published schedule ran out',
    ).toHaveLength(4);
  } finally {
    restartWithSetting('notify', 'LOCAL_STACK_NOTIFY_EMAIL', null);
  }
});
