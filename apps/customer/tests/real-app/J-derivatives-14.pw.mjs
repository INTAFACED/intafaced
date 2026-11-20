// World: book, restart
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, venueForThisFile, venueRecord } from './venue.mjs';
import { venueAt, venueNow } from './venue-door.mjs';

// J-derivatives-14, "I build against the derivatives API and FIX" (docs/roadmap/journeys.json): a developer's program
// that holds only a scoped API key and an agent key reads the derivatives market data and places orders through our API
// on the person's own venue account. One test per step, titled "J-derivatives-14 #<n>", run in order.
//
// The Starts line is made once, as TEST setup: a verified TEST account with a live Trade key made in the browser, its
// TEST wallet with TEST USDC on its own venue account, and one agent permission the wallet signed for the program's
// agent key (`approve_agent`, through the person's signed-in session: an API key can never approve an agent). From then
// on every call goes to Edge with the key, and every order is signed by the agent key. The market is XDEV-PERP, the TEST
// perpetual only this journey trades (packages/venue-sim/src/http-server.ts): no TEST makers' ladder rests on it, so
// every position on it is one this journey opened. The venue is the record of every figure; the ledger posts nothing.
// Every figure is TEST.
const J = 'J-derivatives-14';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const SYMBOL = 'XDEV-PERP';
const BASE = 'XDEV';
const EPOCH = '1970-01-01T00:00:00.000Z';

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.key || !s.walletKey || !s.agentKey)
    throw new Error(`${J}'s TEST setup made no key, wallet and agent permission, so there is no program`);
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();
  const agent = privateKeyToAccount(s.agentKey);
  return { ...s, owner, agent, agentAddress: agent.address.toLowerCase() };
}

/** One read through the API key that must answer 200: its body. */
async function read(s, path) {
  const res = await withKey(s.key, { path });
  expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body;
}

/** The prepared payload, signed by one key: the program's own signing, no SDK. */
async function signWith(account, prepared) {
  const t = prepared.typedData;
  const signature = await account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: account.address.toLowerCase() };
}

/** Prepare, sign with `signer` and submit one action through the API key, as the program sends it. */
async function send(s, intent, signer = s.agent) {
  const prepared = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/prepare',
    body: { owner: s.owner, signer: { role: 'agent', address: signer.address.toLowerCase() }, intent },
  });
  if (prepared.status !== 200) return { prepared, sent: null };
  const signature = await signWith(signer, prepared.body.prepared);
  const sent = await withKey(s.key, {
    method: 'POST',
    path: '/api/v1/venue/submit',
    body: { actionKey: prepared.body.actionKey, signature },
  });
  return { prepared, signature, sent };
}

const limitBuy = (clientOrderKey, amount, price) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side: 'buy',
  type: 'limit',
  amount,
  price,
  timeInForce: 'GTC',
  reduceOnly: false,
  builderFee: null,
  clientOrderKey,
});

/** A preview as an answer to compare: its status, and its body without the venue's as-of time. */
function comparable(res) {
  const { asOf: _asOf, ...rest } = res.body ?? {};
  return { status: res.status, body: rest };
}

/**
 * TEST setup, not a journey step (the journey's Starts): a verified passkey account, one live Trade key made through
 * /uc/safe/api-keys/new, this run's TEST wallet with TEST 1000 USDC on its own venue account (the TEST venue's deposit
 * control), and the agent permission: the wallet signs `approve_agent` for a fresh agent key the program holds.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().agentKey) return;
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'jd14');
  try {
    const key = await makeKey(page, { name: 'derivatives-bot' });
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
      intent: { kind: 'approve_agent', agentAddress, agentName: 'TEST derivatives bot', validUntil: null },
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

test(`${J} #3 reads funding, index, mark and price limits: history rows; unpublished index as null with its reason`, async () => {
  test.setTimeout(180_000);
  const s = state();
  const venue = await venueNow();
  const since = new Date(Date.now() - 1000).toISOString();
  // The TEST venue closes two funding periods on XDEV-PERP, one with its index above the mark, one level with it.
  await venueAt('/test/index-published', { symbol: SYMBOL, published: true });
  await venueAt('/test/set-index', { symbol: SYMBOL, price: '100.5' });
  await venueAt('/test/settle-funding', { symbol: SYMBOL });
  await venueAt('/test/set-index', { symbol: SYMBOL, price: '100' });
  await venueAt('/test/settle-funding', { symbol: SYMBOL });

  // ── Funding history: the venue's own settled periods, each with its rate, premium and rate a year ──────────────────
  const history = await read(s, `/api/v1/venue/funding-history?base=${BASE}&since=${encodeURIComponent(since)}`);
  const own = (await venueAt('/funding-history', { symbol: SYMBOL, since })).value;
  expect(history).toMatchObject({ symbol: SYMBOL, intervalSeconds: 3600, test: true });
  expect(history.value.length).toBeGreaterThanOrEqual(2);
  expect(history.value.map((r) => [r.fundingAt, r.rate, r.premium])).toEqual(own.map((r) => [r.fundingAt, r.rate, r.premium]));
  for (const r of history.value) expect(r.annualisedRate).not.toBeNull();

  // ── Mark and index history: the venue's own series, the index showing both prices it was set to ──────────────────
  for (const kind of ['mark', 'index']) {
    const series = await read(s, `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=${kind}&since=${encodeURIComponent(EPOCH)}`);
    const venueOwn = (await venueAt('/price-history', { symbol: SYMBOL, kind, since: EPOCH })).value;
    expect(venueOwn.known).toBe(true);
    expect(series).toMatchObject({ symbol: SYMBOL, kind, reason: null, test: true });
    expect(series.series).toEqual(venueOwn.value);
    expect(series.series.length).toBeGreaterThan(0);
  }
  const index = await read(s, `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=index&since=${encodeURIComponent(since)}`);
  expect(index.series.map((x) => x.price)).toEqual(expect.arrayContaining(['100.5', '100']));

  // ── Price limits: the venue's own band and order caps on the market, as it publishes them ──────────────────────────
  const markets = await read(s, '/api/v1/venue/markets');
  const listed = markets.value.find((m) => m.symbol === SYMBOL);
  const venueMarket = (await venueAt('/markets', {})).value.find((m) => m.symbol === SYMBOL);
  expect(listed).toMatchObject({ kind: 'perpetual', priceBandBps: '500', maxOrderQty: '1000', maxOrderNotional: '1000000' });
  expect([listed.priceBandBps, listed.maxOrderQty, listed.maxOrderNotional]).toEqual([
    venueMarket.priceBandBps,
    venueMarket.maxOrderQty,
    venueMarket.maxOrderNotional,
  ]);
  expect(listed.index).toEqual({ known: true, value: '100' });
  expect(listed.mark).toEqual(venueMarket.mark);

  // ── An index the venue does not publish: null, with the venue's reason, never a series of ours ──────────────────────
  await venueAt('/test/index-published', { symbol: SYMBOL, published: false });
  try {
    const none = await read(s, `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=index&since=${encodeURIComponent(EPOCH)}`);
    expect(none).toMatchObject({ symbol: SYMBOL, kind: 'index', series: null, reason: `${venue.name} publishes no index for ${SYMBOL}` });
    const unpublished = (await read(s, '/api/v1/venue/markets')).value.find((m) => m.symbol === SYMBOL);
    expect(unpublished.index).toEqual({ known: false });
  } finally {
    await venueAt('/test/index-published', { symbol: SYMBOL, published: true });
  }
});

test(`${J} #4 reads open interest, risk-limit tiers, insurance and ADL data: ratio from positions; ladder_unset while the ladder is unpublished`, async () => {
  test.setTimeout(180_000);
  const s = state();
  const venue = await venueNow();
  const name = (n) => `${J}-${RUN}-${test.info().retry}-${n}`;
  const before = await read(s, `/api/v1/venue/open-interest?symbol=${SYMBOL}`);
  expect(before).toMatchObject({ symbol: SYMBOL, reason: null, test: true });

  // Four other TEST traders, each with its own TEST venue account: one rests a sell of 3 and three each buy 1 from it,
  // so three accounts are long and one is short on XDEV-PERP (no TEST makers' ladder rests there).
  const traders = ['short', 'long-1', 'long-2', 'long-3'];
  for (const t of traders) {
    const owner = otherTraderKey(name(t)).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    await otherTraderRun(name(t), { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' });
  }
  const order = (side, amount, timeInForce, t) => ({
    kind: 'place_order',
    symbol: SYMBOL,
    side,
    type: 'limit',
    amount,
    price: '100',
    timeInForce,
    reduceOnly: false,
    builderFee: null,
    clientOrderKey: `jd14:${name(t)}`,
  });
  expect(await otherTraderRun(name('short'), order('sell', '3', 'GTC', 'short'))).toMatchObject({ definite: true, accepted: true });
  for (const t of ['long-1', 'long-2', 'long-3'])
    expect(await otherTraderRun(name(t), order('buy', '1', 'IOC', t))).toMatchObject({ definite: true, accepted: true });
  for (const t of traders) {
    const owner = otherTraderKey(name(t)).address.toLowerCase();
    const p = (await venueRecord(owner, '/positions')).value.find((x) => x.symbol === SYMBOL);
    expect(p, t).toMatchObject(t === 'short' ? { side: 'short', size: '3' } : { side: 'long', size: '1' });
  }

  // ── Open interest and the ratio, from the venue's own positions: three more long, one more short ────────────────────
  const after = await read(s, `/api/v1/venue/open-interest?symbol=${SYMBOL}`);
  const venueMarket = (await venueAt('/markets', {})).value.find((m) => m.symbol === SYMBOL);
  expect(after).toMatchObject({ symbol: SYMBOL, reason: null, test: true });
  expect(after.longAccounts).toBe(before.longAccounts + 3);
  expect(after.shortAccounts).toBe(before.shortAccounts + 1);
  expect(after.openInterest).toEqual({ size: venueMarket.openInterest.value.size, capSize: null });
  expect(Number(after.openInterest.size)).toBe(Number(before.openInterest.size) + 3);
  expect({ longAccounts: after.longAccounts, shortAccounts: after.shortAccounts }).toEqual(venueMarket.longShort.value);
  // The ratio is the venue's long accounts over its short accounts: 3 to 1 on a market this journey alone trades.
  expect(Number(after.longShortRatio)).toBeCloseTo(after.longAccounts / after.shortAccounts, 12);
  if (before.longAccounts === 0 && before.shortAccounts === 0) expect(after.longShortRatio).toBe('3');

  // ── Risk-limit tiers: XDEV-PERP's venue publishes no ladder, so the tiers read ladder_unset, never a ladder of ours ──
  const unset = await read(s, `/api/v1/venue/risk-limits?symbol=${SYMBOL}`);
  expect(unset).toMatchObject({ symbol: SYMBOL, tiers: null, reason: 'ladder_unset', test: true });
  expect(venueMarket.marginTiers).toEqual({ known: false });
  // A perpetual whose venue publishes its ladder (XRSK-PERP, J-derivatives-02): the venue's own tiers, lowest first.
  const ladder = await read(s, '/api/v1/venue/risk-limits?symbol=XRSK-PERP');
  const rsk = (await venueAt('/markets', {})).value.find((m) => m.symbol === 'XRSK-PERP');
  expect(rsk.marginTiers.known).toBe(true);
  expect(ladder).toMatchObject({ symbol: 'XRSK-PERP', reason: null });
  expect(ladder.tiers).toEqual(rsk.marginTiers.value);

  // ── Insurance and ADL data: the venue's own fund, its auto-deleveraging rules and its public alerts ─────────────────
  const fund = await read(s, '/api/v1/venue/insurance-fund');
  const venueFund = await venueAt('/insurance-fund', {});
  expect(fund).toMatchObject({ venueName: venue.name });
  expect(fund.value).toEqual(venueFund.value);
  const adl = await read(s, `/api/v1/venue/adl-disclosure`);
  expect(adl).toMatchObject({ venueName: venue.name });
  expect(adl.rules).toMatchObject({ version: expect.any(String), text: expect.any(String) });
  const alerts = await read(s, '/api/v1/venue/liquidation-alerts');
  expect(Array.isArray(alerts.value)).toBe(true);
  // A public alert names no account.
  for (const a of alerts.value) expect(Object.keys(a).sort()).toEqual(['alertedAt', 'kind', 'price', 'side', 'size', 'symbol']);
});

test(`${J} #7 places and previews orders through our API: the same preview and refusal codes as the desk, signed by the agent permission`, async () => {
  test.setTimeout(180_000);
  const s = state();
  const person = await api(s.who);
  const clientId = `jd14:${RUN}:${test.info().retry}:${Date.now().toString(36)}`;
  const preview = async (via, intent) =>
    via === 'key'
      ? withKey(s.key, { method: 'POST', path: '/api/v1/venue/preview', body: { owner: s.owner, intent } })
      : person.post('/api/v1/venue/preview', { owner: s.owner, intent });

  // ── Before any leverage is set: the key and the desk refuse with the same code ────────────────────────────────────
  const first = limitBuy(`${clientId}:a`, '1', '95');
  const leverage = (await venueRecord(s.owner, '/positions')).value;
  expect(leverage.filter((p) => p.symbol === SYMBOL)).toHaveLength(0);
  const noLeverageKey = await preview('key', first);
  const noLeverageDesk = await preview('desk', first);
  expect(noLeverageKey.status, JSON.stringify(noLeverageKey.body)).toBeGreaterThanOrEqual(400);
  expect(comparable(noLeverageKey)).toEqual(comparable(noLeverageDesk));

  // ── The program sets its leverage through our API, signed by the agent key ────────────────────────────────────────
  const set = await send(s, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' });
  expect(set.prepared.status, JSON.stringify(set.prepared.body)).toBe(200);
  expect(set.sent.status, JSON.stringify(set.sent.body)).toBe(200);
  expect(set.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(set.signature.signedBy).toBe(s.agentAddress);

  // ── Preview: the same answer through the key as on the desk ───────────────────────────────────────────────────────
  const viaKey = await preview('key', first);
  const viaDesk = await preview('desk', first);
  expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(200);
  expect(comparable(viaKey)).toEqual(comparable(viaDesk));

  // ── Refusals: an order above the venue's largest size refuses with the same code through the key as on the desk ──
  const tooBig = limitBuy(`${clientId}:big`, '2000', '95');
  const bigKey = await preview('key', tooBig);
  const bigDesk = await preview('desk', tooBig);
  expect(bigKey.status, JSON.stringify(bigKey.body)).toBeGreaterThanOrEqual(400);
  expect(bigKey.body.intafacedCode).toBeTruthy();
  expect(comparable(bigKey)).toEqual(comparable(bigDesk));
  const bigPrepared = await send(s, tooBig);
  expect(bigPrepared.sent).toBeNull();
  expect(bigPrepared.prepared.body.intafacedCode).toBe(bigKey.body.intafacedCode);

  // ── Place: one venue order signed by the agent key; it rests on the venue under the program's client id ─────────────
  const placed = await send(s, first);
  expect(placed.prepared.status, JSON.stringify(placed.prepared.body)).toBe(200);
  expect(placed.sent.status, JSON.stringify(placed.sent.body)).toBe(200);
  expect(placed.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(placed.signature.signedBy).toBe(s.agentAddress);
  const cloid = placed.prepared.body.prepared.venueClientOrderId;
  const resting = (await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.venueClientOrderId === cloid);
  expect(resting).toHaveLength(1);
  expect(resting[0]).toMatchObject({ status: 'open', symbol: SYMBOL, side: 'buy' });

  // ── The agent permission only: a key the wallet never approved is refused before anything is signed ────────────────
  const stranger = privateKeyToAccount(generatePrivateKey());
  const unapproved = await send(s, limitBuy(`${clientId}:stranger`, '1', '95'), stranger);
  expect(unapproved.prepared.status, JSON.stringify(unapproved.prepared.body)).toBe(422);
  expect(unapproved.prepared.body.intafacedCode).toBe('trade.venue.signer_not_authorised');
  expect(unapproved.sent).toBeNull();

  // ── Cancel through our API, signed by the agent key: nothing of the program's rests on the venue after ──────────────
  const cancelled = await send(s, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: first.clientOrderKey });
  expect(cancelled.sent.status, JSON.stringify(cancelled.sent.body)).toBe(200);
  expect(cancelled.sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  expect(cancelled.signature.signedBy).toBe(s.agentAddress);
  expect((await venueRecord(s.owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL)).toHaveLength(0);
});
