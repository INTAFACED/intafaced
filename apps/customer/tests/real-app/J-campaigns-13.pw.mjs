// World: book, restart, stack
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueForThisFile, venueRecord } from './venue.mjs';
import { chainReceipt, rewardFunds, sumDecimal } from './reward-funds.mjs';

// J-campaigns-13, in the running app (docs/roadmap/journeys.json): receive an airdrop, a dividend, or my share of a
// reward pool. One test per step, titled "J-campaigns-13 #<n>", run in order. The airdrop and the pool are this run's
// TEST campaigns, made by the stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks,
// B approves, A activates), paid from INTAFACED's TEST USDC reward pot, which the founders fund from builder fees the
// TEST venue credited us on this file's own sells (reward-funds.mjs). Every share is INTAFACED's own money: owed once and
// paid once in TEST USDC to the person's own connected wallet on the stack's TEST chain, never credited to a balance.
// Venue equity and activity are read from the TEST venue's own balances and fills. A dividend waits for the owner's
// decision (OWNER 87). The pool's TEST day is two minutes long, so a day settles within the run.
const J = 'J-campaigns-13';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ASSET = 'USDC';
const DAY = 86_400_000;
const SELL = '0.1';
const PRICE = '59990';
// The airdrop: a TEST pool of 0.05 USDC shared by venue equity at the snapshot; ANN holds 200 USDC on the venue and
// BEN 100, so ANN's share is 0.05 x 2/3 and BEN's 0.05 x 1/3, each rounded down to the TEST token's 6 decimals and the
// one unit left given to the larger remainder (BEN's): 0.033333 and 0.016667, summing exactly to the pool.
const AIRDROP_POOL = '0.05';
const ANN_EQUITY = '200';
const BEN_EQUITY = '100';
const ANN_SHARE = '0.033333';
const BEN_SHARE = '0.016667';
// The pool: 0.02 USDC a day, at most 0.015 to one person, for anyone holding at least 150 USDC on the venue.
const POOL_BUDGET = '0.04';
const SLICE = '0.02';
const CAP = '0.015';
const MIN_BALANCE = '150';
const DAY_SECONDS = 120;
// ANN's one sell of 0.1 BTC at 59,990 is 5,999 USDC of activity; alone, her share is the whole slice held to the cap.
const ACTIVITY = '5999';
const REMAINDER = '0.005';
const DIVIDEND_QUESTION = 'Does INTAFACED pay dividends to holders of its token, from which revenue, and under what legal form?';

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
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
const funds = rewardFunds({ J, RUN, operators });

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** One TEST campaign, live now, made by A, approved by B, activated by A. */
async function liveCampaign(definition) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
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

const common = (name) => ({
  name,
  participation: { exclusions: [], regionScope: 'platform' },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
});

/** Basic verification through the verification room, granted by the stack's TEST reviewer. */
async function verifyBasic(page) {
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
}

/** The person's own TEST wallet: a key made from this run's name, holding nothing real. */
const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST distribution wallet ${J} ${RUN} ${who.handle}`));
const sheet = (page) => page.locator('[data-sheet="sign"]');

/** Connects the person's TEST wallet to their account on Wallet's Venue account tab, as svc-protocol records it. */
async function connectWallet(page, who, privateKey) {
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await page.getByRole('button', { name: 'Connect to my account' }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** A TEST person: signed up in Pro, basic verification, their own TEST wallet connected. */
async function trader(browser, prefix) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await chosePro(page);
  const who = await signUp(page, prefix);
  await verifyBasic(page);
  const key = walletKeyOf(who);
  const wallet = privateKeyToAccount(key).address.toLowerCase();
  fundOnTestChain(wallet, 'venue');
  const connecting = await (await browser.newContext()).newPage();
  await connectWallet(connecting, who, key);
  await connecting.context().close();
  await context.close();
  return { who, key, wallet };
}

/** One action through svc-trade's user-venue door as `who`, signed with their own TEST wallet: prepare, sign, submit. */
async function door(p, intent, actionKey) {
  const session = await api(p.who);
  const signer = { role: 'owner', address: p.wallet };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: p.wallet, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const t = prepared.body.prepared.typedData;
  const signature = await privateKeyToAccount(p.key).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: p.wallet },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

const venueId = async () => (await testVenue('/venue')).body.venue.id;

/** TEST funds on the person's own venue account, by the TEST venue's deposit control (each reference credits once). */
async function venueFunds(p, asset, amount) {
  const funded = await testVenue('/test/deposit', {
    account: { venueId: await venueId(), owner: p.wallet, subAccount: null },
    asset,
    amount,
    depositRef: `84532:${keccak256(toHex(`${J} ${RUN} ${p.wallet} ${asset} ${amount} ${Date.now()}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
}

/** The person approves our builder fee through the door once, so their venue account is one they signed through us. */
async function signedThroughUs(p) {
  const status = (await (await api(p.who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(
    p,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap },
    `approve-builder:${p.wallet}:${J}:${RUN}`,
  );
}

/** The person's USDC on the venue, as the TEST venue's own balances report it. */
async function venueUsdc(p) {
  const body = await venueRecord(p.wallet, '/balances');
  return sumDecimal(body.value.filter((b) => b.asset === ASSET).map((b) => b.total));
}

let orders = 0;
/** Sells SELL BTC at PRICE through INTAFACED's venue door, into a TEST bid from another TEST trader: one venue fill. */
async function sellThroughUs(p) {
  const buyer = `${J}-buyer-${RUN}-${(orders += 1)}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '100000', `seed:${buyer}:USDC:${Date.now()}`);
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: SELL,
    price: PRICE,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:bid:${Date.now()}`,
    builderFee: null,
  });
  expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  await door(p, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'sell',
    type: 'limit',
    amount: SELL,
    price: PRICE,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J}:${RUN}:${p.who.handle}:${Date.now()}:${(orders += 1)}`,
    builderFee: null,
  });
}

const trpcGet = async (who, path, input) => {
  const res = await (await api(who)).get(`/api/campaigns/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  return res;
};
async function mine(who, kind = 'airdrop') {
  const res = await trpcGet(who, 'distribution.mine', { kind });
  if (!res.body?.result) throw new Error(`distribution.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.records;
}
async function poolBoard(who, campaignId) {
  const res = await trpcGet(who, 'pool.board', { campaignId });
  if (!res.body?.result) throw new Error(`pool.board refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}
async function myRewards(who) {
  const res = await trpcGet(who, 'rewards.mine', {});
  if (!res.body?.result) throw new Error(`rewards.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.rewards;
}
const join = async (who, campaignId) => {
  const joined = await (await api(who)).post('/api/campaigns/trpc/participation.join', { campaignId });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
};

/** TEST USD units (6 decimals) of a USDC decimal amount. */
function usdUnits(amount) {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(6, '0').slice(0, 6));
}

/** One reward, paid once to the person's connected wallet: owed once, paid once, and the TEST chain's receipt shows one transfer. */
async function paidOnce(p, rewardKey, amount) {
  const rowOf = async () => (await myRewards(p.who)).filter((r) => r.rewardKey === rewardKey);
  await expect.poll(async () => (await rowOf()).map((r) => r.state), { timeout: 240_000 }).toEqual(['paid']);
  const [row] = await rowOf();
  expect(row).toMatchObject({ asset: ASSET, amount, state: 'paid' });
  expect(row.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
  expect(row.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
  expect(row.payout?.toWallet).toBe(p.wallet);
  expect(row.payout.chainTx).toMatch(/^0x[0-9a-f]{64}$/);
  const receipt = await chainReceipt(row.payout.chainTx);
  expect(receipt.transfers).toEqual([{ token: TOKEN_USD.address, from: receipt.from, to: p.wallet, value: usdUnits(amount) }]);
  return row.payout.chainTx;
}

async function openDividends(page) {
  await page.goto('/uc/paydividends');
  await expect(page.getByRole('heading', { name: 'Dividend records' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Reading your records')).toHaveCount(0, { timeout: 30_000 });
}

async function openPool(page, campaignId) {
  await page.goto(`/campaigns/${encodeURIComponent(campaignId)}`);
  const room = page.getByTestId('pool');
  await expect(room).toBeVisible({ timeout: 30_000 });
  return room;
}

test(`${J} starts: signed in; a snapshot distribution has run, and a pool campaign is paying daily`, async ({ browser }) => {
  test.setTimeout(900_000);
  run.reset({});
  // INTAFACED's TEST reward pot and rewards wallet: builder fees this file's own TEST sells earned us.
  const house = await trader(browser, 'jc13h');
  const fees = await funds.earnBuilderFees(house.who, 6);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
  // Two TEST people, each with their own connected TEST wallet and a venue account they signed through us.
  const ann = await trader(browser, 'jc13a');
  const ben = await trader(browser, 'jc13b');
  for (const p of [ann, ben]) await signedThroughUs(p);
  await venueFunds(ann, ASSET, ANN_EQUITY);
  await venueFunds(ben, ASSET, BEN_EQUITY);
  expect(await venueUsdc(ann)).toBe(ANN_EQUITY);
  expect(await venueUsdc(ben)).toBe(BEN_EQUITY);
  run.write({ ann, ben });
});

test(`${J} #1 opens /uc/paydividends with no distribution: the honest empty history`, async ({ browser }) => {
  const { ann } = state('ann');
  expect(await mine(ann.who)).toEqual([]);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  await openDividends(page);
  await expect(page.getByTestId('dividend-record')).toHaveCount(0);
  const empty = page.getByTestId('dividends-empty');
  await expect(empty).toHaveAttribute('data-kind', 'airdrop');
  await expect(empty).toContainText('No records yet');
  await expect(empty).toContainText('An airdrop you join is listed here once its snapshot time comes.');
  await expect(page.getByText('not a statement that you were owed one or paid nothing')).toBeVisible();
});

test(`${J} #2 opens it after an airdrop ran: my record with the snapshot, my amount, and its chain reference once paid`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { ann, ben } = state('ann', 'ben');
  const snapshotAt = new Date(Date.now() + 75_000).toISOString();
  const airdrop = await liveCampaign({
    ...common(`TEST airdrop ${tag}`),
    type: 'distribution',
    rules: `TEST rules: join before the snapshot. The TEST ${ASSET} pool is shared by venue equity at the snapshot, paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    budget: { asset: ASSET, limit: AIRDROP_POOL },
    distribution: { kind: 'airdrop', snapshotAt, equityAsset: ASSET },
  });
  await join(ann.who, airdrop.id);
  await join(ben.who, airdrop.id);
  // Before the snapshot: waiting, nothing owed; an operator's run is refused as not due.
  expect(await mine(ann.who)).toMatchObject([{ campaignId: airdrop.id, standing: 'waiting', share: null }]);
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const early = await ctx.edge.mutate('campaigns', 'ops.campaigns.distribution.run', { campaignId: airdrop.id, reason: `TEST ${J}` }, a);
  expect(early.status, early.text.slice(0, 300)).toBe(412);
  expect(early.json?.error?.message ?? '').toContain('[campaigns.snapshot_not_due]');
  // At the snapshot the service reads each account's venue equity once and owes each share.
  await expect.poll(async () => (await mine(ann.who))[0]?.standing, { timeout: 180_000, intervals: [3_000] }).toBe('counted');
  const [annRecord] = await mine(ann.who);
  const [benRecord] = await mine(ben.who);
  expect(annRecord).toMatchObject({
    campaignId: airdrop.id,
    snapshotAt,
    asset: ASSET,
    pool: AIRDROP_POOL,
    equity: ANN_EQUITY,
    equityAsset: ASSET,
    share: ANN_SHARE,
    rewardKey: `distribution:${airdrop.id}:${annRecord.rewardKey.split(':').at(-1)}`,
  });
  expect(benRecord).toMatchObject({ standing: 'counted', equity: BEN_EQUITY, share: BEN_SHARE });
  // The shares sum exactly to the pool; run again by an operator, the run stands as it was and owes nothing more.
  expect(sumDecimal([annRecord.share, benRecord.share])).toBe(AIRDROP_POOL);
  const again = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.distribution.run', { campaignId: airdrop.id, reason: `TEST ${J} again` }, a),
    'ops.campaigns.distribution.run',
  );
  expect(again).toMatchObject({
    state: 'owed',
    pool: AIRDROP_POOL,
    counted: 2,
    excludedNegative: 0,
    heldOut: 0,
    sharesTotal: AIRDROP_POOL,
  });
  // Paid once to each person's connected wallet, the chain's own receipt showing exactly one transfer of exactly the share.
  const annTx = await paidOnce(ann, annRecord.rewardKey, ANN_SHARE);
  const benTx = await paidOnce(ben, benRecord.rewardKey, BEN_SHARE);
  expect(annTx).not.toBe(benTx);
  // On screen: the record with the snapshot, the amount and the chain reference.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  await openDividends(page);
  const row = page.locator(`[data-testid="dividend-record"][data-campaign-id="${airdrop.id}"]`);
  await expect(row).toHaveAttribute('data-state', 'paid', { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-standing', 'counted');
  await expect(row.getByTestId('dividend-snapshot')).toHaveAttribute('data-at', snapshotAt);
  await expect(row.getByTestId('dividend-amount')).toHaveText(`${ANN_SHARE} ${ASSET}`);
  await expect(row.getByTestId('dividend-source')).toContainText(`by your venue equity of ${ANN_EQUITY} ${ASSET} at the snapshot`);
  await expect(row.getByTestId('dividend-chain-tx')).toHaveAttribute('data-tx', annTx);
  await expect(row.getByTestId('dividend-payment')).toContainText(`Paid to ${ann.wallet} on the chain`);
  run.write({ ...run.read(), airdropId: airdrop.id });
});

test(`${J} #3 opens a dividend record while the owner decision is open: the refusal naming the decision; the room stays empty`, async ({
  browser,
}) => {
  const { ann } = state('ann', 'airdropId');
  // A dividend cannot go live: its submission is refused naming the decision.
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const made = data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.campaigns.create',
      {
        ...common(`TEST dividend ${tag}`),
        type: 'distribution',
        rules: 'TEST rules: a dividend to token holders.',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
        budget: { asset: ASSET, limit: '0.01' },
        distribution: { kind: 'dividend', snapshotAt: new Date(Date.now() + 60_000).toISOString(), equityAsset: ASSET },
      },
      a,
    ),
    'ops.campaigns.create',
  );
  const submit = await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a);
  expect(submit.status, submit.text.slice(0, 300)).toBe(412);
  expect(submit.json?.error?.message ?? '').toContain(`${DIVIDEND_QUESTION} [owner.decision]`);
  // Reading dividends is refused naming the decision.
  const refused = await trpcGet(ann.who, 'distribution.mine', { kind: 'dividend' });
  expect(refused.status).toBe(412);
  expect(JSON.stringify(refused.body)).toContain(DIVIDEND_QUESTION);
  // In the room: the refusal, and no dividend record.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  await openDividends(page);
  await page.getByTestId('dividends-kind').getByRole('button', { name: 'Dividends' }).click();
  await expect(page.getByTestId('dividends-kind').getByRole('button', { name: 'Dividends' })).toHaveAttribute('aria-pressed', 'true');
  const refusal = page.getByTestId('dividends-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'owner.decision', { timeout: 30_000 });
  await expect(refusal).toHaveText(`No dividend is paid. Dividends wait for an owner decision: ${DIVIDEND_QUESTION}`);
  await expect(page.getByTestId('dividends-empty')).toHaveAttribute('data-kind', 'dividend');
  await expect(page.getByTestId('dividends-empty')).toHaveText('No dividend records');
  await expect(page.getByTestId('dividend-record')).toHaveCount(0);
});

test(`${J} #4 opens a pool campaign at /campaigns/<id>: my share for each settled day, the per-user cap, and "nothing today" below the minimum balance, read from the venue with its as-of time`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { ann, ben } = state('ann', 'ben');
  // ANN holds TEST BTC to sell; BEN holds 100 USDC on the venue, below the pool's minimum of 150.
  await venueFunds(ann, 'BTC', '1');
  const pool = await liveCampaign({
    ...common(`TEST pool ${tag}`),
    type: 'pool',
    rules: `TEST rules: each TEST day of two minutes, ${SLICE} ${ASSET} is shared by venue activity through INTAFACED, at most ${CAP} each, for anyone holding ${MIN_BALANCE} ${ASSET} on the venue.`,
    startsAt: new Date(Date.now() - 1_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    budget: { asset: ASSET, limit: POOL_BUDGET },
    pool: { activityAsset: ASSET, dailySlice: SLICE, perUserCap: CAP, minBalance: MIN_BALANCE, daySeconds: DAY_SECONDS },
  });
  await join(ann.who, pool.id);
  await join(ben.who, pool.id);
  // Day 1: ANN trades on the venue through INTAFACED.
  await sellThroughUs(ann);
  const benPage = await (await browser.newContext()).newPage();
  await signIn(benPage, ben.who);
  let room = await openPool(benPage, pool.id);
  await expect(room.getByTestId('pool-slice')).toHaveText(`${SLICE} ${ASSET}`);
  await expect(room.getByTestId('pool-cap')).toHaveText(`${CAP} ${ASSET}`);
  await expect(room.getByTestId('pool-min-balance')).toHaveText(`${MIN_BALANCE} ${ASSET}`);
  // Today, BEN's balance read from the venue now, with its as-of time: below the minimum, so nothing today.
  const today = room.getByTestId('pool-today');
  await expect(today).toHaveAttribute('data-below-minimum', 'true');
  await expect(today).toHaveAttribute('data-balance', BEN_EQUITY);
  await expect(today).toContainText(`Nothing today: your venue balance of ${BEN_EQUITY} ${ASSET}, read from the venue at`);
  await expect(today).toContainText(`is below the minimum of ${MIN_BALANCE} ${ASSET}.`);
  const asOf = await today.getAttribute('data-as-of');
  expect(Math.abs(new Date(asOf).getTime() - Date.now())).toBeLessThan(120_000);
  // Day 1 settles once it has ended: ANN alone counts, held to the per-user cap; the rest stays in the pool.
  await expect
    .poll(async () => (await poolBoard(ann.who, pool.id)).days.find((d) => d.day === 1)?.settledAt ?? null, {
      timeout: 300_000,
      intervals: [5_000],
    })
    .not.toBeNull();
  const annBoard = await poolBoard(ann.who, pool.id);
  const day1 = annBoard.days.find((d) => d.day === 1);
  expect(day1).toMatchObject({ slice: SLICE, sharesTotal: CAP, remainder: REMAINDER });
  expect(sumDecimal([day1.sharesTotal, day1.remainder])).toBe(SLICE);
  expect(day1.mine).toMatchObject({ eligible: true, share: CAP, capped: true, activity: ACTIVITY });
  const benDay1 = (await poolBoard(ben.who, pool.id)).days.find((d) => d.day === 1);
  expect(benDay1.mine).toMatchObject({ eligible: false, share: '0', rewardKey: null, balance: BEN_EQUITY });
  // On screen, ANN's day 1: the share held to the cap and what stays in the pool.
  const annPage = await (await browser.newContext()).newPage();
  await signIn(annPage, ann.who);
  room = await openPool(annPage, pool.id);
  const annRow = room.locator('[data-testid="pool-day"][data-day="1"]');
  await expect(annRow).toHaveAttribute('data-settled', 'true');
  await expect(annRow).toHaveAttribute('data-capped', 'true');
  await expect(annRow.getByTestId('pool-day-share')).toContainText(`${CAP} ${ASSET} (held to the per-user cap)`);
  await expect(annRow.getByTestId('pool-day-remainder')).toHaveText(`Shared ${CAP} of ${SLICE} ${ASSET}; ${REMAINDER} stays in the pool.`);
  await expect(room.getByTestId('pool-today')).toHaveAttribute('data-below-minimum', 'false');
  // BEN's day 1: nothing that day, with the balance read from the venue and its time.
  room = await openPool(benPage, pool.id);
  const benRow = room.locator('[data-testid="pool-day"][data-day="1"]');
  await expect(benRow).toHaveAttribute('data-eligible', 'false');
  await expect(benRow.getByTestId('pool-day-share')).toContainText(
    `Nothing that day: your venue balance of ${BEN_EQUITY} ${ASSET}, read at`,
  );
  run.write({ ...run.read(), poolId: pool.id, annPoolKey: day1.mine.rewardKey });
});

test(`${J} #5 a day settles twice: each share paid once to the connected wallet`, async ({ browser }) => {
  test.setTimeout(600_000);
  const { ann, ben, poolId, annPoolKey } = state('ann', 'ben', 'poolId', 'annPoolKey');
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const before = (await poolBoard(ann.who, poolId)).days.find((d) => d.day === 1);
  // Day 1 settled by the service already; settling it twice more, together, writes nothing new.
  const settle = () => ctx.edge.mutate('campaigns', 'ops.campaigns.pool.settle', { campaignId: poolId, day: 1, reason: `TEST ${J}` }, a);
  const answers = await Promise.all([settle(), settle()]);
  for (const res of answers) {
    const settled = data(res, 'ops.campaigns.pool.settle');
    expect(settled.settled).toBe(false);
    expect(settled.day).toMatchObject({ day: 1, slice: before.slice, sharesTotal: before.sharesTotal, remainder: before.remainder });
  }
  // ANN's share is paid once to her connected wallet; BEN, below the minimum, is owed nothing from the pool.
  const tx = await paidOnce(ann, annPoolKey, CAP);
  expect((await myRewards(ann.who)).filter((r) => r.campaignId === poolId && r.rewardKey.startsWith(`pool:${poolId}:1:`))).toHaveLength(1);
  expect((await myRewards(ben.who)).filter((r) => r.campaignId === poolId)).toEqual([]);
  const after = (await poolBoard(ann.who, poolId)).days.find((d) => d.day === 1);
  expect(after).toMatchObject({ settledAt: before.settledAt, sharesTotal: before.sharesTotal, remainder: before.remainder });
  expect(after.mine).toMatchObject({ state: 'paid', chainTx: tx });
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  const room = await openPool(page, poolId);
  const row = room.locator('[data-testid="pool-day"][data-day="1"]');
  await expect(row).toHaveAttribute('data-state', 'paid', { timeout: 30_000 });
  await expect(row.getByTestId('pool-day-chain-tx')).toHaveAttribute('data-tx', tx);
});
