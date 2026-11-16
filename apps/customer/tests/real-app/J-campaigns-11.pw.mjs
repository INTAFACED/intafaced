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
import { ownSpotMarket } from './own-market.mjs';

// J-campaigns-11, in the running app (docs/roadmap/journeys.json): enter a trading competition. One test per step, titled
// "J-campaigns-11 #<n>", run in order. The competition is this run's TEST campaign, made by the stack's two LOCAL TEST
// founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates): two seats, a TEST volume
// threshold, a TEST prize table and one TEST milestone, ranked by volume. Its prize pool is the campaign's budget, from
// INTAFACED's TEST USDC reward pot, which the founders fund from builder fees the TEST venue credited us on this file's own
// sells (reward-funds.mjs; the venue door is on for this file). Every prize is INTAFACED's own money (launch money model,
// OWNER 226 and 288): recorded owed once under `competition:<campaign>:1:<account>` (a milestone's with `:m<tier>` after
// it) and paid once in TEST USDC to the winner's own connected wallet on the stack's TEST chain, never credited to a
// balance. Volume is read from the TEST venue's own fills of orders placed through INTAFACED's venue door.
const J = 'J-campaigns-11';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ASSET = 'USDC';
const DAY = 86_400_000;
const SELL = '0.5';
const PRICE = '59990';
// TEST terms: one sell of 0.5 BTC at 59,990 is 29,995 USDC of volume.
const THRESHOLD = '20000';
const PRIZES = [
  { rank: 1, amount: '0.02' },
  { rank: 2, amount: '0.01' },
];
const MILESTONE = { volume: '50000', amount: '0.005' };
// Two places, and two seats each reaching the milestone: 0.04, under the pool.
const POOL = '0.05';

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

/** This run's TEST competition, live now, made and approved by the two TEST founders. */
async function liveCompetition(name) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'competition',
    rules: `TEST rules for ${name}: trade on the venue through INTAFACED during the period. Ranked by volume; a place needs ${THRESHOLD} ${ASSET} of volume. Prizes are TEST ${ASSET}, paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: ASSET, limit: POOL },
    limits: { perCustomer: { count: 10, periodSeconds: 86_400 }, totalRedemptions: null },
    reward: null,
    competition: { basis: 'volume', volumeAsset: ASSET, threshold: THRESHOLD, seats: 2, prizes: PRIZES, milestones: [MILESTONE] },
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

/** The person's own TEST wallet: a key made from this run's name, holding nothing real. It trades and receives prizes. */
const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST competition wallet ${J} ${RUN} ${who.handle}`));
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
  // A market listed a moment ago may not be in our door's market list yet: it re-reads the venue's list on a miss, at most
  // every few seconds (user-venue-door.ts MARKET_MISS_REREAD_MS), so prepare (which places nothing) is asked again.
  let prepared;
  await expect(async () => {
    prepared = await session.post('/api/v1/venue/prepare', { owner: p.wallet, signer, intent, ...(actionKey ? { actionKey } : {}) });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [2_000] });
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

/** The same person's wallet acting on the TEST venue directly, as through another front end: no INTAFACED fee. */
async function directly(p, intent) {
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: p.wallet, subAccount: null };
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: p.wallet }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const t = prepared.body.typedData;
  const signature = await privateKeyToAccount(p.key).signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: p.wallet },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body).toMatchObject({ definite: true, accepted: true });
}

let orders = 0;
/** A TEST bid for `amount` of the market's base at PRICE from another TEST trader, so the person's sells fill against it. */
async function restingBid(market, amount) {
  const buyer = `${J}-buyer-${RUN}-${(orders += 1)}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '200000', `seed:${buyer}:USDC:${Date.now()}`);
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: market.symbol,
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

/** The person's venue account holds the market's TEST base asset, and they approve our builder fee through the door once. */
async function readyToSell(p, market, amount) {
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: p.wallet, subAccount: null };
  const funded = await testVenue('/test/deposit', {
    account,
    asset: market.base,
    amount,
    depositRef: `84532:${keccak256(toHex(`${J} ${RUN} ${p.wallet} ${market.base} ${Date.now()}`))}:0`,
  });
  expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  const status = (await (await api(p.who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === market.symbol).builderFeeCapBps.value;
  await door(
    p,
    { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap },
    `approve-builder:${p.wallet}:${J}:${RUN}`,
  );
}

/** Sells SELL of the market's base at PRICE through INTAFACED's venue door, `n` times, each into a TEST bid. */
async function sellThroughUs(p, market, n) {
  await restingBid(market, String(Number(SELL) * n));
  for (let i = 0; i < n; i += 1) {
    await door(p, {
      kind: 'place_order',
      symbol: market.symbol,
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

/** The venue's own fills of the person's wallet since `since`: those with our builder fee, and those without. */
async function venueFills(p, since) {
  const body = await venueRecord(p.wallet, '/fills', { since });
  const fills = body.value;
  const ours = fills.filter((f) => !/^-?0(\.0+)?$/.test(f.builderFee) && !f.builderFee.startsWith('-'));
  return { ours, without: fills.filter((f) => !ours.includes(f)) };
}

const notionalOf = (f) => {
  const [pw, pf = ''] = f.price.split('.');
  const [aw, af = ''] = f.amount.split('.');
  const p = BigInt(pw + pf.padEnd(18, '0'));
  const a = BigInt(aw + af.padEnd(18, '0'));
  const n = ((p * a) / 10n ** 18n).toString().padStart(19, '0');
  const frac = n.slice(-18).replace(/0+$/, '');
  return frac ? `${n.slice(0, -18)}.${frac}` : n.slice(0, -18);
};

async function boardOf(who, campaignId) {
  const res = await (
    await api(who)
  ).get(`/api/campaigns/trpc/competition.board?input=${encodeURIComponent(JSON.stringify({ campaignId }))}`);
  if (!res.body?.result) throw new Error(`competition.board refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

async function myRewards(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`rewards.mine refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data.rewards;
}

/** TEST USD units (6 decimals) of a USDC decimal amount. */
function usdUnits(amount) {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(6, '0').slice(0, 6));
}

/** The competition page, ready. */
async function openCompetition(page, campaignId) {
  await page.goto(`/campaigns/${encodeURIComponent(campaignId)}`);
  const room = page.getByTestId('competition');
  await expect(room).toBeVisible({ timeout: 30_000 });
  return room;
}

/** The leaderboard as shown: rank, seat, you, volume, fills. */
async function shownStandings(page) {
  return page
    .getByTestId('competition-standing')
    .evaluateAll((rows) =>
      rows.map((r) => [
        Number(r.dataset.rank),
        Number(r.dataset.seat),
        r.dataset.you === 'true',
        r.dataset.volume,
        Number(r.dataset.fills),
      ]),
    );
}

test(`${J} starts: signed in; an active volume competition with a threshold, seats and a prize pool`, async ({ browser }) => {
  test.setTimeout(900_000);
  run.reset({});
  // INTAFACED's TEST reward pot and rewards wallet: builder fees this file's own TEST sells earned us.
  const house = await trader(browser, 'jc11h');
  const fees = await funds.earnBuilderFees(house.who, 6);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
  const campaign = await liveCompetition(`TEST competition ${tag}`);
  // Three TEST people, each with their own connected TEST wallet: a rival who takes the first seat, and two who will
  // race for the last one.
  const rival = await trader(browser, 'jc11r');
  const ann = await trader(browser, 'jc11a');
  const cat = await trader(browser, 'jc11c');
  const joined = await (await api(rival.who)).post('/api/campaigns/trpc/participation.join', { campaignId: campaign.id });
  expect(joined.body?.result?.data?.created, JSON.stringify(joined.body).slice(0, 300)).toBe(true);
  const board = await boardOf(rival.who, campaign.id);
  expect(board).toMatchObject({ basis: 'volume', seats: 2, seatsLeft: 1, closed: false, pool: POOL, prizeAsset: ASSET });
  run.write({ campaignId: campaign.id, rival, ann, cat });
});

test(`${J} #1 opens a competition at /campaigns/<id>: rules, threshold, prize table, seats left and the ranking basis (volume)`, async ({
  browser,
}) => {
  const { campaignId, ann } = state('campaignId', 'ann');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, ann.who);
  const room = await openCompetition(page, campaignId);
  await expect(page.getByTestId('campaign-type-name')).toHaveText('Competition');
  await expect(page.getByTestId('campaign-rules')).toContainText(`a place needs ${THRESHOLD} ${ASSET} of volume`);
  await expect(room.getByTestId('competition-basis')).toHaveAttribute('data-basis', 'volume');
  await expect(room.getByTestId('competition-basis')).toHaveText('Volume traded on the venue through INTAFACED');
  await expect(room.getByTestId('competition-threshold')).toHaveText(`${THRESHOLD} ${ASSET}`);
  await expect(room.getByTestId('competition-seats-left')).toHaveText('1 of 2');
  await expect(room.getByTestId('competition-pool')).toHaveText(`${POOL} ${ASSET}`);
  const prizes = room.getByTestId('competition-prize');
  await expect(prizes).toHaveCount(PRIZES.length);
  for (const p of PRIZES) {
    const row = room.locator(`[data-testid="competition-prize"][data-rank="${p.rank}"]`);
    await expect(row.getByRole('rowheader')).toHaveText(`#${p.rank}`);
    await expect(row.getByTestId('competition-prize-amount')).toHaveText(`${p.amount} ${ASSET}`);
  }
  // Not joined yet: no entry of mine, and the Join button.
  await expect(room.getByTestId('competition-mine-none')).toBeVisible();
  await expect(page.getByRole('button', { name: `Join TEST competition ${tag}` })).toBeVisible();
});

test(`${J} #2 joins when only one seat is left, together with another account: one wins; the other gets the typed seat refusal`, async ({
  browser,
}) => {
  const { campaignId, ann, cat } = state('campaignId', 'ann', 'cat');
  const [a, c] = await Promise.all([
    (await api(ann.who)).post('/api/campaigns/trpc/participation.join', { campaignId }),
    (await api(cat.who)).post('/api/campaigns/trpc/participation.join', { campaignId }),
  ]);
  const answers = [
    { p: ann, res: a },
    { p: cat, res: c },
  ];
  const won = answers.filter((x) => x.res.body?.result?.data);
  const lost = answers.filter((x) => !x.res.body?.result?.data);
  expect(won, JSON.stringify([a.body, c.body]).slice(0, 600)).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect(lost[0].res.status).toBe(409);
  expect(lost[0].res.body?.error?.message ?? '').toContain('[campaigns.seats_full]');
  const winner = won[0].p;
  const loser = lost[0].p;
  // The winner holds the last seat; none is left.
  const board = await boardOf(winner.who, campaignId);
  expect(board.mine).toMatchObject({ seat: 2 });
  expect(board.seatsLeft).toBe(0);
  expect(board.standings.map((s) => s.seat)).toEqual([1, 2]);
  // The other account presses Join on the page: the typed seat refusal, and no seat.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, loser.who);
  const room = await openCompetition(page, campaignId);
  await expect(room.getByTestId('competition-seats-left')).toHaveText('0 of 2');
  await page.getByRole('button', { name: `Join TEST competition ${tag}` }).click();
  const refusal = page.getByTestId('campaign-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'campaigns.seats_full');
  await expect(refusal).toHaveText('Every seat in this competition is taken, so you cannot join it.');
  expect((await boardOf(loser.who, campaignId)).mine).toBeNull();
  run.write({ ...run.read(), winner, loser });
});

test(`${J} #3 trades on the venue through INTAFACED: volume counts once per venue fill, read from the venue, and the leaderboard order is stable`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { campaignId, winner, rival } = state('campaignId', 'winner', 'rival');
  const since = new Date(Date.now() - 1_000).toISOString();
  // A book this step owns: a fresh TEST market no other file trades. On the shared BTC-USDC book the stack's TEST ladder
  // rests a bid at PRICE, and what an earlier file in the shard took of it decided whether a sell here met one bid or
  // split across two, so the fill count moved with the run order (#8596: three fills for two sells after J-agents-18).
  const market = await ownSpotMarket(J, 'JCX', 'V');
  await readyToSell(winner, market, '3');
  await readyToSell(rival, market, '2');
  // Through INTAFACED: two sells for the winner, one for the rival.
  await sellThroughUs(winner, market, 2);
  await sellThroughUs(rival, market, 1);
  // Through another front end, with no INTAFACED fee: the venue fills it, and it adds nothing.
  await restingBid(market, '0.25');
  await directly(winner, {
    kind: 'place_order',
    symbol: market.symbol,
    side: 'sell',
    type: 'limit',
    amount: '0.25',
    price: PRICE,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J}:${RUN}:direct:${Date.now()}`,
    builderFee: null,
  });
  let mine;
  let theirs;
  await expect
    .poll(
      async () => {
        mine = await venueFills(winner, since);
        theirs = await venueFills(rival, since);
        return [mine.ours.length, mine.without.length, theirs.ours.length];
      },
      { timeout: 30_000 },
    )
    .toEqual([2, 1, 1]);
  // What the venue itself reports: the notional of each fill of an order placed through INTAFACED.
  const expected = sumDecimal(mine.ours.map(notionalOf));
  const expectedRival = sumDecimal(theirs.ours.map(notionalOf));
  expect(expected).toBe('59990');
  expect(expectedRival).toBe('29995');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, winner.who);
  const room = await openCompetition(page, campaignId);
  const wanted = [
    [1, 2, true, expected, 2],
    [2, 1, false, expectedRival, 1],
  ];
  await expect
    .poll(async () => (await page.reload(), await openCompetition(page, campaignId), shownStandings(page)), { timeout: 60_000 })
    .toEqual(wanted);
  await expect(room.getByTestId('competition-mine')).toHaveAttribute('data-volume', expected);
  await expect(room.getByTestId('competition-mine')).toHaveAttribute('data-rank', '1');
  await expect(room.getByTestId('competition-as-of')).toBeVisible();
  // Read again: every board read reads the venue's fills afresh (its as-of time moves), and the same fills come back.
  // Nothing counts twice, and the order stays the same.
  let asOf = (await boardOf(winner.who, campaignId)).asOf;
  for (let i = 0; i < 3; i += 1) {
    await page.reload();
    await openCompetition(page, campaignId);
    expect(await shownStandings(page)).toEqual(wanted);
    const again = await boardOf(winner.who, campaignId);
    expect(Date.parse(again.asOf)).toBeGreaterThan(Date.parse(asOf));
    asOf = again.asOf;
  }
  const board = await boardOf(rival.who, campaignId);
  expect(board.standings.map((s) => [s.rank, s.seat, s.you, s.volume, s.fills])).toEqual([
    [1, 2, false, expected, 2],
    [2, 1, true, expectedRival, 1],
  ]);
  expect(board.standings.every((s) => s.qualifies)).toBe(true);
});

test(`${J} #4 reaches a milestone tier: the milestone shows reached, and its prize is queued once`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { campaignId, winner, rival } = state('campaignId', 'winner', 'rival');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, winner.who);
  const room = await openCompetition(page, campaignId);
  const tier = room.locator('[data-testid="competition-milestone"][data-tier="1"]');
  await expect(tier).toHaveAttribute('data-reached', 'true', { timeout: 30_000 });
  await expect(tier.getByTestId('competition-milestone-state')).toHaveText('Reached: prize queued');
  const key = await tier.getAttribute('data-reward-key');
  expect(key).toMatch(new RegExp(`^competition:${campaignId}:1:.+:m1$`));
  // Queued once: one reward record under its key, owed by INTAFACED for exactly the milestone's prize, held until the
  // period closes. The board is read again, which reads the venue and checks the milestones again: still one.
  const queued = async () => (await myRewards(winner.who)).filter((r) => r.rewardKey === key);
  await expect.poll(async () => (await queued()).map((r) => r.state), { timeout: 30_000 }).toEqual(['owed']);
  for (let i = 0; i < 2; i += 1)
    expect((await boardOf(winner.who, campaignId)).milestones[0]).toMatchObject({ reached: true, rewardKey: key });
  const rows = await queued();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ asset: ASSET, amount: MILESTONE.amount, state: 'owed' });
  expect(rows[0].attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
  expect(rows[0].payout).toBeNull();
  // The rival's volume is under the milestone: not reached, nothing queued.
  const theirs = await boardOf(rival.who, campaignId);
  expect(theirs.milestones).toEqual([expect.objectContaining({ tier: 1, reached: false, rewardKey: null })]);
  expect((await myRewards(rival.who)).filter((r) => r.campaignId === campaignId)).toEqual([]);
  run.write({ ...run.read(), milestoneKey: key });
});

test(`${J} #5 the period closes: prizes are paid once each to the winners' connected wallets; winners see them in My Rewards with the chain reference`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { campaignId, winner, rival, milestoneKey } = state('campaignId', 'winner', 'rival', 'milestoneKey');
  // The founders close the period.
  const { ctx, pair } = await operators();
  const ended = data(
    await ctx.edge.mutate(
      'campaigns',
      'ops.campaigns.transition',
      { id: campaignId, action: 'end', revision: 1 },
      await pair.a.campaignsOpsToken(),
    ),
    'end',
  );
  expect(ended.state).toBe('ended');
  await expect.poll(async () => (await boardOf(winner.who, campaignId)).settlement, { timeout: 120_000 }).not.toBeNull();
  const board = await boardOf(winner.who, campaignId);
  expect(board.closed).toBe(true);
  expect(board.settlement.winners).toEqual([
    { rank: 1, seat: 2, you: true, amount: PRIZES[0].amount },
    { rank: 2, seat: 1, you: false, amount: PRIZES[1].amount },
  ]);
  // Prizes + remainder reconcile to the pool: two places and one milestone.
  const total = sumDecimal([PRIZES[0].amount, PRIZES[1].amount, MILESTONE.amount]);
  expect(board.settlement.prizesTotal).toBe(total);
  expect(sumDecimal([board.settlement.prizesTotal, board.settlement.remainder])).toBe(POOL);
  const prizes = [
    { p: winner, key: `competition:${campaignId}:1:`, amount: PRIZES[0].amount, place: true },
    { p: winner, key: milestoneKey, amount: MILESTONE.amount, place: false },
    { p: rival, key: `competition:${campaignId}:1:`, amount: PRIZES[1].amount, place: true },
  ];
  const rowOf = async ({ p, key, place }) =>
    (await myRewards(p.who)).filter((r) => (place ? r.rewardKey.startsWith(key) && !r.rewardKey.endsWith(':m1') : r.rewardKey === key));
  for (const prize of prizes) {
    await expect.poll(async () => (await rowOf(prize)).map((r) => r.state), { timeout: 240_000 }).toEqual(['paid']);
  }
  // Settled and paid once: read once all three are paid, so the service's settle and payment passes ran between the
  // first and the last; still one record each, owed once and paid once, and the TEST chain's own receipt shows exactly
  // one transfer of exactly the prize to the winner's connected wallet.
  for (const prize of prizes) {
    const rows = await rowOf(prize);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ asset: ASSET, amount: prize.amount, state: 'paid' });
    expect(row.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
    expect(row.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
    expect(row.payout?.toWallet).toBe(prize.p.wallet);
    expect(row.payout.chainTx).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = await chainReceipt(row.payout.chainTx);
    expect(receipt.transfers.filter((t) => t.to === prize.p.wallet)).toEqual([
      { token: TOKEN_USD.address, from: receipt.from, to: prize.p.wallet, value: usdUnits(prize.amount) },
    ]);
    prize.chainTx = row.payout.chainTx;
    prize.rewardKey = row.rewardKey;
  }
  expect(new Set(prizes.map((p) => p.chainTx)).size).toBe(3);
  // On screen: the competition's results, and the winner's prizes in My Rewards with their chain reference.
  const page = await (await browser.newContext()).newPage();
  await signIn(page, winner.who);
  const room = await openCompetition(page, campaignId);
  await expect(room).toHaveAttribute('data-closed', 'true');
  await expect(room.getByTestId('competition-you-won')).toContainText(`You won place #1: ${PRIZES[0].amount} ${ASSET}`);
  await expect(room.getByTestId('competition-winner')).toHaveCount(2);
  await page.goto('/uc/promotion');
  for (const prize of prizes.filter((x) => x.p === winner)) {
    const row = page.locator(`[data-testid="reward-row"][data-reward-key="${prize.rewardKey}"]`);
    await expect(row).toHaveAttribute('data-state', 'paid', { timeout: 30_000 });
    await expect(row.getByTestId('reward-chain-tx')).toHaveAttribute('data-tx', prize.chainTx);
    await expect(row.getByTestId('reward-amount')).toContainText(prize.amount);
  }
});
