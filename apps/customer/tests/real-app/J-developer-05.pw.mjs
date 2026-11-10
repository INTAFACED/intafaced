// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { journeyState, restartWithSetting } from './stack.mjs';
import { holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { testDeposit, testVenue, venueForThisFile, venueRecord } from './venue.mjs';

// J-developer-05, in the running app (docs/roadmap/journeys.json): place an order over the API without ever doubling it.
// One test per step, titled "J-developer-05 #<n>". The developer is a TEST account with a passkey and one live Trade
// key made in the browser (as J-developer-03 makes it); after that every call goes from the developer's own program
// straight to Edge with the key, and no SDK is used. Orders go to the person's own account on the stack's TEST venue
// through svc-trade's user-venue door (switched on for this file only): the program signs each prepared order with the
// person's TEST wallet key, as a bot holding that key would. The venue is the record of every order; the ledger posts
// nothing. Every figure is TEST.
const J = 'J-developer-05';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const SYMBOL = 'BTC-USDC';
/** A TEST limit buy resting far under the TEST ladder (asks from 60010), so it stays open on the venue. */
const BUY = { amount: '0.001', price: '30000' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.key || !s.walletKey) throw new Error(`${J}'s TEST setup made no key and wallet, so this step has no developer to act as`);
  return { ...s, wallet: privateKeyToAccount(s.walletKey), owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** A key unique to this run, step and try, so a retried step never meets its own earlier try's order. */
const keyFor = (step) => `${J}:${RUN}:${step}:try${test.info().retry}`;

const intent = (amount = BUY.amount) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side: 'buy',
  type: 'limit',
  amount,
  price: BUY.price,
  timeInForce: 'GTC',
  reduceOnly: false,
  builderFee: null,
});

/** POST /api/v1/venue/prepare with the Idempotency-Key header, as the developer's program sends it. */
async function prepare(s, idempotencyKey, amount) {
  return withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/prepare',
    body: { owner: s.owner, signer: { role: 'owner', address: s.owner }, intent: intent(amount) },
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/** The wallet key signs the prepared payload: the program's own signing, no SDK. */
async function signPrepared(s, prepared) {
  const t = prepared.typedData;
  const signature = await s.wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: s.owner };
}

/** POST /api/v1/venue/submit with the same header and the signature. */
const submit = (s, idempotencyKey, signature) =>
  withKey(s.key, { method: 'POST', path: '/api/v1/venue/submit', body: { signature }, headers: { 'idempotency-key': idempotencyKey } });

const byKey = (s, idempotencyKey) =>
  withKey(s.key, { path: `/api/v1/venue/orders/by-key?idempotencyKey=${encodeURIComponent(idempotencyKey)}` });

/** Prepare, sign and submit one order under `idempotencyKey`; returns every answer. */
async function place(s, idempotencyKey) {
  const prepared = await prepare(s, idempotencyKey);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const signature = await signPrepared(s, prepared.body.prepared);
  const sent = await submit(s, idempotencyKey, signature);
  return { prepared, signature, sent, cloid: prepared.body.prepared.venueClientOrderId };
}

/** The venue's own open orders of this account under one client order id. */
const venueOrdersWith = async (owner, cloid) =>
  (await venueRecord(owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid);

/** One TEST switch on this account only, on the TEST venue (packages/venue-sim `/test/account-switches`). */
async function accountSwitch(owner, body) {
  const r = await testVenue('/test/account-switches', { owner, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/**
 * TEST setup, not a journey step: a verified passkey account, one live Trade key made through /uc/safe/api-keys/new,
 * this run's TEST wallet key, and TEST 1000 USDC in its own venue account by the TEST venue's deposit control.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().key) return;
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'dev05');
  try {
    const key = await makeKey(page, { name: 'order-bot' });
    expect(key).toBeTruthy();
    const walletKey = testWalletKey();
    run.reset({ who, key, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  } finally {
    await page.close();
  }
});

test(`${J} #1 places an order with an Idempotency-Key: the order is accepted with its id, and the venue has it under the key as its client order id`, async () => {
  const s = state();
  const k = keyFor(1);
  const { prepared, sent, cloid } = await place(s, k);
  // The key is the order's client order key; the prepared order is what the wallet signed.
  expect(prepared.body.reused).toBe(false);
  expect(prepared.body.prepared.intent.clientOrderKey).toBe(prepared.body.actionKey);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  const id = sent.body.outcome.order.venueOrderId;
  expect(id).toBeTruthy();
  const onVenue = await venueOrdersWith(s.owner, cloid);
  expect(onVenue).toHaveLength(1);
  expect(onVenue[0]).toMatchObject({ venueOrderId: id, status: 'open', symbol: SYMBOL, side: 'buy' });
  expect(sent.headers.get('idempotent-replayed')).toBeNull();
  run.write({ first: { key: k, cloid, id, answer: sent.body } });
});

test(`${J} #2 retries the same key and body: the stored response comes back, marked replayed, and the venue still has one order`, async () => {
  const s = state();
  const first = s.first;
  if (!first) throw new Error(`${J} #1 placed no order, so there is nothing to retry`);
  const again = await prepare(s, first.key);
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body).toMatchObject({ reused: true, signed: true });
  expect(again.headers.get('idempotent-replayed')).toBe('true');
  const resent = await submit(s, first.key, await signPrepared(s, again.body.prepared));
  expect(resent.status, JSON.stringify(resent.body)).toBe(200);
  expect(resent.headers.get('idempotent-replayed')).toBe('true');
  expect(resent.body.outcome).toEqual(first.answer.outcome);
  expect(resent.body.outcome.order.venueOrderId).toBe(first.id);
  expect(await venueOrdersWith(s.owner, first.cloid)).toHaveLength(1);
});

test(`${J} #3 retries the same key with a changed quantity: the idempotency conflict code, and no second order`, async () => {
  const s = state();
  const k = keyFor(3);
  const { sent, cloid } = await place(s, k);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const changed = await prepare(s, k, '0.002');
  expect(changed.status, JSON.stringify(changed.body)).toBe(409);
  expect(changed.body.intafacedCode).toBe('idempotency.conflict');
  const onVenue = await venueOrdersWith(s.owner, cloid);
  expect(onVenue).toHaveLength(1);
  // The order on the venue is the first one, at its own quantity.
  expect(Number(onVenue[0].amount)).toBe(Number(BUY.amount));
});

test(`${J} #4 sends two requests with the same key at once: the second gets the in-progress code, and the venue has one order`, async () => {
  const s = state();
  const k = keyFor(4);
  const prepared = await prepare(s, k);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const signature = await signPrepared(s, prepared.body.prepared);
  // The TEST venue holds this account's submits for 2 s, so the first request is still being sent when the second arrives.
  await accountSwitch(s.owner, { submitDelayMs: 2000 });
  let firstAnswer;
  let second;
  try {
    const first = submit(s, k, signature);
    await new Promise((r) => setTimeout(r, 400));
    second = await submit(s, k, signature);
    firstAnswer = await first;
  } finally {
    await accountSwitch(s.owner, { submitDelayMs: 0 });
  }
  expect(firstAnswer.status, JSON.stringify(firstAnswer.body)).toBe(200);
  expect(firstAnswer.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(second.status, JSON.stringify(second.body)).toBe(409);
  expect(second.body.intafacedCode).toBe('idempotency.in_progress');
  expect(second.headers.get('retry-after')).toBe('1');
  expect(await venueOrdersWith(s.owner, prepared.body.prepared.venueClientOrderId)).toHaveLength(1);
});

test(`${J} #5 times out or gets a 5xx after the order is sent: the docs say accepted is not final; read by key it is unknown until the venue answers; a retry on the same key never creates a second venue order`, async ({
  browser,
}) => {
  const s = state();
  // The docs page says it, in the app.
  const page = await holderAgain(browser, s.who);
  try {
    await page.goto('/developers/idempotency');
    const final = page.getByTestId('developers-idempotency-final');
    await expect(final.getByRole('heading', { name: 'Accepted is not final' })).toBeVisible();
    await expect(final).toContainText('Read the order by key with GET /api/v1/venue/orders/by-key');
    await expect(final).toContainText('It reads unknown until the venue answers, never failed or filled.');
    await expect(final).toContainText(
      'A retry on the same key sends the same signed order again, so the venue never creates a second order.',
    );
  } finally {
    await page.close();
  }

  const k = keyFor(5);
  const prepared = await prepare(s, k);
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const cloid = prepared.body.prepared.venueClientOrderId;
  const signature = await signPrepared(s, prepared.body.prepared);
  // The TEST venue applies the next submit on this account, then loses its answer: a timeout after the order was sent.
  await accountSwitch(s.owner, { loseAnswers: 1 });
  const sent = await submit(s, k, signature);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.outcome).toEqual({ definite: false, reason: 'timeout' });
  expect(sent.body.readBack).toEqual({ venueClientOrderId: cloid });

  // While the venue does not answer this account, the order reads unknown: never failed, never filled.
  await accountSwitch(s.owner, { down: true });
  try {
    const unknown = await byKey(s, k);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(200);
    expect(unknown.body).toMatchObject({ state: 'unknown', reason: 'venue_down', order: null });
    const retry = await submit(s, k, signature);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.outcome.definite).toBe(false);
  } finally {
    await accountSwitch(s.owner, { down: false });
  }

  // The venue answers: the order is accepted with the venue's own record, and it exists once.
  const known = await byKey(s, k);
  expect(known.status, JSON.stringify(known.body)).toBe(200);
  expect(known.body).toMatchObject({ state: 'accepted', order: { venueClientOrderId: cloid, status: 'open' } });
  const onVenue = await venueOrdersWith(s.owner, cloid);
  expect(onVenue).toHaveLength(1);
  expect(known.body.order.venueOrderId).toBe(onVenue[0].venueOrderId);
  const after = await submit(s, k, signature);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect(after.headers.get('idempotent-replayed')).toBe('true');
  expect(after.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(await venueOrdersWith(s.owner, cloid)).toHaveLength(1);

  // A 5xx after the order was sent: the TEST venue applies the next submit on this account, then answers HTTP 500.
  const k5 = `${keyFor(5)}:5xx`;
  const second = await prepare(s, k5);
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  const cloid5 = second.body.prepared.venueClientOrderId;
  const signature5 = await signPrepared(s, second.body.prepared);
  await accountSwitch(s.owner, { failAfterSend: 1 });
  const erred = await submit(s, k5, signature5);
  expect(erred.status, JSON.stringify(erred.body)).toBe(200);
  expect(erred.body.outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
  expect(erred.body.readBack).toEqual({ venueClientOrderId: cloid5 });

  // Unknown while the venue does not answer: never failed, never filled; a retry then makes no second order.
  await accountSwitch(s.owner, { down: true });
  try {
    const unknown5 = await byKey(s, k5);
    expect(unknown5.status, JSON.stringify(unknown5.body)).toBe(200);
    expect(unknown5.body).toMatchObject({ state: 'unknown', reason: 'venue_down', order: null });
    const retry5 = await submit(s, k5, signature5);
    expect(retry5.status, JSON.stringify(retry5.body)).toBe(200);
    expect(retry5.body.outcome.definite).toBe(false);
  } finally {
    await accountSwitch(s.owner, { down: false });
  }
  const known5 = await byKey(s, k5);
  expect(known5.status, JSON.stringify(known5.body)).toBe(200);
  expect(known5.body).toMatchObject({ state: 'accepted', order: { venueClientOrderId: cloid5, status: 'open' } });
  const after5 = await submit(s, k5, signature5);
  expect(after5.status, JSON.stringify(after5.body)).toBe(200);
  expect(after5.headers.get('idempotent-replayed')).toBe('true');
  expect(await venueOrdersWith(s.owner, cloid5)).toHaveLength(1);
});

test(`${J} #6 lists orders with a cursor over three pages: each venue order once, the next cursor empty at the end; a blank largest page refuses a list call with a limit`, async () => {
  test.setTimeout(300_000);
  const s = state();
  // Enough orders for three pages of two, whatever earlier steps left.
  const listed = () => withKey(s.key, { path: `/api/v1/venue/orders?owner=${s.owner}&limit=2` });
  for (let n = 0; n < 6; n += 1) {
    const open = (await venueRecord(s.owner, '/open-orders')).value;
    if (open.length >= 5) break;
    const { sent } = await place(s, `${keyFor(6)}:${n}`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  }
  const venueOrders = (await venueRecord(s.owner, '/open-orders')).value;
  expect(venueOrders.length).toBeGreaterThanOrEqual(5);
  // A page size that makes exactly three pages of this account's orders.
  const limit = Math.ceil(venueOrders.length / 3);
  const pageCount = Math.ceil(venueOrders.length / limit);
  expect(pageCount).toBe(3);

  const seen = [];
  let path = `/api/v1/venue/orders?owner=${s.owner}&limit=${limit}`;
  for (let p = 1; p <= pageCount; p += 1) {
    const page = await withKey(s.key, { path });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.orders.length).toBeLessThanOrEqual(limit);
    seen.push(...page.body.orders.map((o) => o.order.venueOrderId));
    if (p < pageCount) {
      expect(page.body.nextCursor).toBeTruthy();
      path = `/api/v1/venue/orders?owner=${s.owner}&limit=${limit}&cursor=${encodeURIComponent(page.body.nextCursor)}`;
    } else {
      expect(page.body.nextCursor).toBeNull();
    }
  }
  // Each venue order once, and only the venue's orders.
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual(venueOrders.map((o) => o.venueOrderId).sort());

  // The owner's largest page blank: a list call with a limit refuses with its typed code, never a guessed page.
  const before = process.env.LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX;
  process.env.LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX = 'off';
  try {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
    const refused = await listed();
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(refused.body.intafacedCode).toBe('trade.venue_orders_page_max_unset');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX;
    else process.env.LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX = before;
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  }
  expect((await listed()).status).toBe(200);
});
