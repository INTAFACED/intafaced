// World: book, restart
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, journeyState, tool, toUnits } from './stack.mjs';
import { reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-campaigns-09, in the running app (docs/roadmap/journeys.json): pay lower fees with a coupon. One test per step, titled
// "J-campaigns-09 #<n>", run in order, on the stack's TEST venue simulator (the door is on for this file only). The TEST
// setup (beforeAll, not a step) makes the journey's start: a verified account, its TEST wallet with TEST USDC and TEST BTC
// in its venue account, a rank discount (TEST XP through svc-identity's one award door: rank 1 takes 25 bps of our
// builder fee off), and a fee-saver coupon campaign made by the stack's two LOCAL TEST founders (A creates and asks, B
// approves, A activates) whose code takes half of our builder fee off two venue orders. Our builder fee on the stack is
// the labelled TEST 0.5 bp (tooling/profiles/test-owner-values/trade.json). Each order here is a spot sell, which carries
// our builder fee (a spot buy carries none). #4 is "Later (OWNER 226)"; #5 and #6 (the rebate coupon) are not built yet.
const J = 'J-campaigns-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
const DAY = 86_400_000;
/** The TEST builder fee in force, and what each discount leaves of it (floored to the venue's tenth of a basis point). */
const RATE = { full: '0.5', coupon: '0.2', rank: '0.4' };
/**
 * A TEST market sell into the TEST bids (the TEST ladder's bids start at 59990), at the worst price the desk sets from the
 * stack's TEST price protection, and a TEST limit sell resting inside the spread, below the TEST asks (from 60010), so a
 * buyer's sweep up to its price fills it.
 */
const SELL = { amount: '0.001' };
const REST = { amount: '0.001', price: '60005' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state(...keys) {
  const s = run.read();
  for (const k of ['account', 'walletKey', 'code', ...keys])
    if (!s[k]) throw new Error(`${J}: the TEST setup or an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

let gates;
let ctx;
let pair;
async function operators() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair };
}
const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** A TEST fee-saver campaign live now: half of our builder fee off two venue orders per coupon. No pot, no reward. */
async function liveFeeSaverCampaign() {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name: `TEST fee saver ${tag}`,
    type: 'voucher',
    rules: 'TEST rules: claim the coupon by its code; it takes half of our builder fee off your next two venue orders.',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    vouchers: {
      claimBy: new Date(Date.now() + 7 * DAY).toISOString(),
      useBy: new Date(Date.now() + 7 * DAY).toISOString(),
      feeSaver: { discountBps: 5000, orders: 2 },
    },
  };
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition, a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

/** TEST XP through svc-identity's one award door (`rank.awardXp`, service-signed), as the modules that earn XP call it. */
async function awardXp(userId, xpDelta) {
  const { ctx } = await operators();
  const raw = JSON.stringify({
    userId,
    sourceModule: 'local-test-stack',
    action: 'test.xp_elsewhere',
    xpDelta,
    idempotencyKey: `${J}:xp:${userId}`,
  });
  const res = await fetch(`${ctx.url('identity')}/trpc/rank.awardXp`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(200);
}

/** The person's vouchers, as svc-campaigns answers them. */
async function walletOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/vouchers.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`vouchers.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.vouchers;
}
const couponOf = async (who, code) => (await walletOf(who)).find((v) => v.code === code);

async function openVouchers(page) {
  await page.goto('/campaigns/mine');
  const wallet = page.getByTestId('my-vouchers');
  await expect(wallet).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return wallet;
}

/** The venue desk, signed in with the TEST wallet connected; a page that already has the wallet opens the desk again. */
const wallets = new WeakMap();
const desk = async (page) => {
  const s = state();
  let wallet = wallets.get(page);
  if (!wallet) {
    wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
    wallets.set(page, wallet);
  } else {
    await page.goto(DESK);
    await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
    const address = page.getByTestId('venue-wallet-address');
    const connect = page.getByRole('button', { name: 'Connect TEST Wallet' });
    await expect(connect.or(address)).toBeVisible();
    if (await connect.isVisible()) await connect.click();
    await expect(address).toHaveText(wallet.address);
  }
  return { ...s, wallet, owner: wallet.address };
};
const line = (sheet, name) => sheet.locator(`[data-line="${name}"]`);

/**
 * The desk's sell form filled and Sell pressed, once the venue's own preview of it has answered; returns the review dialog
 * and the price the order carries (a market order's worst price is the desk's, from the stack's TEST price protection).
 */
async function reviewSell(page, { type, price, amount }) {
  await page
    .getByTestId('dk-order')
    .locator('[role=tab]', { hasText: type === 'limit' ? /^Limit$/ : /^Market$/ })
    .click();
  const form = page.locator('[data-testid="dk-form"][data-side="sell"]');
  if (type === 'limit') await form.getByRole('textbox', { name: 'Price' }).fill(price);
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
  expect((await answer).status()).toBe(200);
  await form.locator('button[type=submit]').click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  const at = type === 'limit' ? price : (await line(sheet, 'worst').innerText()).replace(/,/g, '').trim();
  return { sheet, price: at };
}

/** What the venue itself previews for this sell at our builder fee `feeBps`: the figure the sheet must show. */
async function venuePreviewAt(owner, { type, price, amount }, clientOrderKey, feeBps) {
  return (
    await venueRecord(owner, '/preview', {
      intent: {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'sell',
        type,
        amount,
        price,
        timeInForce: type === 'limit' ? 'GTC' : 'IOC',
        reduceOnly: false,
        clientOrderKey,
        builderFee: { builder: '0x7e57000000000000000000000000000000000b1d', feeBps },
      },
    })
  ).value;
}

/** Confirm the review (it closes) and sign in the wallet; returns the order's outcome line under the form. */
async function confirmAndSign(page, sheet) {
  await expect(sheet.getByRole('button', { name: 'Confirm sell' })).toBeEnabled({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Confirm sell' }).click();
  await continueInWallet(page);
  const outcome = page.locator('[data-testid="dk-form"][data-side="sell"]').getByTestId('venue-outcome');
  await expect(outcome).not.toHaveText('', { timeout: 15_000 });
  return outcome;
}

/** The venue's own client order id for one of our order keys (venue-contracts `venueClientOrderId`, as built for the stack). */
async function cloidOf(key) {
  const { venueClientOrderId } = await import(path.join(ROOT, 'packages/venue-contracts/dist/user-venue.js'));
  return venueClientOrderId((await venueInfo()).id, key);
}

/** The venue's fills of the order our key `clientKey` names. */
const fillsOf = async (owner, clientKey) => {
  const cloid = await cloidOf(clientKey);
  return (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 3_600_000).toISOString() })).value.filter(
    (f) => f.venueClientOrderId === cloid,
  );
};

/** The venue's builder fee on a fill at `rateBps` of its quote notional, rounded up as the venue rounds (to 18 places). */
function builderFeeAt(fill, rateBps) {
  const S = 10n ** 18n;
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const notional = ceilDiv(toUnits(fill.price) * toUnits(fill.amount), S);
  return ceilDiv(ceilDiv(notional * toUnits(rateBps), S) * S, toUnits('10000'));
}

/** Each fill carries our builder fee at `rateBps` exactly as the venue charged it, and its venue fee as the venue reports it. */
async function chargedAt(page, owner, clientId, rateBps) {
  const fills = await fillsOf(owner, clientId);
  expect(fills.length, `the venue filled ${clientId}`).toBeGreaterThan(0);
  await page.getByTestId('venue-bottom').getByRole('tab', { name: 'Trade history' }).click();
  for (const f of fills) {
    const expected = builderFeeAt(f, rateBps);
    const charged = toUnits(f.builderFee);
    expect(charged >= expected - 2n && charged <= expected + 2n, `${f.fillId} builder fee ${f.builderFee} at ${rateBps} bps`).toBe(true);
    expect(toUnits(f.venueFee) > 0n, 'the venue charges its own fee').toBe(true);
    const row = page.getByTestId('venue-fills').locator(`tr[data-fill="${f.fillId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('[data-cell="venue-fee"]')).toHaveText(f.venueFee);
    await expect(row.locator('[data-cell="builder-fee"]')).toHaveText(f.builderFee);
  }
  return fills;
}

let staffDoor;
async function ledgerRead(path) {
  staffDoor ??= (async () => {
    const { ctx, pair } = await operators();
    return { ctx, token: await pair.a.treasuryToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** Our builder fee on each fill is posted once, under the fill's own key, at exactly what the venue charged. */
async function postedOnce(owner, fills) {
  const { id: venueId } = await venueInfo();
  for (const f of fills) {
    const businessKey = `builder-fee:${venueId}:${owner.toLowerCase()}:${f.fillId}`;
    const trace = () => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(businessKey)}`);
    await expect.poll(async () => (await trace()).found, { timeout: 30_000, message: `${businessKey} posted` }).toBe(true);
    const tx = await trace();
    expect(tx).toMatchObject({ businessKey, module: 'trade', reason: 'trade.builder_fee.earned' });
    expect(tx.postings).toHaveLength(2);
    for (const p of tx.postings) expect(sameDecimal(p.amount, f.builderFee)).toBe(true);
  }
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jc09');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(await testDeposit(owner, 'BTC', '0.01', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);
    const me = await api(account);
    const { status, body } = await me.get('/api/identity/trpc/rank.get');
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    await awardXp(body.result.data.userId, 500);
    const perks = await me.get('/api/identity/trpc/rank.perks');
    expect(perks.body.result.data.feeDiscountBps, 'rank 1 takes 25 bps of our builder fee off').toBe(25);
    const campaign = await liveFeeSaverCampaign();
    const code = `JC09-${tag}`;
    const { ctx, pair } = await operators();
    data(
      await ctx.edge.mutate(
        'campaigns',
        'ops.campaigns.vouchers.issue',
        { campaignId: campaign.id, code },
        await pair.a.campaignsOpsToken(),
      ),
      'vouchers.issue',
    );
    run.reset({ account, walletKey, owner, code });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens /campaigns/mine: the coupon, its kind and what it will do`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account, code } = state();
  const { signIn } = await import('./desk.mjs');
  await signIn(page, account);
  await openVouchers(page);
  const form = page.getByRole('form', { name: 'Voucher code' });
  await form.getByRole('textbox', { name: 'Code' }).fill(code);
  await form.getByRole('button', { name: 'Check this code' }).click();
  await expect(page.getByTestId('voucher-validation')).toContainText('a fee-saver coupon');
  await expect(page.getByTestId('voucher-validation')).toContainText('50% off our builder fee on 2 venue orders');
  await form.getByRole('button', { name: 'Claim this voucher' }).click();
  const coupon = await couponOf(account, code);
  expect(coupon).toMatchObject({
    kind: 'fee_saver',
    state: 'claimed',
    remaining: '2',
    feeSaver: { discountBps: 5000, orders: 2, uses: [] },
  });
  const row = page.locator(`[data-testid="my-voucher"][data-voucher-id="${coupon.id}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId('voucher-kind')).toHaveText('Fee-saver coupon:');
  await expect(row.getByTestId('voucher-kind')).toHaveAttribute('data-kind', 'fee_saver');
  await expect(row.getByTestId('voucher-does')).toHaveText(
    'takes 50% off our builder fee on your next 2 venue orders, applied automatically when it beats your rank discount; never off the venue’s own fee.',
  );
  await expect(row.getByTestId('voucher-remaining')).toHaveText('2 of 2 orders left.');
  await expect(row.getByTestId('voucher-state')).toHaveText('Claimed');
  // A fee-saver is never redeemed for cash: no amount or Redeem control on its row.
  await expect(row.getByRole('button', { name: 'Redeem' })).toHaveCount(0);
  run.write({ ...run.read(), couponId: coupon.id });
});

test(`${J} #2 places and fills an order with the coupon and a rank discount: the venue's fee as the venue reports it, and our builder fee once at the winning rate; the coupon is consumed once; if the campaigns service is down the order carries the normal builder fee`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { account, code } = state('couponId');
  const { owner } = await desk(page);

  // The coupon (half off) beats the rank (25 bps of the fee off): the sheet names it, and our builder fee is the venue's own
  // preview of this order at the coupon's rate, not at the rate in force.
  const { sheet, price: worst } = await reviewSell(page, { type: 'market', amount: SELL.amount });
  const clientId = (await line(sheet, 'client-id').innerText()).trim();
  await expect(line(sheet, 'builder-fee-discount')).toHaveText(`Coupon ${code}: 50% off our builder fee, never the venue’s`);
  await expect(line(sheet, 'builder-fee-discount')).toHaveAttribute('data-source', 'coupon');
  const at = (p) => `${p.builderFee.value.amount} ${p.builderFee.value.asset}`;
  const coupon = await venuePreviewAt(owner, { type: 'market', price: worst, amount: SELL.amount }, clientId, RATE.coupon);
  const full = await venuePreviewAt(owner, { type: 'market', price: worst, amount: SELL.amount }, clientId, RATE.full);
  expect(toUnits(coupon.builderFee.value.amount)).toBeLessThan(toUnits(full.builderFee.value.amount));
  await expect(line(sheet, 'builder-fee')).toContainText(at(coupon));
  // The venue's fee is the venue's, unchanged by any discount of ours.
  await expect(line(sheet, 'venue-fee')).toHaveText(`${full.venueFee.value.amount} ${full.venueFee.value.asset}`);
  // The review takes nothing.
  expect((await couponOf(account, code)).remaining).toBe('2');

  // Our builder fee is approved once, at the rate in force (a discounted order asks for less), then the order is signed.
  await expect(line(sheet, 'builder-fee')).toContainText(`Not signed: your wallet signs an approval of up to ${RATE.full} bps`);
  await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' }).click();
  await continueInWallet(page);
  await expect(line(sheet, 'builder-fee')).not.toContainText('Not signed', { timeout: 20_000 });
  await expect(line(sheet, 'builder-fee')).toHaveText(at(coupon));
  await expect(await confirmAndSign(page, sheet)).toContainText('Filled on the venue.');
  const fills = await chargedAt(page, owner, clientId, RATE.coupon);
  await postedOnce(owner, fills);

  // The coupon is consumed once, by this order's own key.
  const used = await couponOf(account, code);
  expect(used).toMatchObject({ state: 'partially_used', used: '1', remaining: '1' });
  expect(used.feeSaver.uses.map((u) => u.orderKey)).toEqual([clientId]);
  await openVouchers(page);
  const row = page.locator(`[data-testid="my-voucher"][data-voucher-id="${used.id}"]`);
  await expect(row.getByTestId('voucher-remaining')).toHaveText('1 of 2 orders left.');
  await expect(row.getByTestId('voucher-uses').locator(`li[data-order-key="${clientId}"]`)).toHaveCount(1);

  // svc-campaigns down: the order carries the normal builder fee, the TEST 0.5 bp in force with no discount at all (the
  // winning rate cannot be known without the coupon), no discount line, and it takes nothing from the coupon.
  let downClientId;
  try {
    tool('local-test-stack.mjs', 'stop', 'campaigns');
    await desk(page);
    const { sheet: down, price: downWorst } = await reviewSell(page, { type: 'market', amount: SELL.amount });
    downClientId = (await line(down, 'client-id').innerText()).trim();
    await expect(line(down, 'builder-fee-discount')).toHaveCount(0);
    const normal = await venuePreviewAt(owner, { type: 'market', price: downWorst, amount: SELL.amount }, downClientId, RATE.full);
    await expect(line(down, 'builder-fee')).toHaveText(at(normal));
    await expect(await confirmAndSign(page, down)).toContainText('Filled on the venue.');
    await postedOnce(owner, await chargedAt(page, owner, downClientId, RATE.full));
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'campaigns');
  }
  await expect.poll(async () => (await couponOf(account, code))?.remaining, { timeout: 60_000 }).toBe('1');
  expect((await couponOf(account, code)).feeSaver.uses.map((u) => u.orderKey)).toEqual([clientId]);
  run.write({ ...run.read(), couponOrder: clientId, downClientId });
});

test(`${J} #3 the coupon runs out during an order: that order keeps the builder fee it was placed with; the next order carries the rank rate`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { account, code, couponOrder } = state('couponId', 'couponOrder');
  const { owner } = await desk(page);

  // A TEST limit sell resting above the book takes the coupon's last order.
  const { sheet } = await reviewSell(page, { type: 'limit', price: REST.price, amount: REST.amount });
  const restingId = (await line(sheet, 'client-id').innerText()).trim();
  await expect(line(sheet, 'builder-fee-discount')).toHaveAttribute('data-source', 'coupon');
  await expect(await confirmAndSign(page, sheet)).toContainText('Open on the venue.');
  const spent = await couponOf(account, code);
  expect(spent).toMatchObject({ state: 'used', remaining: '0' });
  expect(spent.feeSaver.uses.map((u) => u.orderKey)).toEqual([couponOrder, restingId]);

  // The next order: no coupon left, so it carries the rank's rate.
  const { sheet: next, price: nextWorst } = await reviewSell(page, { type: 'market', amount: SELL.amount });
  const nextId = (await line(next, 'client-id').innerText()).trim();
  await expect(line(next, 'builder-fee-discount')).toHaveText('Your rank: 0.25% off our builder fee, never the venue’s');
  const rank = await venuePreviewAt(owner, { type: 'market', price: nextWorst, amount: SELL.amount }, nextId, RATE.rank);
  await expect(line(next, 'builder-fee')).toHaveText(`${rank.builderFee.value.amount} ${rank.builderFee.value.asset}`);
  await expect(await confirmAndSign(page, next)).toContainText('Filled on the venue.');
  await postedOnce(owner, await chargedAt(page, owner, nextId, RATE.rank));

  // The resting order fills after its coupon ran out (another TEST trader sweeps the asks up to its price): at the rate it
  // was placed with.
  const buyer = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(buyer).address),
    asset: 'USDC',
    amount: '100000',
    depositRef: `seed:${buyer}:USDC`,
  });
  const bought = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: '1',
    price: REST.price,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:fill`,
    builderFee: null,
  });
  expect(bought.definite && bought.accepted, JSON.stringify(bought)).toBe(true);
  const order = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: await cloidOf(restingId) })).value;
  expect(order.status).toBe('filled');
  await desk(page);
  const fills = await chargedAt(page, owner, restingId, RATE.coupon);
  await postedOnce(owner, fills);
  // Nothing more was taken from the coupon by the fill, and the total discount stayed within its two orders.
  expect((await couponOf(account, code)).feeSaver.uses).toHaveLength(2);
  expect(fromUnits(fills.reduce((t, f) => t + toUnits(f.amount), 0n))).toBe(REST.amount);
});
