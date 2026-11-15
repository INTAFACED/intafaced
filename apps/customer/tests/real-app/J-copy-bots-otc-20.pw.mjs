// World: gates, restart, stack
import { createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, journeyState } from './stack.mjs';
import { signUp, verify, signIn } from './desk.mjs';
import { testDeposit, testVenue, venueAccount, venueForThisFile, venueInfo } from './venue.mjs';

// J-copy-bots-otc-20, in the running app (docs/roadmap/journeys.json): trade from a TradingView alert. One test per step,
// titled "J-copy-bots-otc-20 #<n>", run in order on one verified TEST account. Alerts are POSTed to the webhook URL the
// room shows, as TradingView would send them; the alert age limit and webhook life are the stack's TEST signal terms.
// An alert's order goes to the venue through svc-trade's user-venue door, switched on for this file (the stack's LOCAL
// TEST venue, tooling/scripts/local-test-venue.mjs): the door prepares the order under the alert's own key, and the
// person's wallet (a TEST key derived from a public name) signs and sends it; INTAFACED holds no key that can sign.
// The step's market, BTCUSDT, is a TEST cash spot market BTC-USDT this file adds to the TEST venue (its
// `/test/market-add` control) and that two TEST operators list through svc-trade's two-person door, as setup; it rests
// no book, so an alert's IOC is accepted and fills nothing. Every figure the TEST venue reports is TEST.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #4 to #8: position-percent sizing, reversals, pause and the failure count, the notification URL and the chart's
//   staged order are not built.
const J = 'J-copy-bots-otc-20';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const UNBUILT = { timeout: 5_000 };
/** The step's BTCUSDT, as the venue names it. */
const SYMBOL = 'BTC-USDT';
const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${RUN}`)));
const owner = key.address.toLowerCase();
/** A TEST alert's size and worst price on BTC-USDT (lot 0.001, tick 0.1). TEST figures. */
const AMOUNT = '0.001';
const PRICE = '70000';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

function state(name) {
  const value = run.read()[name];
  if (!value) throw new Error(`${J}: an earlier step made no ${name}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;

/** Sends an alert to the webhook as TradingView would. */
async function alert(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const intents = async (who) => {
  const res = await (await api(who)).get(trpc('signals.intents', { webhookId: state('webhookId') }));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.items;
};
const base = (extra = {}) => ({ token: state('token'), alertId: `a-${Date.now()}`, time: new Date().toISOString(), ...extra });

// ── setup: the BTC-USDT market on the TEST venue, listed by two TEST operators ──

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hashOf = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/** BTC-USDT on the TEST venue, and our listing of it open: added and listed once per stack, found as it is after. */
async function btcUsdtListed() {
  const venueMarkets = await testVenue('/markets', { account: null });
  expect(venueMarkets.status, JSON.stringify(venueMarkets.body).slice(0, 300)).toBe(200);
  if (!venueMarkets.body.value.some((m) => m.symbol === SYMBOL)) {
    const added = await testVenue('/test/market-add', {
      symbol: SYMBOL,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      maxOrderQty: '10',
      maxOrderNotional: '1000000',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.label).toBe('TEST');
  }
  const ctx = await makeContext({ log: () => undefined });
  const sessions = await approverSessions(ctx);
  const listed = await ctx.edge.query('trade', 'admin.venueMarkets.list', undefined, await sessions.a.tradeOpsToken());
  const row = trpcData(listed)?.markets.find((m) => m.symbol === SYMBOL);
  if (row?.listing?.open) return;
  const venueId = (await venueInfo()).id;
  const expectedVersion = String(row?.listing?.version ?? 0);
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = `LOCAL TEST ${J}: list ${SYMBOL}, the market a chart alert trades`;
  const actionType = 'trade.venue_listing_set';
  const ids = await twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${SYMBOL}`,
    expectedVersion,
    payloadHash: hashOf({ actionType, venueId, symbol: SYMBOL, opensAt, expectedVersion, reason }),
    policyVersion: 'trade-venue-markets-v1',
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol: SYMBOL, opensAt, expectedVersion, reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(Number(expectedVersion) + 1);
}

/** The person's wallet signs a prepared door action and sends it, as the wallet would: POST /api/v1/venue/submit. */
async function signAndSend(who, actionKey, prepared) {
  const t = prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return (await api(who)).post('/api/v1/venue/submit', { actionKey, signature: { digest: prepared.digest, signature, signedBy: owner } });
}

/** The door's prepare of `intent` for the trader's account: a key already prepared returns its stored action, reused. */
async function prepare(who, intent, actionKey) {
  return (await api(who)).post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent,
    ...(actionKey ? { actionKey } : {}),
  });
}

/** The venue's own fills for the trader's account since `since`. */
async function venueFills(since) {
  const { status, body } = await testVenue('/fills', { account: await venueAccount(owner), since: since.toISOString() });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.value;
}

/** The trader's open orders on the venue, as their own read through the door gives them. */
async function venueOpenOrders(who) {
  const res = await (await api(who)).get(`/api/v1/venue/orders/open?owner=${owner}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.value;
}

test(`${J} #1 creates a webhook for BTCUSDT: the URL and token shown once; later only the token prefix`, async ({ page }) => {
  test.setTimeout(240_000);
  await btcUsdtListed();
  const trader = await signUp(page, 'jwh');
  await verify(page, trader);
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/trade/bots/webhooks');
  await page.getByRole('button', { name: 'New webhook' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Market').selectOption(SYMBOL);
  await dialog.getByLabel('Venue account').fill(owner);
  await dialog.getByRole('button', { name: 'Create webhook' }).click();
  const url = (await page.getByTestId('webhook-url').innerText()).trim();
  const token = (await page.getByTestId('webhook-token').innerText()).trim();
  expect(url).toMatch(/^https?:\/\/.+\/api\/v1\/signals\/webhook\/[0-9a-f-]{36}$/);
  expect(token.length).toBeGreaterThan(6);
  run.write({ url, token, webhookId: url.split('/').at(-1) });
  // A later read shows only the prefix: in the room after a reload, and in the person's own read of their webhooks.
  await page.reload();
  const row = page.getByRole('row', { name: new RegExp(SYMBOL) });
  await expect(row).toContainText(`${token.slice(0, 6)}…`);
  await expect(page.getByText(token)).toHaveCount(0);
  const listed = await (await api(trader)).get(trpc('signals.webhooks.list'));
  expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
  const [hook] = listed.body.result.data.filter((w) => w.webhookId === url.split('/').at(-1));
  expect(hook).toMatchObject({ symbol: SYMBOL, venueOwner: owner, tokenPrefix: token.slice(0, 6), state: 'active' });
  expect(JSON.stringify(listed.body)).not.toContain(token);
});

test(`${J} #2 an alert with a wrong token, then one older than the owner's maximum: refused as auth failed with no intent row; refused as stale`, async () => {
  const url = state('url');
  const wrong = await alert(url, { ...base(), token: 'wrong-token', side: 'buy', amount: AMOUNT, price: PRICE });
  expect([wrong.status, wrong.body?.code]).toEqual([403, 'trade.signal_auth_failed']);
  expect(await intents(state('trader'))).toEqual([]);
  // An hour old, far past the stack's TEST maximum alert age.
  const stale = await alert(url, {
    ...base({ time: new Date(Date.now() - 3_600_000).toISOString() }),
    side: 'buy',
    amount: AMOUNT,
    price: PRICE,
  });
  expect([stale.status, stale.body?.code]).toEqual([400, 'trade.signal_stale']);
  expect(await intents(state('trader'))).toEqual([]);
});

test(`${J} #3 the same alert id twice: the stored result is returned and no second order is placed`, async () => {
  test.setTimeout(180_000);
  const trader = state('trader');
  // The person's venue account holds TEST USDT to buy with.
  await testDeposit(owner, 'USDT', '1000', `84532:${keccak256(toHex(`${J} ${RUN} ${owner}`))}:0`);
  const status = (await (await api(trader)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  if (status.builder) {
    // Our builder fee rides on every door order; the person's wallet approves it once, up to the venue's spot cap.
    const markets = await testVenue('/markets', { account: null });
    const cap = markets.body.value.find((m) => m.symbol === SYMBOL)?.builderFeeCapBps;
    expect(cap, `${SYMBOL}'s builder-fee cap as the venue publishes it`).toMatchObject({ known: true });
    const approve = await prepare(
      trader,
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap.value },
      `approve-builder:${owner}:${J}`,
    );
    expect(approve.status, JSON.stringify(approve.body).slice(0, 300)).toBe(200);
    const approved = await signAndSend(trader, approve.body.actionKey, approve.body.prepared);
    expect(approved.status, JSON.stringify(approved.body).slice(0, 300)).toBe(200);
    expect(approved.body.outcome).toMatchObject({ definite: true, accepted: true });
  }

  const since = new Date(Date.now() - 1000);
  const alertId = `${J}-3-${Date.now().toString(36)}`;
  const body = { ...base({ alertId }), side: 'buy', amount: AMOUNT, price: PRICE };
  const first = await alert(state('url'), body);
  expect(first.status, JSON.stringify(first.body).slice(0, 400)).toBe(200);
  const actionKey = `signal-order:${state('webhookId')}:${alertId}`;
  expect(first.body).toMatchObject({ ok: true, alertId, intents: [{ action: 'open', side: 'buy', status: 'prepared', actionKey }] });
  const [intent] = (await intents(trader)).filter((i) => i.alertId === alertId);
  expect(intent).toMatchObject({ action: 'open', side: 'buy', status: 'prepared', actionKey, sizing: { kind: 'quantity', value: AMOUNT } });

  // The one order: the door holds it under the alert's key, and the person's wallet signs and sends it.
  const intentOf = {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: AMOUNT,
    price: PRICE,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: actionKey,
    builderFee: null,
  };
  const held = await prepare(trader, intentOf);
  expect(held.status, JSON.stringify(held.body).slice(0, 400)).toBe(200);
  expect(held.body).toMatchObject({ actionKey, reused: true, signed: false });
  const sent = await signAndSend(trader, actionKey, held.body.prepared);
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  const clientOrderId = held.body.prepared.venueClientOrderId;
  expect(clientOrderId).toBeTruthy();
  const order = await (
    await api(trader)
  ).get(`/api/v1/venue/orders/by-client-id?owner=${owner}&clientOrderId=${encodeURIComponent(clientOrderId)}`);
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBe(200);
  expect(order.body.value, 'the venue holds the one order the alert prepared').not.toBeNull();
  const fillsBefore = await venueFills(since);
  const openBefore = await venueOpenOrders(trader);

  // The same alert id again: the stored result, and nothing new prepared, sent, resting or filled.
  const second = await alert(state('url'), body);
  expect(second).toEqual(first);
  expect((await intents(trader)).filter((i) => i.alertId === alertId)).toHaveLength(1);
  const again = await prepare(trader, intentOf);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body).toMatchObject({ actionKey, reused: true, signed: true });
  expect(again.body.prepared.digest).toBe(held.body.prepared.digest);
  expect(await venueFills(since)).toEqual(fillsBefore);
  expect(await venueOpenOrders(trader)).toEqual(openBefore);
});

test(`${J} #4 sends an amount of 50 percent of position: the order is planned as position percent 50`, async () => {
  const res = await alert(state('url'), {
    ...base({ alertId: `${J}-4` }),
    side: 'sell',
    amount: '50%',
    amountType: 'position_percent',
    price: PRICE,
  });
  expect(res.status).toBe(200);
  const intent = (await intents(state('trader'))).find((i) => i.alertId === `${J}-4`);
  expect(intent.sizing).toEqual({ kind: 'position_percent', value: '50' });
});

test(`${J} #5 sends a reversal, then a message with no side: one close and one open planned; the missing side refused by field`, async () => {
  await alert(state('url'), { ...base({ alertId: `${J}-5` }), side: 'reverse', amount: AMOUNT, price: PRICE });
  const planned = (await intents(state('trader'))).filter((i) => i.alertId === `${J}-5`);
  expect(planned.map((i) => i.action).sort()).toEqual(['close', 'open']);
  const noSide = await alert(state('url'), { ...base({ alertId: `${J}-5b` }), amount: AMOUNT, price: PRICE });
  expect(noSide).toMatchObject({ status: 400, body: { code: 'trade.signal_format_invalid', field: 'side' } });
  expect((await intents(state('trader'))).filter((i) => i.alertId === `${J}-5b`)).toEqual([]);
});

test(`${J} #6 pauses the webhook, and lets three failures pass the count: the next alert refused as paused; then it terminates`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/trade/bots/webhooks');
  const row = () => page.getByRole('row', { name: new RegExp(SYMBOL) });
  await row().getByRole('button', { name: 'Pause' }).click(UNBUILT);
  const paused = await alert(state('url'), { ...base({ alertId: `${J}-6` }), side: 'buy', amount: AMOUNT, price: PRICE });
  expect([paused.status, paused.body?.code]).toEqual([409, 'trade.signal_paused']);
  expect((await intents(trader)).filter((i) => i.alertId === `${J}-6`)).toEqual([]);
  await row().getByRole('button', { name: 'Resume' }).click();
  // Three failures in a row: each an order the venue refuses (far above its TEST largest order), so each is refused.
  for (let i = 0; i < 3; i++) {
    const failed = await alert(state('url'), { ...base({ alertId: `${J}-6-f${i}` }), side: 'buy', amount: '999', price: PRICE });
    expect(failed.status, JSON.stringify(failed.body).slice(0, 300)).toBe(422);
    expect(failed.body).toMatchObject({ ok: false, intents: [{ status: 'refused' }] });
  }
  await page.reload();
  await expect(row()).toContainText('Ended');
  // After the count the webhook has terminated: the next alert is refused as ended and writes nothing.
  const after = await alert(state('url'), { ...base({ alertId: `${J}-6-after` }), side: 'buy', amount: AMOUNT, price: PRICE });
  expect([after.status, after.body?.code]).toEqual([410, 'trade.signal_webhook_ended']);
  expect((await intents(trader)).filter((i) => i.alertId === `${J}-6-after`)).toEqual([]);
});

test(`${J} #7 points an alert at the notification URL: one notice appears, and no order is placed`, async ({ page }) => {
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto('/trade/bots/webhooks');
  const notifyUrl = (await page.getByTestId('notify-url').innerText({ timeout: 5_000 })).trim();
  const since = new Date(Date.now() - 1000);
  const openBefore = await venueOpenOrders(trader);
  const intentsBefore = await intents(trader);
  const res = await alert(notifyUrl, { ...base({ alertId: `${J}-7` }), message: 'TEST alert' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  await page.goto('/notifications');
  await expect(page.getByRole('article').filter({ hasText: 'TEST alert' })).toHaveCount(1);
  // No order: nothing planned or prepared for the alert, nothing resting and nothing filled on the venue.
  expect(await intents(trader)).toEqual(intentsBefore);
  expect(await venueOpenOrders(trader)).toEqual(openBefore);
  expect(await venueFills(since)).toEqual([]);
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
