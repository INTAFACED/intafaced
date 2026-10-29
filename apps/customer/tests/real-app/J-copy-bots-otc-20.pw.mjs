import { test, expect } from '@playwright/test';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-20, in the running app (docs/roadmap/journeys.json): trade from a TradingView alert. One test per step,
// titled "J-copy-bots-otc-20 #<n>", run in order on one verified TEST account with TEST 1000 USDT. Alerts are POSTed to
// the webhook URL the room shows, as TradingView would send them; the alert age limit and failure count are the stack's
// TEST signal terms. Orders and intents are read back from svc-trade.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no /trade/bots/webhooks room and no signal webhook service.
const J = 'J-copy-bots-otc-20';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;

/** Sends an alert to the webhook as TradingView would. */
async function alert(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const intents = async (who) =>
  (await (await api(who)).get(trpc('signals.intents', { webhookId: state('webhookId') }))).body.result.data.items;
const base = (extra = {}) => ({ token: state('token'), alertId: `a-${Date.now()}`, time: new Date().toISOString(), ...extra });

test(`${J} #1 creates a webhook for BTCUSDT: the URL and token shown once; later only the token prefix`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jwh', '1000');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/trade/bots/webhooks');
  await page.getByRole('button', { name: 'New webhook' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Market').selectOption('BTC/USDT');
  await page.getByRole('dialog').getByRole('button', { name: 'Create webhook' }).click();
  const url = (await page.getByTestId('webhook-url').innerText()).trim();
  const token = (await page.getByTestId('webhook-token').innerText()).trim();
  expect(url).toMatch(/^https?:\/\//);
  run.write({ url, token, webhookId: url.split('/').at(-1) });
  await page.reload();
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(page.getByText(token.slice(0, 6))).toBeVisible();
});

test(`${J} #2 an alert with a wrong token, then one older than the limit: refused as auth failed with no intent; refused as stale`, async () => {
  const url = state('url');
  const wrong = await alert(url, { ...base(), token: 'wrong', side: 'buy', amount: '0.001' });
  expect(wrong.status).toBe(401);
  const stale = await alert(url, { ...base({ time: new Date(Date.now() - 3_600_000).toISOString() }), side: 'buy', amount: '0.001' });
  expect(JSON.stringify(stale.body)).toMatch(/stale/);
  expect(await intents(state('trader'))).toHaveLength(0);
});

test(`${J} #3 the same alert id twice: the stored result comes back and no second order is placed`, async () => {
  const body = { ...base({ alertId: `${J}-3` }), side: 'buy', amount: '0.0005' };
  const first = await alert(state('url'), body);
  const second = await alert(state('url'), body);
  expect(second.body).toEqual(first.body);
  expect((await intents(state('trader'))).filter((i) => i.alertId === `${J}-3`)).toHaveLength(1);
});

test(`${J} #4 sends an amount of 50 percent of position: the order is planned as position percent 50`, async () => {
  const res = await alert(state('url'), { ...base({ alertId: `${J}-4` }), side: 'sell', amount: '50%', amountType: 'position_percent' });
  expect(res.status).toBe(200);
  const intent = (await intents(state('trader'))).find((i) => i.alertId === `${J}-4`);
  expect(intent.sizing).toEqual({ kind: 'position_percent', value: '50' });
});

test(`${J} #5 sends a reversal, then a message with no side: one close and one open planned; the missing side refused by field`, async () => {
  await alert(state('url'), { ...base({ alertId: `${J}-5` }), side: 'reverse', amount: '0.0005' });
  const planned = (await intents(state('trader'))).filter((i) => i.alertId === `${J}-5`);
  expect(planned.map((i) => i.action).sort()).toEqual(['close', 'open']);
  const noSide = await alert(state('url'), { ...base({ alertId: `${J}-5b` }), amount: '0.0005' });
  expect(JSON.stringify(noSide.body)).toMatch(/side/);
});

test(`${J} #6 pauses the webhook, and lets three failures pass the count: the next alert refused as paused; then it terminates`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots/webhooks');
  await page
    .getByRole('row', { name: /BTC\/USDT/ })
    .getByRole('button', { name: 'Pause' })
    .click(UNBUILT);
  const paused = await alert(state('url'), { ...base({ alertId: `${J}-6` }), side: 'buy', amount: '0.0005' });
  expect(JSON.stringify(paused.body)).toMatch(/paused/);
  await page
    .getByRole('row', { name: /BTC\/USDT/ })
    .getByRole('button', { name: 'Resume' })
    .click();
  for (let i = 0; i < 3; i++) await alert(state('url'), { ...base({ alertId: `${J}-6-f${i}` }), side: 'buy', amount: '999' });
  await page.reload();
  await expect(page.getByRole('row', { name: /BTC\/USDT/ })).toContainText('Ended');
});

test(`${J} #7 points an alert at the notification URL: one notice appears, and no order is placed`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/trade/bots/webhooks');
  const notifyUrl = (await page.getByTestId('notify-url').innerText({ timeout: 5_000 })).trim();
  const before = (await (await api(trader)).get('/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100')).body;
  await alert(notifyUrl, { ...base({ alertId: `${J}-7` }), message: 'TEST alert' });
  await page.goto('/notifications');
  await expect(page.getByRole('article').filter({ hasText: 'TEST alert' })).toHaveCount(1);
  expect((await (await api(trader)).get('/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100')).body).toEqual(before);
});

test(`${J} #8 clicks the chart price and tries the outside broker link: a staged order opens; nothing sent until confirm; outside link refused`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  const sent = [];
  page.on('request', (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/orders' && sent.push(req.url()));
  await page.goto('/trade/spot/BTC-USDT');
  await page.getByRole('button', { name: 'Trade at this price' }).click(UNBUILT);
  await expect(page.getByRole('textbox', { name: 'Price' }).first()).not.toHaveValue('');
  expect(sent).toHaveLength(0);
  await page.getByRole('link', { name: 'Trade on TradingView' }).click();
  await expect(page.getByText('Trading through an outside broker link isn’t offered.')).toBeVisible();
});
