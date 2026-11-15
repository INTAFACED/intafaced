// World: book, restart, stack
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { chosePro, signIn, signUp } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { chainBalance, otherTraderKey, otherTraderRun, testDeposit, testVenue, venueForThisFile, venueRecord } from './venue.mjs';

// J-campaigns-12, in the running app (docs/roadmap/journeys.json): take part in a lucky draw. One test per step, titled
// "J-campaigns-12 #<n>", run in order. The draw is this run's TEST campaign, made by the stack's two LOCAL TEST founders
// through svc-campaigns' operator doors (A creates and asks, B approves, A activates), with TEST terms: chances per venue
// fill, a cap for each user type (the verification level) and a TEST prize table from its TEST budget. Chances are earned
// by trading on the TEST venue through INTAFACED's venue door, read from the venue's own fills. Running the draw waits for
// the owner's decision on chance-based rewards (OWNER 87): it is refused `owner.decision` naming the question, and nothing
// is paid. #4 (recompute the winners from the revealed seed) and #5 (win, deferred to launch prep) need a draw that ran,
// which no stack can have while that decision is open.
const J = 'J-campaigns-12';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ASSET = 'USDC';
const DAY = 86_400_000;
const SELL = '0.1';
const PRICE = '59990';
// TEST terms: 2 chances per fill; a basic-verified person holds at most 3, so their second fill reaches the cap.
const PER_FILL = 2;
const CAPS = [
  { userType: 'none', cap: 0 },
  { userType: 'basic', cap: 3 },
  { userType: 'full', cap: 10 },
  { userType: 'institutional', cap: 10 },
];
const PRIZES = [
  { rank: 1, amount: '0.02' },
  { rank: 2, amount: '0.01' },
];
const POOL = '0.05';
const QUESTION = 'Does INTAFACED run chance-based rewards such as a lucky draw, and under what legal form?';

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

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** This run's TEST draw, live now, made and approved by the two TEST founders. */
async function liveDraw(name) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'draw',
    rules: `TEST rules for ${name}: trade on the venue through INTAFACED to earn chances. Prizes are TEST ${ASSET}.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: ASSET, limit: POOL },
    limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: null,
    draw: { chancesPerFill: PER_FILL, caps: CAPS, prizes: PRIZES },
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
const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST draw wallet ${J} ${RUN} ${who.handle}`));
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

let orders = 0;
/** A TEST bid for `amount` BTC at PRICE from another TEST trader on the venue, so the person's sells fill against it. */
async function restingBid(amount) {
  const buyer = `${J}-buyer-${RUN}-${(orders += 1)}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '100000', `seed:${buyer}:USDC:${Date.now()}`);
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount,
    price: PRICE,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:bid:${Date.now()}`,
    builderFee: null,
  });
  expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
}

/** The person's venue account holds TEST BTC, and they approve our builder fee through the door once. */
async function readyToSell(p, btc) {
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: p.wallet, subAccount: null };
  const funded = await testVenue('/test/deposit', {
    account,
    asset: 'BTC',
    amount: btc,
    depositRef: `84532:${keccak256(toHex(`${J} ${RUN} ${p.wallet} BTC ${Date.now()}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
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

/** Sells SELL BTC at PRICE through INTAFACED's venue door, `n` times, each into a TEST bid: one venue fill each. */
async function sellThroughUs(p, n) {
  await restingBid(String(Number(SELL) * n));
  for (let i = 0; i < n; i += 1) {
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
}

/** The venue's own fills of the person's wallet since `since` that carry our builder fee. */
async function ourVenueFills(p, since) {
  const body = await venueRecord(p.wallet, '/fills', { since });
  return body.value.filter((f) => !/^-?0(\.0+)?$/.test(f.builderFee) && !f.builderFee.startsWith('-'));
}

async function boardOf(who, campaignId) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/draw.board?input=${encodeURIComponent(JSON.stringify({ campaignId }))}`);
  if (!res.body?.result) throw new Error(`draw.board refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

async function myRewards(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`rewards.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.rewards;
}

/** The draw page, ready. */
async function openDraw(page, campaignId) {
  await page.goto(`/campaigns/${encodeURIComponent(campaignId)}`);
  const room = page.getByTestId('draw');
  await expect(room).toBeVisible({ timeout: 30_000 });
  return room;
}

test(`${J} starts: signed in; a draw campaign with chances earned by activity and per-type caps`, async ({ browser }) => {
  test.setTimeout(600_000);
  run.reset({});
  const campaign = await liveDraw(`TEST draw ${tag}`);
  const ann = await trader(browser, 'jc12a');
  const joined = await (await api(ann.who)).post('/api/campaigns/trpc/participation.join', { campaignId: campaign.id });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
  run.write({ campaignId: campaign.id, ann });
});

test(`${J} #1 opens the draw: the odds, prize table, my chances and the cap for my user type; the seed commitment`, async ({ browser }) => {
  const { campaignId, ann } = state('campaignId', 'ann');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  const room = await openDraw(page, campaignId);
  await expect(page.getByTestId('campaign-type-name')).toHaveText('Draw');
  // The prize table, from the draw's TEST budget.
  await expect(room.getByTestId('draw-pool')).toHaveText(`${POOL} ${ASSET}`);
  await expect(room.getByTestId('draw-prize')).toHaveCount(PRIZES.length);
  for (const p of PRIZES) {
    const row = room.locator(`[data-testid="draw-prize"][data-rank="${p.rank}"]`);
    await expect(row.getByRole('rowheader')).toHaveText(`#${p.rank}`);
    await expect(row.getByTestId('draw-prize-amount')).toHaveText(`${p.amount} ${ASSET}`);
  }
  // The odds as they stand: no chance held yet by anyone.
  const odds = room.getByTestId('draw-odds');
  await expect(odds).toHaveAttribute('data-total', '0');
  await expect(odds).toHaveText(
    'Each prize goes to one chance drawn from every chance held, one prize per entrant. No one holds a chance yet.',
  );
  // My chances, and the cap for my user type (basic verification).
  const mine = room.getByTestId('draw-mine');
  await expect(mine).toHaveAttribute('data-chances', '0');
  await expect(mine).toHaveAttribute('data-cap', '3');
  await expect(room.getByTestId('draw-mine-chances')).toHaveText('0 of 3 chances; fills counted: 0');
  await expect(room.getByTestId('draw-mine-user-type')).toHaveText('Your user type: Basic verification. The most you can hold: 3.');
  await expect(room.locator('[data-testid="draw-cap"][data-mine="true"]')).toHaveAttribute('data-user-type', 'basic');
  for (const c of CAPS) {
    await expect(room.locator(`[data-testid="draw-cap"][data-user-type="${c.userType}"]`)).toHaveAttribute('data-cap', String(c.cap));
  }
  // The seed commitment: a SHA-256, the one the service holds, unchanged between reads, and not the seed.
  const commitment = (await room.getByTestId('draw-commitment').innerText()).trim();
  expect(commitment).toMatch(/^[0-9a-f]{64}$/);
  const board = await boardOf(ann.who, campaignId);
  expect(board.commitment).toBe(commitment);
  expect(board.revealed).toBeNull();
  expect((await boardOf(ann.who, campaignId)).commitment).toBe(commitment);
  run.write({ ...run.read(), commitment, entryHash: board.entryHash });
});

test(`${J} #2 earns chances by activity: chances rise to the cap and no further`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { campaignId, ann, commitment, entryHash } = state('campaignId', 'ann', 'commitment', 'entryHash');
  const since = new Date(Date.now() - 1_000).toISOString();
  await readyToSell(ann, '1');
  // One fill through INTAFACED: 2 chances, under the cap of 3.
  await sellThroughUs(ann, 1);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  let room = await openDraw(page, campaignId);
  await expect(room.getByTestId('draw-mine')).toHaveAttribute('data-chances', String(PER_FILL));
  await expect(room.getByTestId('draw-mine-chances')).toHaveText(`${PER_FILL} of 3 chances; fills counted: 1`);
  await expect(room.getByTestId('draw-mine')).toHaveAttribute('data-capped', 'false');
  await expect(room.getByTestId('draw-mine-capped')).toHaveCount(0);
  // Two more fills: the cap stops the second fill at 1 more chance, and the third adds none.
  await sellThroughUs(ann, 2);
  const fills = await ourVenueFills(ann, since);
  expect(fills, JSON.stringify(fills).slice(0, 400)).toHaveLength(3);
  room = await openDraw(page, campaignId);
  await expect(room.getByTestId('draw-mine')).toHaveAttribute('data-fills', '3');
  await expect(room.getByTestId('draw-mine')).toHaveAttribute('data-chances', '3');
  await expect(room.getByTestId('draw-mine-chances')).toHaveText('3 of 3 chances; fills counted: 3');
  await expect(room.getByTestId('draw-mine')).toHaveAttribute('data-capped', 'true');
  await expect(room.getByTestId('draw-mine-capped')).toHaveText(
    'You reached the cap for your user type: more activity earns no more chances.',
  );
  // Read again: each fill counted once, so the chances stay at the cap.
  const again = await boardOf(ann.who, campaignId);
  expect(again.mine).toMatchObject({ chances: 3, fills: 3, cap: 3, capped: true, userType: 'basic' });
  // The odds and the entry list follow the chances; the commitment made before the first entry stays.
  expect(again.totalChances).toBeGreaterThanOrEqual(3);
  await expect(room.getByTestId('draw-odds')).toHaveAttribute('data-mine', '3');
  expect(again.commitment).toBe(commitment);
  expect(again.entryHash).not.toBe(entryHash);
  expect((await room.getByTestId('draw-entry-hash').innerText()).trim()).toBe(again.entryHash);
});

test(`${J} #3 the draw is run: while the owner decision is open, the refusal naming it and nothing paid`, async ({ browser }) => {
  const { campaignId, ann, commitment } = state('campaignId', 'ann', 'commitment');
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const budgetLeft = async () =>
    data(await ctx.edge.query('campaigns', 'ops.campaigns.get', { id: campaignId }, a), 'ops.campaigns.get').budget;
  // Before the run: the whole TEST budget is left, and the person's TEST wallet holds what the chain says.
  const before = await boardOf(ann.who, campaignId);
  expect(await budgetLeft()).toEqual({ asset: ASSET, limit: POOL, left: POOL });
  const walletBefore = await chainBalance(TOKEN_USD.address, ann.wallet);
  for (const door of ['ops.campaigns.draw.run', 'ops.campaigns.draw.settle']) {
    const res = await ctx.edge.mutate('campaigns', door, { campaignId, reason: `TEST ${J} run ${RUN}` }, a);
    expect(res.status, `${door}: ${res.text.slice(0, 300)}`).toBe(412);
    expect(res.json?.error?.message ?? '').toContain(`${QUESTION} [owner.decision]`);
  }
  // The person sees the draw is not running, with its blocker, and that nothing is paid.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  const room = await openDraw(page, campaignId);
  await expect(room.getByTestId('draw-not-running')).toHaveAttribute('data-code', 'owner.decision');
  await expect(room.getByTestId('draw-not-running')).toHaveText(`The draw is not running. It waits for an owner decision: ${QUESTION}`);
  await expect(room.getByTestId('draw-nothing-paid')).toHaveText(
    'No winner is drawn and no prize is paid until that decision is recorded.',
  );
  // Nothing drawn, nothing revealed, nothing owed to anyone from this draw.
  const board = await boardOf(ann.who, campaignId);
  expect(board).toMatchObject({ revealed: null, winners: [], commitment, running: { code: 'owner.decision', question: QUESTION } });
  const rewards = await myRewards(ann.who);
  expect(rewards.filter((r) => r.campaignId === campaignId)).toEqual([]);
  // Nothing moved: the budget is still whole, the wallet holds the same on the chain, and the entry list the draw would
  // be drawn from is unchanged.
  expect(await budgetLeft()).toEqual({ asset: ASSET, limit: POOL, left: POOL });
  expect(await chainBalance(TOKEN_USD.address, ann.wallet)).toBe(walletBefore);
  expect(board.entryHash).toBe(before.entryHash);
  expect(board.totalChances).toBe(before.totalChances);
  expect(board.mine).toEqual(before.mine);
});
