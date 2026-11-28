// World: book, restart
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState, restartService, STACK_PORTS } from './stack.mjs';
import { signIn } from './desk.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  openVenueDesk,
  openVenuePage,
  sameDecimal,
  shownBalance,
  testDeposit,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-15, the steps a developer's bot takes through our API on the venue (docs/roadmap/journeys.json): one test
// per step, titled "J-cex-spot-15 #<n>". The journey's start is made once, as TEST setup: a verified TEST account with
// a live Trade key made in the browser, its TEST wallet, and one agent permission the wallet signed for the bot's own
// agent key (an `approve_agent` on the person's venue account, through the person's signed-in session: an API key can
// never approve an agent). From then on the bot is a program holding only the API key and the agent key: every call
// goes straight to Edge with the key, and every order it sends is signed by the agent key. The venue is the record of
// every order; the ledger posts nothing. Every figure is TEST.
const J = 'J-cex-spot-15';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-api-${RUN}`);
const SYMBOL = 'BTC-USDC';
/** A TEST limit buy resting under the TEST ladder and inside the venue's price band, so it stays open on the venue. */
const BUY = { amount: '0.001', price: '59000' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.key || !s.walletKey || !s.agentKey)
    throw new Error(`${J}'s TEST setup made no key, wallet and agent permission, so there is no bot`);
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();
  const agent = privateKeyToAccount(s.agentKey);
  return { ...s, owner, agent, agentAddress: agent.address.toLowerCase() };
}

/** The prepared payload, signed by one key: the bot's own signing, no SDK. */
async function signWith(account, prepared) {
  const t = prepared.typedData;
  const signature = await account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: account.address.toLowerCase() };
}

/** Prepare, sign with `signerAccount` and submit one action through the API key, as the bot sends it. */
async function send(s, intent, signerAccount = s.agent) {
  const prepared = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/prepare',
    body: { owner: s.owner, signer: { role: 'agent', address: signerAccount.address.toLowerCase() }, intent },
  });
  if (prepared.status !== 200) return { prepared, sent: null };
  const signature = await signWith(signerAccount, prepared.body.prepared);
  const sent = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/submit',
    body: { actionKey: prepared.body.actionKey, signature },
  });
  return { prepared, signature, sent };
}

const buy = (clientOrderKey) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side: 'buy',
  type: 'limit',
  amount: BUY.amount,
  price: BUY.price,
  timeInForce: 'GTC',
  reduceOnly: false,
  builderFee: null,
  clientOrderKey,
});

/** The bot reads its order by its own client id: the venue's record of it. */
const lookUp = (s, clientOrderKey) =>
  withKey(s.key, {
    path: `/api/v1/venue/orders/by-client-id?owner=${s.owner}&clientOrderKey=${encodeURIComponent(clientOrderKey)}`,
  });

/** The order page's heading (side, market, status) and one of its labelled facts. */
const orderHeading = (page) => page.getByTestId('venue-order-heading');
const orderFact = (page, label) =>
  page
    .getByTestId('venue-order-facts')
    .getByTestId('venue-order-row')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');

/**
 * TEST setup, not a journey step (the journey's Starts): a verified passkey account, one live Trade key made through
 * /uc/safe/api-keys/new, this run's TEST wallet with TEST 1000 USDC on its own venue account (the TEST venue's deposit
 * control), and the agent permission: the wallet signs `approve_agent` for a fresh agent key the bot holds.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().agentKey) return;
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'cs15a');
  try {
    const key = await makeKey(page, { name: 'spot-bot' });
    expect(key).toBeTruthy();
    const walletKey = testWalletKey();
    const wallet = privateKeyToAccount(walletKey);
    const owner = wallet.address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const agentKey = generatePrivateKey();
    const agentAddress = privateKeyToAccount(agentKey).address.toLowerCase();
    const person = await api(who);
    const actionKey = `bot-agent:${person.userId}:${J}:${RUN}`;
    const prepared = await person.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_agent', agentAddress, agentName: 'TEST spot bot', validUntil: null },
      actionKey,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const approved = await person.post('/api/v1/venue/submit', { actionKey, signature: await signWith(wallet, prepared.body.prepared) });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.outcome).toMatchObject({ definite: true, accepted: true });
    run.reset({ who, key, walletKey, agentKey });
  } finally {
    await page.close();
  }
});

test(`${J} #4 reads which order types the API accepts: the same list the ticket shows`, async ({ page, stepPicture }) => {
  test.setTimeout(240_000);
  const s = state();
  // The venue's own record of this spot market, read straight from the TEST venue.
  const venueMarket = (await venueRecord(s.owner, '/markets')).value.find((m) => m.symbol === SYMBOL);
  expect(venueMarket, `${SYMBOL} is listed on the TEST venue`).toBeTruthy();

  // What the API itself says it takes: GET /api/v1/order-types, through the edge, matching the venue's spot market.
  const answer = await page.request.get('/api/v1/order-types');
  expect(answer.status(), await answer.text()).toBe(200);
  const published = await answer.json();
  expect(published.source).toBe('venue');
  expect(published.symbol).toBe(SYMBOL);
  expect(published.accepted.map((row) => row.id)).toEqual(venueMarket.orderTypes.filter((x) => x === 'limit' || x === 'market'));
  for (const row of published.accepted) {
    for (const tif of row.timeInForce) expect(venueMarket.timeInForce).toContain(tif);
  }
  // Asking by explicit symbol returns the same list; an unlisted symbol refuses by name.
  const bySymbol = await page.request.get(`/api/v1/order-types?symbol=${encodeURIComponent(SYMBOL)}`);
  expect(bySymbol.status(), await bySymbol.text()).toBe(200);
  expect(await bySymbol.json()).toEqual(published);
  const unknown = await page.request.get('/api/v1/order-types?symbol=NO-SUCH-PAIR');
  expect(unknown.status(), await unknown.text()).toBe(400);
  expect((await unknown.json()).intafacedCode).toBe('trade.venue.unknown_market');

  // The portal's page names each accepted type and each refused type, in the API's order, with each example body whole.
  await page.goto('/developers');
  await page.getByRole('main').getByRole('link', { name: 'Order types', exact: true }).click();
  await expect(page).toHaveURL(/\/developers\/order-types$/);
  const accepted = page.getByTestId('order-types-accepted').locator('tbody tr');
  await expect(accepted).toHaveCount(published.accepted.length);
  expect(await accepted.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-type')))).toEqual(
    published.accepted.map((row) => row.id),
  );
  const docNames = (await accepted.locator('th').allInnerTexts()).map((name) => name.trim());
  const examples = await accepted.locator('pre').allInnerTexts();
  expect(examples.map((text) => JSON.parse(text))).toEqual(published.accepted.map((row) => row.send.example));
  const refused = page.getByTestId('order-types-refused').locator('tbody tr');
  await expect(refused).toHaveCount(published.refused.length);
  expect(await refused.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-type')))).toEqual(
    published.refused.map((row) => row.id),
  );
  const docRefused = (await refused.locator('th').allInnerTexts()).map((name) => name.trim());
  for (const row of published.refused) {
    await expect(page.locator(`[data-testid="order-types-refused"] tbody tr[data-type="${row.id}"]`)).toContainText(row.code);
  }

  // The launch venue spot ticket a person sees: its type tabs, in order, and the kinds it lists as not offered.
  await openVenueDesk(page, s.who, `/trade/spot/${SYMBOL}`, s.walletKey);
  const ticket = page.getByTestId('dk-order');
  const tabs = ticket.getByRole('tablist', { name: 'Order type', exact: true }).getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  const ticketNames = (await tabs.allInnerTexts()).map((name) => name.trim());
  expect(ticketNames, 'the API lists exactly the venue ticket’s types, in the ticket’s order').toEqual(docNames);
  const notOffered = ticket.getByTestId('venue-order-types').getByRole('button');
  await expect(notOffered).toHaveCount(docRefused.length);
  for (const btn of await notOffered.all()) await expect(btn).toBeDisabled();
  expect(
    await notOffered.evaluateAll((btns) => btns.map((b) => b.getAttribute('data-not-offered'))),
    'the API refuses the exact types the venue ticket disables, in order',
  ).toEqual(published.refused.map((row) => row.id));
  await expect(notOffered).toHaveText(docRefused.map((name) => `${name}: not offered by this venue`));
  await ticket.scrollIntoViewIfNeeded();
  await stepPicture();
});

test(`${J} #5 places an order with a client id through our API, looks it up by client id, cancels by client id: the venue order, then its state, then its cancel; a repeat returns the first outcome; the API signs with the user's agent permission only`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  // The agent permission is on the venue's own record of the account: the bot's key, named, approved by the wallet.
  const agents = (await venueRecord(s.owner, '/agents')).value;
  expect(agents.map((a) => a.address)).toContain(s.agentAddress);
  const clientId = `bot:${RUN}:${test.info().retry}:${Date.now().toString(36)}`;

  // ── Place: one venue order, under the bot's client id, signed by the agent key ──────────────────────────────────
  const placed = await send(s, buy(clientId));
  expect(placed.prepared.status, JSON.stringify(placed.prepared.body)).toBe(200);
  expect(placed.prepared.body.prepared.intent.clientOrderKey).toBe(clientId);
  expect(placed.sent.status, JSON.stringify(placed.sent.body)).toBe(200);
  expect(placed.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  const venueOrderId = placed.sent.body.outcome.order.venueOrderId;
  expect(venueOrderId).toBeTruthy();
  expect(placed.signature.signedBy).toBe(s.agentAddress);
  const cloid = placed.prepared.body.prepared.venueClientOrderId;
  const onVenue = (await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid);
  expect(onVenue).toHaveLength(1);
  expect(onVenue[0]).toMatchObject({ venueOrderId, status: 'open', symbol: SYMBOL, side: 'buy' });

  // ── Look up by client id: the venue's own state of that order ──────────────────────────────────────────────────
  const found = await lookUp(s, clientId);
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(found.body.value).toMatchObject({ venueOrderId, venueClientOrderId: cloid, status: 'open', symbol: SYMBOL, side: 'buy' });
  expect(Number(found.body.value.amount)).toBe(Number(BUY.amount));
  expect(Number(found.body.value.price)).toBe(Number(BUY.price));
  // The same order as the person sees it in the app: its own page, under the bot's venue client order id, open.
  await openVenuePage(page, s.who, `/trade/orders/${cloid}`, s.walletKey);
  await expect(orderHeading(page)).toContainText(`Buy ${SYMBOL}`);
  await expect(orderHeading(page).locator('[data-cell="status"]')).toHaveText('Open');
  await expect(orderFact(page, 'Venue client order ID')).toHaveText(cloid);

  // ── A repeat of the same client id returns the first outcome, and the venue still has one order ────────────────
  const again = await send(s, buy(clientId));
  expect(again.prepared.status, JSON.stringify(again.prepared.body)).toBe(200);
  expect(again.prepared.body).toMatchObject({ reused: true, signed: true });
  expect(again.sent.status, JSON.stringify(again.sent.body)).toBe(200);
  expect(again.sent.body.outcome).toEqual(placed.sent.body.outcome);
  expect((await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid)).toHaveLength(1);

  // ── Cancel by client id, signed by the agent key: the venue's cancel, then the order's state reads cancelled ───
  const cancel = { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: clientId };
  const cancelled = await send(s, cancel);
  expect(cancelled.prepared.status, JSON.stringify(cancelled.prepared.body)).toBe(200);
  expect(cancelled.sent.status, JSON.stringify(cancelled.sent.body)).toBe(200);
  expect(cancelled.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(cancelled.signature.signedBy).toBe(s.agentAddress);
  const after = await lookUp(s, clientId);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect(after.body.value).toMatchObject({ venueOrderId, status: 'canceled' });
  expect((await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid)).toHaveLength(0);
  // Its page now reads the venue's cancel: Cancelled, nothing filled.
  await page.reload();
  await expect(orderHeading(page).locator('[data-cell="status"]')).toHaveText('Cancelled', { timeout: 30_000 });
  await expect(orderFact(page, 'Venue client order ID')).toHaveText(cloid);
  await expect(page.getByText('Nothing has filled.', { exact: true })).toBeVisible();
  // A repeat of the cancel returns the first cancel's outcome; nothing more is sent.
  const cancelAgain = await send(s, cancel);
  expect(cancelAgain.prepared.body).toMatchObject({ reused: true, signed: true });
  expect(cancelAgain.sent.body.outcome).toEqual(cancelled.sent.body.outcome);

  // ── The agent permission only: a key the wallet never approved can't place, and the agent key can't withdraw ──
  const stranger = privateKeyToAccount(generatePrivateKey());
  const unapproved = await send(s, buy(`${clientId}:stranger`), stranger);
  // Refused before anything is signed: the venue lists no such agent on the account.
  expect(unapproved.prepared.status, JSON.stringify(unapproved.prepared.body)).toBe(422);
  expect(unapproved.prepared.body.intafacedCode).toBe('trade.venue.signer_not_authorised');
  expect(unapproved.sent).toBeNull();
  // Nothing of it rests on the venue: the account has no open order at all after the bot's cancel.
  expect((await venueRecord(s.owner, '/open-orders')).value).toHaveLength(0);
  const usdcBefore = (await venueRecord(s.owner, '/balances')).value.find((b) => b.asset === 'USDC');
  const withdraw = await send(s, {
    kind: 'withdraw',
    asset: 'USDC',
    amount: '10',
    destination: s.owner,
    withdrawalKey: `withdraw:${RUN}:${clientId}`,
  });
  // A withdrawal is the wallet's alone: an API key can never even prepare one.
  expect(withdraw.prepared.status, JSON.stringify(withdraw.prepared.body)).toBe(403);
  expect(withdraw.prepared.body.intafacedCode).toBe('scope.interactive_only');
  expect(withdraw.sent).toBeNull();
  expect((await venueRecord(s.owner, '/balances')).value.find((b) => b.asset === 'USDC')).toEqual(usdcBefore);
  // The step ends on the bot's order as the person sees it: the venue's cancel of it.
  await expect(orderHeading(page).locator('[data-cell="status"]')).toHaveText('Cancelled');
  await stepPicture();
});

/** A chain-transfer-shaped TEST deposit reference of its own (`<chainId>:<txHash>:<logIndex>`). */
const depositRef = () => `84532:0x${randomBytes(32).toString('hex')}:0`;

/**
 * The bot's own private stream: a stream token its API key asks identity for, then a WebSocket straight to the stream
 * service with `?channel=balances`. Keeps every frame, parsed.
 */
async function openBalances(key) {
  const minted = await withKey(key, { method: 'POST', path: '/api/v1/stream/token', body: {} });
  expect(minted.status, `the key gets a stream token: ${JSON.stringify(minted.body).slice(0, 300)}`).toBe(200);
  const url = `ws://127.0.0.1:${STACK_PORTS.ws}/private/stream?access_token=${encodeURIComponent(minted.body.token)}&channel=balances`;
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the private balances stream did not open')), { once: true });
  });
  return { frames, close: () => socket.close() };
}

/**
 * The person's newest venue balance change delivered to the stream once more: their newest trade.venue_balance.updated on
 * the stack's bus, published again with its payload unchanged (the same change id) under a new envelope key, so the bus
 * does not drop it as its own duplicate and the stream is what must ignore it. Returns the payload.
 */
function redeliverBalanceChange(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.venueBalanceChanged.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.venueBalanceChanged.service, prefix);
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
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-trade', streamPrefix: prefix });
    await bus.publish('venueBalanceChanged', payload, { idempotencyKey: payload.changeId + ':again:' + Date.now() });
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: `nats://127.0.0.1:${STACK_PORTS.nats}`, NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the balance change again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test(`${J} #9 subscribes to the private balances stream: one event per change in the venue balance, with its source and the new total; a duplicate id is ignored`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const person = await api(s.who);
  const stream = await openBalances(s.key);
  try {
    // The channel the bot named is the one it gets, with the stream's bus attached.
    await expect.poll(() => stream.frames.find((f) => f.channel === 'balances' && f.type === 'ready')?.bus, { timeout: 15_000 }).toBe(true);
    const changes = () => stream.frames.filter((f) => f.channel === 'balances' && f.type === 'balance');

    // ── One change: a TEST deposit to the person's venue account. One event, its source the deposit, its total the venue's
    const first = depositRef();
    expect(await testDeposit(s.owner, 'USDC', '25', first)).toBe(true);
    await expect.poll(() => changes().length, { timeout: 30_000, message: 'the deposit arrives on the stream' }).toBe(1);
    const afterFirst = await venueBalance(s.owner, 'USDC');
    const one = changes()[0];
    expect(one).toMatchObject({
      userId: person.userId,
      owner: s.owner,
      subAccount: null,
      asset: 'USDC',
      source: 'deposit',
      sourceId: first,
    });
    expect(sameDecimal(one.change, '25'), `change ${one.change}`).toBe(true);
    expect(sameDecimal(one.total, afterFirst.total), `the event's total ${one.total} is the venue's ${afterFirst.total}`).toBe(true);
    expect(one.changeId).toContain(first);

    // ── The same change delivered again on the bus, the same id: ignored ────────────────────────────────────────────
    const again = redeliverBalanceChange(person.userId);
    expect(again.changeId).toBe(one.changeId);

    // ── A second change: the next event is that change, never the repeat, with the venue's new total ───────────────
    const second = depositRef();
    expect(await testDeposit(s.owner, 'USDC', '5', second)).toBe(true);
    await expect
      .poll(() => changes().length, { timeout: 30_000, message: 'the second deposit arrives on the stream' })
      .toBeGreaterThanOrEqual(2);
    const afterSecond = await venueBalance(s.owner, 'USDC');
    expect(changes().map((c) => c.sourceId)).toEqual([first, second]);
    expect(new Set(changes().map((c) => c.changeId)).size).toBe(2);
    const two = changes()[1];
    expect(two).toMatchObject({ source: 'deposit', asset: 'USDC' });
    expect(sameDecimal(two.change, '5')).toBe(true);
    expect(sameDecimal(two.total, afterSecond.total), `the event's total ${two.total} is the venue's ${afterSecond.total}`).toBe(true);

    // ── What the person sees of it: their desk's venue balance reads the stream's last total ─────────────────────────
    await openVenueDesk(page, s.who, '/trade/futures', s.walletKey);
    await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).total, two.total), { timeout: 15_000 }).toBe(true);
    await stepPicture();
  } finally {
    stream.close();
  }
});

// ── #7: the per-user budget and a blank per-key budget ───────────────────────────────────────────────────────────────
// The route the bot reads (a read on the trade door); its cost comes from the edge's published cost table.
const BALANCE = '/api/v1/account/balance';
// Restarting identity with this LOCAL TEST switch leaves its TEST tiers blank (tooling/profiles/test-owner-values).
const TIERS_SWITCH = 'LOCAL_STACK_IDENTITY_RATE_LIMITS';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The published limits, read where a developer reads them: identity's tiers and the edge's cost for `BALANCE`. */
async function publishedLimits() {
  const tiers = await (await fetch(`${EDGE}/api/identity/trpc/apiRateTiers`, { headers: { origin: ORIGIN } })).json();
  const costs = await (await fetch(`${EDGE}/api/edge/rate-limits/costs`, { headers: { origin: ORIGIN } })).json();
  const tier = (id) => tiers.result.data.tiers.find((t) => t.id === id);
  const cost = costs.costs.find((row) => row.route === `GET ${BALANCE}`)?.cost;
  return { base: tier('base'), user: tier('user'), cost };
}

test(`${J} #7 goes over the per-user budget: edge.rate_limited with the reset time; a blank per-key budget refuses and no key is issued`, async ({
  browser,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  // A developer of their own, with two live Trade keys: the per-user budget is what both spend together.
  const { page } = await keyHolder(browser, 'cs15r');
  try {
    const first = await makeKey(page, { name: 'bot-a' });
    const second = await makeKey(page, { name: 'bot-b' });
    const { base, user, cost } = await publishedLimits();
    expect(base, 'the base tier is published').toBeTruthy();
    expect(user, 'the per-user budget is published').toBeTruthy();
    expect(cost).toBeGreaterThan(0);

    // The published limits page lists the per-user budget with its own numbers.
    await page.goto('/developers/rate-limits');
    const row = bodyRows(tableIn(page, 'Rate-limit tiers')).filter({ hasText: /^Per user/ });
    await expect(row).toHaveCount(1);
    // The table prints each figure as identity publishes it (digits, no grouping).
    await expect(row.getByRole('cell').nth(0)).toHaveText(String(user.burst));
    await expect(row.getByRole('cell').nth(1)).toHaveText(String(user.refillPerMinute));

    // Each key sends fewer calls than its own burst, together a third more than the per-user budget, all at once. Each
    // key's own bucket holds every call it sends, so whatever is refused is refused by the per-user budget alone.
    const perKey = Math.floor((user.burst / cost) * (2 / 3));
    expect(perKey * cost, `each key's ${perKey} calls fit its own burst of ${base.burst}`).toBeLessThanOrEqual(base.burst);
    expect(2 * perKey * cost, 'together they are past the per-user budget').toBeGreaterThan(user.burst);
    // A fresh account: its keys and its per-user budget have spent nothing on the trade door, so every bucket is full.
    const started = Date.now();
    const replies = await Promise.all(
      [first, second].flatMap((key) => Array.from({ length: perKey }, () => withKey(key, { path: BALANCE }))),
    );
    const elapsedMs = Date.now() - started;
    const allowed = replies.filter((r) => r.status !== 429);
    const refused = replies.filter((r) => r.status === 429);
    for (const r of allowed) expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Allowed up to the per-user budget (plus only what refilled while the calls were in flight), then refused.
    expect(allowed.length).toBeGreaterThanOrEqual(Math.floor(user.burst / cost));
    expect(allowed.length).toBeLessThanOrEqual(Math.floor((user.burst + (user.refillPerMinute / 60_000) * elapsedMs) / cost));
    expect(refused.length).toBeGreaterThan(0);
    for (const limited of refused) {
      expect(codeOf(limited.body), JSON.stringify(limited.body)).toBe('edge.rate_limited');
      // The reason: the per-user budget is spent, not the key's own bucket.
      expect(limited.body.reason).toBe('user');
      // The reset time: whole seconds until the budget holds one call's cost again, in the body and the header.
      expect(Number.isInteger(limited.body.retryAfterSeconds), JSON.stringify(limited.body)).toBe(true);
      expect(limited.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(limited.body.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(cost / (user.refillPerMinute / 60)));
      expect(limited.headers.get('retry-after')).toBe(String(limited.body.retryAfterSeconds));
      expect(limited.headers.get('x-ratelimit-reason')).toBe('user');
      expect(limited.body.requestId).toMatch(UUID);
    }
    // Once that time has passed, the refused key's next call goes through: its first try comes after the longest wait named.
    const waitMs = Math.max(...refused.map((r) => r.body.retryAfterSeconds)) * 1000;
    await expect
      .poll(async () => (await withKey(second, { path: BALANCE })).status, { intervals: [waitMs + 250, 1_000], timeout: waitMs + 5_000 })
      .toBe(200);

    // ── A blank per-key budget: identity with its TEST tiers blank refuses the key, and no key is issued ─────────────
    await page.goto('/uc/safe/api-keys');
    const keyRows = page.getByTestId('api-keys__table').locator('tbody tr');
    await expect(keyRows).toHaveCount(2);
    await restartService('identity', { [TIERS_SWITCH]: 'off' });
    try {
      await page.goto('/uc/safe/api-keys/new');
      await page.getByLabel('Key name', { exact: true }).fill('bot-c');
      await page.getByLabel('Trade', { exact: true }).check();
      await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(
        'No rate budget is set for API keys yet, so a key could make no call. No key was issued.',
      );
      await expect(page.getByRole('heading', { name: 'Your new key', exact: true })).toHaveCount(0);
      await stepPicture(page);
      // No key was issued: the account still holds its two.
      await page.goto('/uc/safe/api-keys');
      await expect(keyRows).toHaveCount(2);
      await expect(page.getByTestId('api-keys__table').getByRole('link', { name: 'bot-c', exact: true })).toHaveCount(0);
    } finally {
      await restartService('identity', { [TIERS_SWITCH]: null });
    }
  } finally {
    await page.context().close();
  }
});

// ── #10: historical tick, book and trade data downloads with checksum ──────────────────────────────────────────────────
const HISTORY_BOOK_SWITCH = 'LOCAL_STACK_TRADE_HISTORY_BOOK_INTERVAL';
const HISTORY_MARKET = 'BTC/USDT';

test(`${J} #10 downloads historical tick, book and trade data: a file for a published window with its checksum`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();

  // ── Documented schemas for trades, candles and book snapshots ───────────────────────────────────────────────────────
  const schemasRes = await page.request.get('/api/v1/history/schemas');
  expect(schemasRes.status(), await schemasRes.text()).toBe(200);
  const schemasBody = await schemasRes.json();
  expect(schemasBody.provenance).toBe("this venue's own matching sequence");
  expect(schemasBody.schemas.map((entry) => entry.kind)).toEqual(['trades', 'candles', 'book_snapshots']);
  for (const entry of schemasBody.schemas) {
    expect(entry).toMatchObject({ format: 'ndjson', compression: 'gzip', checksumAlgorithm: 'sha256' });
    expect(entry.fields.some((f) => /user|account|orderId/i.test(f.name))).toBe(false);
  }

  // ── Published manifests: wait for trades, candles and book_snapshots on BTC/USDT from the book world ────────────────
  let published = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/v1/history/datasets?symbol=${encodeURIComponent(HISTORY_MARKET)}`);
        if (res.status() !== 200) return [];
        const body = await res.json();
        published = body;
        return [...new Set(body.datasets.map((d) => d.kind))].sort();
      },
      { timeout: 60_000, intervals: [1_000, 2_000], message: 'trades, candles and book_snapshots datasets materialize' },
    )
    .toEqual(['book_snapshots', 'candles', 'trades']);

  expect(published.bookSnapshotsStatus).toBe('configured');
  expect(published.bookIntervalMs).toBeGreaterThan(0);

  // The bot's API key reads the exact same dataset list through the edge's metered trade door.
  const viaKey = await withKey(s.key, { path: `/api/v1/history/datasets?symbol=${encodeURIComponent(HISTORY_MARKET)}` });
  expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(200);
  expect(viaKey.body.datasets.map((d) => d.id)).toEqual(published.datasets.map((d) => d.id));

  // ── Download each kind through edge and verify SHA-256 checksum + gunzipped NDJSON contents ─────────────────────────
  const byKind = Object.fromEntries(
    ['trades', 'candles', 'book_snapshots'].map((kind) => [kind, published.datasets.find((d) => d.kind === kind)]),
  );
  for (const kind of ['trades', 'candles', 'book_snapshots']) {
    const manifest = byKind[kind];
    expect(manifest, `${kind} manifest exists`).toBeTruthy();
    expect(manifest.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.windowStart).toBe(`${manifest.day}T00:00:00.000Z`);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.rowCount).toBeGreaterThan(0);
    expect(manifest.provenance).toBe("this venue's own matching sequence");

    const dl = await page.request.get(manifest.downloadPath);
    expect(dl.status(), `download ${kind}`).toBe(200);
    expect(dl.headers()['content-type']).toContain('application/gzip');
    expect(dl.headers()['x-content-sha256']).toBe(manifest.sha256);
    expect(dl.headers()['content-disposition']).toContain('.ndjson.gz');

    const bytes = await dl.body();
    expect(bytes.byteLength).toBe(manifest.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex'), `${kind} SHA-256 matches manifest`).toBe(manifest.sha256);

    const rows = gunzipSync(bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(manifest.rowCount);
    for (const row of rows) {
      expect(row.symbol).toBe(HISTORY_MARKET);
      expect(row.schemaVersion).toBe(manifest.schemaVersion);
      expect(row).not.toHaveProperty('userId');
      expect(row).not.toHaveProperty('orderId');
      expect(row).not.toHaveProperty('accountId');
    }
    if (kind === 'trades') {
      expect(rows[0].id).toBe(String(rows[0].sequence));
      expect(['buy', 'sell']).toContain(rows[0].side);
      expect(typeof rows[0].price).toBe('string');
      expect(typeof rows[0].qty).toBe('string');
    } else if (kind === 'book_snapshots') {
      expect(Array.isArray(rows[0].bids)).toBe(true);
      expect(Array.isArray(rows[0].asks)).toBe(true);
    }
  }

  // ── Unknown dataset id refuses with 404 trade.history_dataset_not_found ─────────────────────────────────────────────
  const missing = await page.request.get('/api/v1/history/datasets/99999999-9999-4999-8999-999999999999/download');
  expect(missing.status()).toBe(404);
  expect((await missing.json()).intafacedCode).toBe('trade.history_dataset_not_found');

  // ── Blank book interval refuses trade.history_book_interval_unset ───────────────────────────────────────────────────
  await restartService('trade', { [HISTORY_BOOK_SWITCH]: 'off' });
  try {
    const refusedBook = await page.request.get('/api/v1/history/datasets?kind=book_snapshots');
    expect(refusedBook.status(), await refusedBook.text()).toBe(400);
    expect((await refusedBook.json()).intafacedCode).toBe('trade.history_book_interval_unset');
    const unfiltered = await page.request.get(`/api/v1/history/datasets?symbol=${encodeURIComponent(HISTORY_MARKET)}`);
    expect(unfiltered.status()).toBe(200);
    expect(await unfiltered.json()).toMatchObject({
      bookSnapshotsStatus: 'unset',
      bookSnapshotsCode: 'trade.history_book_interval_unset',
    });
  } finally {
    await restartService('trade', { [HISTORY_BOOK_SWITCH]: null });
  }

  // ── Customer Data downloads room under Markets shows the published windows, checksums and download links ────────────
  // Sign in so All services (/more) is available, then click Data downloads as a trader does rather than deep-linking.
  await signIn(page, s.who);
  await page.goto('/more');
  await page.getByRole('main').getByRole('link', { name: 'Data downloads', exact: true }).click();
  await expect(page).toHaveURL(/\/trade\/markets\/downloads$/);
  await expect(page.getByRole('heading', { name: 'Data downloads', level: 1, exact: true })).toBeVisible();
  const table = page.getByTestId('history-datasets-table');
  await expect(table).toBeVisible();
  for (const kind of ['trades', 'candles']) {
    const manifest = byKind[kind];
    const row = table.locator(`tbody tr[data-dataset-id="${manifest.id}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-sha256', manifest.sha256);
    await expect(row.getByTestId(`checksum-${manifest.id}`)).toHaveText(manifest.sha256);
    await expect(row.getByTestId(`download-${manifest.id}`)).toHaveAttribute('href', manifest.downloadPath);
  }
  const bookManifest = byKind.book_snapshots;
  const bookRow = table.locator(`tbody tr[data-dataset-id="${bookManifest.id}"]`);
  await expect(bookRow).toHaveCount(1);
  await expect(bookRow).toHaveAttribute('data-sha256', /^[0-9a-f]{64}$/);
  const shownBookSha = await bookRow.getAttribute('data-sha256');
  await expect(bookRow.getByTestId(`checksum-${bookManifest.id}`)).toHaveText(shownBookSha ?? '');
  await expect(bookRow.getByTestId(`download-${bookManifest.id}`)).toHaveAttribute('href', bookManifest.downloadPath);
  await stepPicture();
});
