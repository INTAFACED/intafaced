// World: book, restart, stack
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, journeyState, restartService, tool, toUnits } from './stack.mjs';
import { reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { TEST_WALLET, installTestWallet, testWalletKey } from './test-wallet.mjs';
import { CHAIN_ID, TOKEN_USD, connectWhenAsked } from './dex.mjs';
import { chainReceipt, payFault, rewardFunds, usdTransfers } from './reward-funds.mjs';
import { ageRecord } from './test-age.mjs';
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
  venueBalance,
  venueRecord,
} from './venue.mjs';

// J-campaigns-09, in the running app (docs/roadmap/journeys.json): pay lower fees with a coupon. One test per step, titled
// "J-campaigns-09 #<n>", run in order, on the stack's TEST venue simulator (the door is on for this file only). The TEST
// setup (beforeAll, not a step) makes the journey's start: a verified account, its TEST wallet with TEST USDC and TEST BTC
// in its venue account, a rank discount (TEST XP through svc-identity's one award door: rank 1 takes 25 bps of our
// builder fee off), and a fee-saver coupon campaign made by the stack's two LOCAL TEST founders (A creates and asks, B
// approves, A activates) whose code takes half of our builder fee off two venue orders. Our builder fee on the stack is
// the labelled TEST 0.5 bp (tooling/profiles/test-owner-values/trade.json). Each order here is a spot sell, which carries
// our builder fee (a spot buy carries none). #4 waits for later (its fee voucher pools are not built). The setup also makes a fee rebate coupon campaign
// (the same two founders) whose code pays half of our builder fee back on each venue fill, up to TEST 0.002 USDC in all,
// to the connected wallet two hours after the fill, and funds INTAFACED's TEST reward pot and TEST rewards wallet from
// builder fees a TEST house account's own sells earned us (reward-funds.mjs). The two hours are aged through the TEST age
// door in #6; one payment's answer is lost after it was broadcast through the TEST pay-fault door.
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
/** The TEST rebate coupon: half of our builder fee back per fill, at most TEST 0.002 USDC in all, two hours after the fill. */
const REBATE = { rebateBps: 5000, delaySeconds: 7200, face: '0.002' };
const funds = rewardFunds({ J, RUN: process.env.JOURNEY_RUN_ID ?? tag, operators: () => operators() });

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

/** A TEST fee rebate campaign live now, paid from its own TEST budget: the coupon's face is the campaign's reward. */
async function liveFeeRebateCampaign() {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name: `TEST fee rebate ${tag}`,
    type: 'voucher',
    rules: 'TEST rules: claim the coupon by its code; half of our builder fee on each venue fill is paid back to your wallet.',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDC', limit: '1' },
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: { asset: 'USDC', amount: REBATE.face },
    vouchers: {
      claimBy: new Date(Date.now() + 7 * DAY).toISOString(),
      useBy: new Date(Date.now() + 7 * DAY).toISOString(),
      feeRebate: { rebateBps: REBATE.rebateBps, delaySeconds: REBATE.delaySeconds },
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
    await connectWhenAsked(page, address);
    await expect(address).toHaveText(wallet.address);
  }
  return { ...s, wallet, owner: wallet.address };
};
const line = (sheet, name) => sheet.locator(`[data-line="${name}"]`);

/**
 * The desk's sell form filled and Sell pressed, once the venue's own preview of it has answered; returns the review dialog
 * and the price the order carries (a market order's worst price is the desk's, from the stack's TEST price protection).
 */
async function reviewSell(page, order) {
  return reviewOrder(page, 'sell', order);
}
async function reviewOrder(page, side, { type, price, amount }) {
  await page
    .getByTestId('dk-order')
    .locator('[role=tab]', { hasText: type === 'limit' ? /^Limit$/ : /^Market$/ })
    .click();
  const form = page.locator(`[data-testid="dk-form"][data-side="${side}"]`);
  if (type === 'limit') await form.getByRole('textbox', { name: 'Price', exact: true }).fill(price);
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
        builderFee: { builder: '0x116d8f7751e72306d499dd61ae826e46a726c632', feeBps },
      },
    })
  ).value;
}

/** Confirm the review (it closes) and sign in the wallet; returns the order's outcome line under the form. */
async function confirmAndSign(page, sheet, side = 'sell') {
  const confirm = sheet.getByRole('button', { name: `Confirm ${side}`, exact: true });
  await expect(confirm).toBeEnabled({ timeout: 20_000 });
  await confirm.click();
  await continueInWallet(page);
  const outcome = page.locator(`[data-testid="dk-form"][data-side="${side}"]`).getByTestId('venue-outcome');
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
    const rebate = await liveFeeRebateCampaign();
    const rebateCode = `JC09R-${tag}`;
    data(
      await ctx.edge.mutate(
        'campaigns',
        'ops.campaigns.vouchers.issue',
        { campaignId: rebate.id, code: rebateCode },
        await pair.a.campaignsOpsToken(),
      ),
      'vouchers.issue',
    );
    // INTAFACED's TEST reward pot and TEST rewards wallet, from builder fees a TEST house account's own sells earned us.
    const house = await signUp(page, 'jc09h');
    await verify(page, house);
    const fees = await funds.earnBuilderFees(house, 2);
    await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
    await funds.claimOurBuilderFees();
    run.reset({ account, walletKey, owner, code, rebateCode });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens /campaigns/mine: the coupon, its kind and what it will do`, async ({ page }) => {
  test.setTimeout(180_000);
  const { account, owner, code } = state();
  // Claiming the coupon touches nothing at the venue: the venue account is as the venue itself records it before the claim.
  const held = await venueBalance(owner, 'USDC');
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
  // What it will do, as the venue itself prices it: the venue's own preview of a sell at the coupon's rate charges less of
  // our builder fee than at the rate in force, and exactly the same venue fee; the claim moved nothing in the venue account.
  const order = { type: 'limit', price: REST.price, amount: SELL.amount };
  const key = `order:${J}:${tag}:coupon-preview`;
  const atCoupon = await venuePreviewAt(owner, order, key, RATE.coupon);
  const atFull = await venuePreviewAt(owner, order, key, RATE.full);
  expect(toUnits(atCoupon.builderFee.value.amount)).toBeGreaterThan(0n);
  expect(toUnits(atCoupon.builderFee.value.amount)).toBeLessThan(toUnits(atFull.builderFee.value.amount));
  expect(atCoupon.venueFee.value).toEqual(atFull.venueFee.value);
  expect(toUnits(atFull.venueFee.value.amount)).toBeGreaterThan(0n);
  expect(await venueBalance(owner, 'USDC')).toEqual(held);
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

/** The rebate of one fill's builder fee: half of it, rounded down to TEST USD's 6 places, as svc-campaigns rounds it. */
function rebateOf(builderFee) {
  const unit = 10n ** 12n;
  return ((toUnits(builderFee) * BigInt(REBATE.rebateBps)) / 10_000n / unit) * unit;
}

/** The rebate coupon as svc-campaigns answers it, and what each of its accruals says, in fill order. */
async function rebateCoupon(account, code) {
  const v = await couponOf(account, code);
  expect(v, `${code} is in the wallet`).toBeTruthy();
  return v;
}

/**
 * Connects the person's TEST wallet to their account (svc-protocol's record, as J-campaigns-03 does it): the wallet a
 * reward is paid to. The desk's own connection is the browser's alone. A wallet already connected is left as it is.
 */
async function connectToAccount(browser, account, walletKey) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey });
    await signIn(page, account);
    await page.goto('/wallet');
    await page.getByRole('button', { name: 'Venue account', exact: true }).click();
    const connected = page.getByRole('heading', { name: 'Connected', exact: true });
    const connect = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true });
    await expect(connected.or(connect).first()).toBeVisible({ timeout: 30_000 });
    if (await connected.isVisible()) return;
    await connect.click();
    await page.getByRole('button', { name: 'Connect to my account', exact: true }).click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet', exact: true }).click();
    await expect(connected).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
}

/** A market order of `side` placed and filled on the desk; returns its client id and the venue's fills of it. */
async function filledMarket(page, owner, side) {
  await desk(page);
  const { sheet } = await reviewOrder(page, side, { type: 'market', amount: SELL.amount });
  const clientId = (await line(sheet, 'client-id').innerText()).trim();
  await expect(await confirmAndSign(page, sheet, side)).toContainText('Filled on the venue.');
  let fills = [];
  await expect
    .poll(async () => (fills = await fillsOf(owner, clientId)).length, { timeout: 30_000, message: `the venue filled ${clientId}` })
    .toBeGreaterThan(0);
  return { clientId, fills };
}

const accrualsOf = (v) => v.feeRebate.accruals.map((a) => ({ fillId: a.fillId, builderFee: a.builderFee, amount: a.amount }));

test(`${J} #5 trades with a rebate coupon: each eligible fill accrues; redelivered fills do not double it; a zero-fee fill accrues nothing; the total never passes the face value`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const { account, walletKey, rebateCode } = state('rebateCode');
  await connectToAccount(browser, account, walletKey);
  const { owner } = await desk(page);

  // The coupon, claimed on /campaigns/mine: its kind, what it pays back, after how long and up to what.
  await openVouchers(page);
  const form = page.getByRole('form', { name: 'Voucher code', exact: true });
  await form.getByRole('textbox', { name: 'Code', exact: true }).fill(rebateCode);
  await form.getByRole('button', { name: 'Check this code', exact: true }).click();
  await expect(page.getByTestId('voucher-validation')).toContainText(
    `a fee rebate coupon from TEST fee rebate ${tag}: 50% of our builder fee back on each venue fill, paid 2 hours after it, up to ${REBATE.face} USDC`,
  );
  await form.getByRole('button', { name: 'Claim this voucher', exact: true }).click();
  await expect.poll(async () => (await couponOf(account, rebateCode))?.state, { timeout: 15_000 }).toBe('claimed');
  const claimed = await rebateCoupon(account, rebateCode);
  expect(claimed).toMatchObject({
    kind: 'fee_rebate',
    face: { asset: 'USDC', amount: REBATE.face },
    remaining: REBATE.face,
    feeRebate: { rebateBps: REBATE.rebateBps, delaySeconds: REBATE.delaySeconds, accruals: [] },
  });
  const row = () => page.locator(`[data-testid="my-voucher"][data-voucher-id="${claimed.id}"]`);
  await expect(row().getByTestId('voucher-kind')).toHaveText('Fee rebate coupon:');
  await expect(row().getByTestId('voucher-does')).toHaveText(
    `pays 50% of our builder fee back on each of your venue fills, to your connected wallet 2 hours after the fill, up to ${REBATE.face} USDC in all; never the venue’s own fee.`,
  );
  // Its orders before the claim (#2, #3) accrued nothing; it is never redeemed for cash.
  await expect(row().getByRole('button', { name: 'Redeem', exact: true })).toHaveCount(0);

  // A zero-fee fill: a spot buy carries no builder fee of ours, as the venue reports on its fills. It accrues nothing.
  const buy = await filledMarket(page, owner, 'buy');
  for (const f of buy.fills) expect(toUnits(f.builderFee), `${f.fillId} carries no builder fee`).toBe(0n);

  // An eligible fill: a spot sell, with our builder fee as the venue charged it. It accrues half of that fee, once.
  const first = await filledMarket(page, owner, 'sell');
  const firstFees = first.fills.reduce((t, f) => t + rebateOf(f.builderFee), 0n);
  expect(firstFees, 'the first sell earns less than the face, so the coupon has room left after it').toBeLessThan(toUnits(REBATE.face));
  await expect
    .poll(async () => (await rebateCoupon(account, rebateCode)).feeRebate.accruals.length, { timeout: 60_000 })
    .toBe(first.fills.length);
  const once = await rebateCoupon(account, rebateCode);
  for (const f of first.fills) {
    const a = once.feeRebate.accruals.find((x) => x.fillId === f.fillId);
    expect(a, `${f.fillId} accrued`).toBeTruthy();
    expect(sameDecimal(a.builderFee, f.builderFee), `${f.fillId} accrued on the venue's own builder fee`).toBe(true);
    expect(toUnits(a.amount)).toBe(rebateOf(f.builderFee));
  }
  expect(once.feeRebate.accruals.some((a) => buy.fills.some((f) => f.fillId === a.fillId))).toBe(false);
  expect(toUnits(once.remaining)).toBe(toUnits(REBATE.face) - firstFees);

  // Redelivered: every pass reads all the fills since the claim again, and so does svc-campaigns after a restart. The
  // pass that accrues the next sell's fills has read this sell's fills again too: they must still have one accrual each.
  const before = accrualsOf(once);
  await restartService('campaigns');

  // The next sell accrues only what is left: the total stops at the face value exactly.
  const second = await filledMarket(page, owner, 'sell');
  await expect.poll(async () => (await rebateCoupon(account, rebateCode)).remaining, { timeout: 60_000 }).toBe('0');
  const full = await rebateCoupon(account, rebateCode);
  expect(full).toMatchObject({ state: 'used', used: REBATE.face, remaining: '0' });
  let left = toUnits(REBATE.face);
  for (const a of full.feeRebate.accruals) {
    const fill = [...first.fills, ...second.fills].find((f) => f.fillId === a.fillId);
    expect(fill, `${a.fillId} is one of the sells' fills`).toBeTruthy();
    const want = rebateOf(fill.builderFee) < left ? rebateOf(fill.builderFee) : left;
    expect(toUnits(a.amount), `${a.fillId} accrued half its fee, cut to what was left`).toBe(want);
    left -= want;
  }
  expect(left).toBe(0n);
  // The first sell's fills, read again by every pass since and after the restart: still one accrual each, unchanged.
  for (const b of before) expect(accrualsOf(full).filter((a) => a.fillId === b.fillId)).toEqual([b]);
  expect(new Set(full.feeRebate.accruals.map((a) => a.fillId)).size).toBe(full.feeRebate.accruals.length);
  expect(full.feeRebate.accruals.reduce((t, a) => t + toUnits(a.amount), 0n)).toBe(toUnits(REBATE.face));
  // Each accrual is one redemption of the coupon, owed by INTAFACED from the campaign's budget and not yet paid: its delay
  // has not passed.
  expect(full.redemptions.map((r) => r.sequence)).toEqual(full.feeRebate.accruals.map((a) => a.sequence));
  for (const r of full.redemptions) {
    expect(r.reward.state, r.reward.rewardKey).toBe('owed');
    expect(r.reward.owed?.txId, r.reward.rewardKey).toBeTruthy();
    expect(r.reward.payout).toBeNull();
  }
  for (const a of full.feeRebate.accruals) expect(Date.parse(a.payableAt)).toBeGreaterThan(Date.now() + 3_600_000);

  // The wallet shows each accrual and the coupon used up.
  await openVouchers(page);
  for (const a of full.feeRebate.accruals) {
    const shown = row().locator(`[data-testid="voucher-accrual"][data-fill="${a.fillId}"]`);
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute('data-amount', a.amount);
    await expect(shown).toContainText(`${a.amount} USDC back of a ${a.builderFee} USDC builder fee`);
  }
  await expect(row().getByTestId('voucher-accrual')).toHaveCount(full.feeRebate.accruals.length);
  await expect(row().getByTestId('voucher-remaining')).toHaveText(`0 USDC left of ${REBATE.face} USDC`);
  await expect(row().getByTestId('voucher-state')).toHaveText('Used');
  run.write({ ...run.read(), rebateId: claimed.id });
});

test(`${J} #6 the delay passes: each accrual is paid once to the connected wallet with its chain reference, and a lost reply is reconciled`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { account, owner, rebateCode } = state('rebateCode', 'rebateId');
  // The payments go to the connected wallet on the chain, never into its venue account: the venue's own record of that
  // account is the same after every payment as before the delay passed.
  const venueBefore = await venueBalance(owner, 'USDC');
  const coupon = await rebateCoupon(account, rebateCode);
  const keys = coupon.redemptions.map((r) => r.reward.rewardKey);
  expect(keys.length, 'the rebate accrued in #5').toBeGreaterThan(0);
  // Before the delay passes nothing is paid: the payment passes since #5 left every accrual owed.
  for (const r of (await rebateCoupon(account, rebateCode)).redemptions) expect(r.reward.state).toBe('owed');

  // The first accrual's payment is broadcast and its answer lost; then the two hours pass for every accrual.
  await payFault(keys[0], 'lost_after_broadcast');
  for (const key of keys) await ageRecord('campaigns', 'reward', key, REBATE.delaySeconds * 1000 + 1_000);
  await expect
    .poll(async () => (await rebateCoupon(account, rebateCode)).redemptions.map((r) => r.reward.state), { timeout: 180_000 })
    .toEqual(keys.map(() => 'paid'));

  const paid = await rebateCoupon(account, rebateCode);
  const accrued = new Map(paid.feeRebate.accruals.map((a) => [a.sequence, a.amount]));
  // What was paid is what the venue's own fills earned: each accrual is half of the builder fee the venue itself charged
  // on its fill, cut to what the face value left, and together they are the face value exactly.
  const venueFills = (await venueRecord(owner, '/fills', { since: new Date(Date.now() - DAY).toISOString() })).value;
  let left = toUnits(REBATE.face);
  for (const a of paid.feeRebate.accruals) {
    const fill = venueFills.find((f) => f.fillId === a.fillId);
    expect(fill, `${a.fillId} is a fill on the venue's own record`).toBeTruthy();
    const want = rebateOf(fill.builderFee) < left ? rebateOf(fill.builderFee) : left;
    expect(toUnits(a.amount), `${a.fillId} paid half the venue's builder fee, cut to what was left`).toBe(want);
    left -= want;
  }
  expect(left).toBe(0n);
  const payers = new Set();
  for (const r of paid.redemptions) {
    const { chainTx, toWallet } = r.reward.payout ?? {};
    expect(chainTx, r.reward.rewardKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toWallet).toBe(owner);
    // Paid exactly the accrual, to the connected wallet, as the TEST chain itself records it.
    expect(r.amount).toBe(accrued.get(r.sequence));
    const receipt = await chainReceipt(chainTx);
    payers.add(receipt.from);
    const sent = receipt.transfers.filter((t) => t.token === TOKEN_USD.address && t.to === owner);
    expect(sent.map((t) => t.value)).toEqual([toUnits(r.amount) / 10n ** 12n]);
    // Booked once by the ledger, under the chain transaction's own key, at the exact amount.
    const businessKey = `campaigns:reward-paid:${chainTx}`;
    const tx = await ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(businessKey)}`);
    expect(tx.found, businessKey).toBe(true);
    for (const p of tx.postings) expect(sameDecimal(p.amount, r.amount), businessKey).toBe(true);
  }
  // Once each: the chain holds exactly one transfer from our rewards wallet to this wallet per accrual, the lost reply's
  // included (it was found on the chain, never sent again), and they reconcile to the face value exactly.
  expect(payers.size).toBe(1);
  const onChain = await usdTransfers([...payers][0], owner);
  const ours = onChain.filter((t) => paid.redemptions.some((r) => r.reward.payout.chainTx.toLowerCase() === t.tx));
  expect(ours).toHaveLength(paid.redemptions.length);
  expect(onChain).toHaveLength(paid.redemptions.length);
  expect(ours.reduce((t, x) => t + x.value, 0n) * 10n ** 12n).toBe(toUnits(REBATE.face));
  expect(await venueBalance(owner, 'USDC')).toEqual(venueBefore);

  // The wallet shows each payment's chain transaction and the wallet it went to.
  await signIn(page, account);
  await openVouchers(page);
  const row = page.locator(`[data-testid="my-voucher"][data-voucher-id="${paid.id}"]`);
  for (const r of paid.redemptions) {
    const item = row.locator(`[data-testid="voucher-redemptions"] li[data-reward-key="${r.reward.rewardKey}"]`);
    await expect(item).toHaveAttribute('data-state', 'paid');
    await expect(item.getByTestId('voucher-chain-tx')).toHaveAttribute('data-tx', r.reward.payout.chainTx);
    await expect(item.getByTestId('voucher-paid-to')).toHaveAttribute('data-wallet', owner);
  }
});
