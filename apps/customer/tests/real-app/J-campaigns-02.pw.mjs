// World: book, restart, stack
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain, walletSection } from './dex.mjs';
import { api, fund, journeyState, signOutBrowser, signUpInBrowser, STACK_PORTS, stackUrl, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { testDeposit, venueForThisFile } from './venue.mjs';
import { chainEth, chainReceipt, chainUsd, mineBlocks, rewardFunds } from './reward-funds.mjs';

// J-campaigns-02, in the running app (docs/roadmap/journeys.json): finish a task campaign and receive the reward.
// One test per step, titled "J-campaigns-02 #<n>", run in order. The launch money model (OWNER 226, OWNER 288): the reward
// is INTAFACED's own money, owed once in the ledger and paid once in USDC to the customer's own connected wallet on the
// stack's TEST chain; it is never credited to a balance of theirs. The task campaign is this run's TEST campaign, made by
// the stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates).
// Its first step is a USDC deposit from the customer's own TEST wallet into the venue account that wallet owns, read from
// the venue (the TEST venue, on for this file); the other two complete only from svc-trade's settled fills on the bus
// (the customer trades BTC/USDT against the stack's market maker). Its claim needs full verification; the customer starts
// with basic, which trading needs. The campaign's budget is INTAFACED's TEST USDC reward pot, funded by the founders from
// builder fees the TEST venue credited us on this file's own sells; the payment leaves INTAFACED's TEST rewards wallet,
// which those fees are moved to (reward-funds.mjs). The reconciler interval, the hold, the rollback window and the reward
// ceiling are the stack's labelled TEST values (tooling/profiles/test-owner-values/campaigns.json).
const J = 'J-campaigns-02';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SYMBOL = 'BTC/USDT';
const TRADE = '0.001';
const ASSET = 'USDC';
const REWARD = '0.01';
const BUDGET = '0.05';
/** The TEST USDC #1 deposits from the wallet into the venue account. */
const DEPOSIT = '25';
/** The review hold on the main campaign: long enough to see the reward owed before it is paid. */
const HOLD_SECONDS = 25;

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

const DAY = 86_400_000;

/** A TEST task campaign paying TEST USDC: every field the activation gate needs is set. */
const definition = (name, tasks, over = {}) => ({
  name,
  type: 'task',
  rules: `TEST rules for ${name}: do the steps, then claim. The reward is TEST ${ASSET}, paid to your connected wallet.`,
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 14 * DAY).toISOString(),
  participation: { exclusions: [], regionScope: 'platform' },
  budget: { asset: ASSET, limit: BUDGET },
  // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: { asset: ASSET, amount: REWARD },
  tasks,
  ...over,
});

const THREE_STEPS = {
  steps: [
    { title: 'TEST deposit USDC from your wallet', event: 'pay.deposit', market: null, side: null, count: 1 },
    { title: 'TEST buy BTC', event: 'trade.fill', market: SYMBOL, side: 'buy', count: 1 },
    { title: 'TEST sell BTC', event: 'trade.fill', market: SYMBOL, side: 'sell', count: 1 },
  ],
  claimWindowSeconds: 3600,
  holdSeconds: HOLD_SECONDS,
  kycGate: 'full',
};
const ONE_TRADE = (over = {}) => ({
  steps: [{ title: 'TEST trade once', event: 'trade.fill', market: SYMBOL, side: null, count: 1 }],
  claimWindowSeconds: 3600,
  holdSeconds: 0,
  kycGate: 'basic',
  ...over,
});

async function liveCampaign(name, tasks, over = {}) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const made = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.create', definition(name, tasks, over), a), 'ops.campaigns.create');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'submit', revision: 1 }, a), 'submit');
  data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'approve', revision: 1 }, b), 'approve');
  const live = data(
    await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id: made.id, action: 'activate', revision: 1 }, a),
    'activate',
  );
  expect(live.state).toBe('active');
  return live;
}

const person = (handle) => ({
  handle,
  email: `${handle}@local-test.invalid`,
  password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
});

/** Asks for a verification level on /verification; the two TEST operators approve it (local-test-gates.mjs verify). */
async function verifyAs(page, who, level, tier) {
  await signIn(page, who);
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: level });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  const status = tool('local-test-gates.mjs', 'status');
  expect(JSON.parse(status.slice(status.indexOf('{'))).accounts.find((a) => a.handle === who.handle)?.tiers).toContain(tier);
  await signOutBrowser(page.context());
}

/** One TEST market order on the real book, through the customer's own API: it fills against the market maker. */
async function trade(who, side) {
  const client = await api(who);
  const res = await client.post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side,
    amount: TRADE,
    clientOrderId: `${J}-${side}-${Date.now()}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
}

const trpc = (procedure, input) => `/api/campaigns/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
async function call(who, method, procedure, input) {
  const client = await api(who);
  const res = method === 'GET' ? await client.get(trpc(procedure, input)) : await client.post(`/api/campaigns/trpc/${procedure}`, input);
  if (!res.body?.result) throw new Error(`${procedure} refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}
const progressOf = (who, campaignId) => call(who, 'GET', 'tasks.progress', { campaignId });
const mine = (who) => call(who, 'GET', 'rewards.mine', {});

/** Waits until svc-campaigns has counted the steps: they count from events and the venue's record, never from this test. */
async function waitForProgress(who, campaignId, done) {
  await expect.poll(async () => (await progressOf(who, campaignId)).completed, { timeout: 45_000 }).toBe(done);
}

/**
 * The same fill event delivered to svc-campaigns twice more: the customer's newest trade.fill.settled on the stack's bus,
 * published again with its payload unchanged (same fill id) under new envelope keys, so the bus does not drop it as its
 * own duplicate and the campaign's consumer is what must hold. Returns the payload.
 */
function redeliverFill(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.fillSettled.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(EVENT_CATALOG.fillSettled.service, prefix);
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
    for (const n of [1, 2]) {
      await bus.publish('fillSettled', payload, { idempotencyKey: payload.fillId + ':again:' + n + ':' + Date.now() });
    }
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: `nats://127.0.0.1:${STACK_PORTS.nats}`, NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the fill event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-campaigns' task fill consumer has taken and acknowledged every message on the bus. */
async function fillConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch(`${stackUrl('natsMonitor')}/jsz?consumers=true`).then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .filter((st) => st.name === 'LOCAL_TEST_TRADE')
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'campaigns-task-fill-settled');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

async function openCampaign(page, id) {
  await page.goto(`/campaigns/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('campaign-detail')).toBeVisible();
  await expect(page.getByTestId('task-progress')).toBeVisible({ timeout: 30_000 });
}

// ── The person's own TEST wallet, connected to their account, and the deposit into its venue account ─────────────────

const sheet = (page) => page.locator('[data-sheet="sign"]');
const venueAction = (page, name) => page.getByRole('region', { name: 'Venue actions' }).getByRole('button', { name });

/** Signed in, with the TEST wallet in this page, on Wallet's Venue account tab, the browser wallet connected. */
async function openVenue(page, who, privateKey) {
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  return wallet;
}

async function connectAndSign(page, button = 'Connect to my account') {
  await page.getByRole('button', { name: button }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** The stack's TEST connection lasts 60 s: a signed action needs this much of it left. */
const CONNECTION_MARGIN_MS = 45_000;
async function connectedNow(page) {
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
  if (await page.getByRole('heading', { name: 'Connected' }).isVisible()) {
    const expiresAt = Date.parse(await page.getByTestId('venue-connection-expires').getAttribute('datetime'));
    if (expiresAt - Date.now() > CONNECTION_MARGIN_MS) return;
    await expect(page.getByRole('heading', { name: 'Connection expired' })).toBeVisible({ timeout: CONNECTION_MARGIN_MS + 15_000 });
  }
  if (await page.getByRole('button', { name: 'Sign again' }).isVisible()) await connectAndSign(page, 'Sign again');
  if (await page.getByRole('button', { name: 'Connect to my account' }).isVisible()) await connectAndSign(page);
}

/** The person's wallets as svc-protocol records them, through Edge. */
async function connections(who) {
  const { status, body } = await (await api(who)).get('/api/protocol/trpc/venueWallet.status');
  if (status !== 200) throw new Error(`venueWallet.status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data.connections;
}

/** INTAFACED's TEST rewards wallet: the one the payment came from, as the chain's receipt names its sender. */
const walletKeyOf = (who) => keccak256(toHex(`intafaced TEST rewards wallet ${J} ${RUN} ${who.handle}`));

/** The reward's row on My Rewards (/uc/promotion). */
async function openHub(page) {
  await page.goto('/uc/promotion');
  const hub = page.getByTestId('rewards-hub');
  await expect(hub).toBeVisible();
  await expect(hub).not.toHaveAttribute('data-state', 'loading', { timeout: 30_000 });
  return hub;
}
const hubRow = (hub, campaignId) => hub.locator(`[data-testid="reward-row"][data-campaign="${campaignId}"]`);

/** Adds decimal strings exactly. */
function addExact(...values) {
  const scale = 18;
  const units = (x) => {
    const [w, f = ''] = String(x).split('.');
    return BigInt(w + f.padEnd(scale, '0'));
  };
  return values.reduce((n, v) => n + units(v), 0n);
}

/** TEST USD units of a USDC decimal amount (6 decimals). */
const usdUnits = (amount) => addExact(amount) / 10n ** 12n;

/**
 * INTAFACED's TEST USDC reward pot and TEST rewards wallet funded from builder fees this file earns on the TEST venue:
 * enough for every reward this file claims.
 */
async function fundRewards(who) {
  const fees = await funds.earnBuilderFees(who, 3);
  await funds.fundPotFromFees(`TEST-${J}-${tag}`, fees);
  await funds.claimOurBuilderFees();
}

/** Paid exactly once: owed once, paid once, one My Rewards row, and the chain shows one transfer to the wallet. */
async function paidOnce(who, campaignId, wallet) {
  const reward = (await progressOf(who, campaignId)).reward;
  expect(reward.state).toBe('paid');
  expect(reward.attempts.filter((a) => a.outcome === 'owed')).toHaveLength(1);
  expect(reward.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
  const rows = (await mine(who)).rewards.filter((r) => r.campaignId === campaignId);
  expect(rows).toHaveLength(1);
  expect(rows[0].payout?.chainTx).toBe(reward.payout.chainTx);
  expect(reward.payout.toWallet).toBe(wallet);
  const receipt = await chainReceipt(reward.payout.chainTx);
  const toWallet = receipt.transfers.filter((t) => t.to === wallet);
  expect(toWallet).toEqual([{ token: TOKEN_USD.address, from: receipt.from, to: wallet, value: usdUnits(reward.amount) }]);
  return { reward, receipt };
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`${J} #1 does the first step by its real event, a deposit of TEST USDC from the wallet into the venue account: progress shows 1 of 3, the deposit read from the venue; the same event delivered twice changes nothing`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  run.reset({});
  expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
  const me = person(`jc02me${tag}`.slice(0, 20));
  await signUpInBrowser(page, me);
  await signOutBrowser(page.context());
  // Basic verification is what trading needs; the campaign's claim needs full, which comes in #3.
  await verifyAs(page, me, 'Basic', 'basic');
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  expect(fund(me.email, 'BTC', '0.01').tx).toBeTruthy();
  // Starts: a wallet connected. The person's own TEST wallet (a key kept in this run's state, holding nothing real).
  const walletKey = walletKeyOf(me);
  const wallet = privateKeyToAccount(walletKey).address.toLowerCase();
  fundOnTestChain(wallet, 'venue');
  // The TEST wallet is installed once per page, so each wallet visit has its own browser context.
  const walletPage = async () => (await browser.newContext()).newPage();
  const connecting = await walletPage();
  await openVenue(connecting, me, walletKey);
  await connectAndSign(connecting);
  expect((await connections(me)).map((c) => [c.address.toLowerCase(), c.status])).toEqual([[wallet, 'live']]);
  await connecting.context().close();
  const campaign = await liveCampaign(`TEST three steps ${tag}`, THREE_STEPS);
  run.write({ me, walletKey, wallet, campaignId: campaign.id });

  await signIn(page, me);
  await openCampaign(page, campaign.id);
  await expect(page.getByTestId('task-progress')).toHaveText('Join this campaign to start counting your steps.');
  await page.getByRole('button', { name: `Join ${campaign.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await expect(page.getByTestId('task-progress')).toHaveText('0 of 3 steps done');
  await expect(page.getByTestId('task-gate')).toHaveText('Full verification');
  // Nothing deposited yet: the deposit step is open, and the venue was read for it.
  await page.reload();
  await expect(page.getByTestId('task-deposit-source')).toHaveAttribute('data-source', 'read', { timeout: 30_000 });
  await expect(page.getByTestId('task-step').nth(0)).toHaveAttribute('data-complete', 'false');

  // The person deposits from their own wallet into their venue account: they sign it in the wallet.
  const depositing = await walletPage();
  const signer = await openVenue(depositing, me, walletKey);
  await connectedNow(depositing);
  await depositing.getByRole('region', { name: 'Venue actions' }).getByLabel('Amount').fill(DEPOSIT);
  await venueAction(depositing, 'Deposit TEST USDC').click();
  await sheet(depositing).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => signer.sends.length).toBe(1);
  expect(signer.sends[0].method).toBe('eth_sendTransaction');
  await expect(depositing.getByTestId('venue-deposit')).toBeVisible();
  // The TEST venue credits after 3 confirmations, and the stack's anvil mines a block per transaction only.
  await mineBlocks(2);
  await expect(depositing.getByTestId('venue-deposit')).toHaveText(`The venue credited ${DEPOSIT} TEST USDC.`, { timeout: 60_000 });
  await depositing.context().close();

  // The venue's own record of the deposit: the step counts from it, at the moment the venue saw it.
  const venueRead = await (await api(me)).get(`/api/v1/venue/deposits?owner=${wallet}`);
  const credited = venueRead.body.value.filter((d) => d.status === 'credited');
  expect(credited).toHaveLength(1);
  expect(credited[0]).toMatchObject({ asset: ASSET, amount: DEPOSIT });
  await waitForProgress(me, campaign.id, 1);
  const first = await progressOf(me, campaign.id);
  expect(first.steps.map((s) => s.done)).toEqual([1, 0, 0]);
  expect(first.deposit.source).toBe('read');
  await openCampaign(page, campaign.id);
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 3 steps done');
  const steps = page.getByTestId('task-step');
  await expect(steps.nth(0)).toHaveAttribute('data-complete', 'true');
  await expect(steps.nth(1)).toHaveAttribute('data-complete', 'false');
  await expect(steps.nth(2)).toHaveAttribute('data-complete', 'false');
  await expect(page.getByTestId('task-deposit-source')).toHaveAttribute('data-source', 'read');
  await expect(page.getByTestId('task-deposit-source')).toContainText('Deposits read from the venue at');

  // The same transfer reported to the venue again credits nothing, and every look reads the venue's deposits again
  // (svc-campaigns reads the venue on each look, the deposit fact delivered to it again, with a later as-of time): the
  // step stays counted once.
  expect(await testDeposit(wallet, ASSET, DEPOSIT, credited[0].depositRef)).toBe(false);
  let asOf = first.deposit.asOf;
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 1_100));
    const again = await progressOf(me, campaign.id);
    expect(again.deposit.source).toBe('read');
    expect(Date.parse(again.deposit.asOf)).toBeGreaterThan(Date.parse(asOf));
    asOf = again.deposit.asOf;
    expect(again.steps).toEqual(first.steps);
  }
  await page.reload();
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 3 steps done');
  // The ledger posts nothing for the deposit: the person holds no USDC of ours in any balance.
  expect((await (await api(me)).balances())[ASSET]?.free ?? '0').toBe('0');
});

test(`${J} #2 finishes the last step and presses Claim before the identity check is done: a typed refusal naming the KYC gate; nothing about my documents is stored in the campaign`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { me, campaignId } = state('me', 'campaignId');
  await trade(me, 'buy');
  await waitForProgress(me, campaignId, 2);
  // The same fill event reaches svc-campaigns twice more on the bus: it is counted once.
  const fill = redeliverFill((await api(me)).userId);
  expect(fill).toMatchObject({ side: 'buy' });
  await fillConsumerCaughtUp();
  expect((await progressOf(me, campaignId)).steps.map((s) => s.done)).toEqual([1, 1, 0]);
  await trade(me, 'sell');
  await waitForProgress(me, campaignId, 3);
  await signIn(page, me);
  await openCampaign(page, campaignId);
  await expect(page.getByTestId('task-progress')).toHaveText('3 of 3 steps done');
  await expect(page.getByTestId('task-claim-by')).toBeVisible();
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  const refusal = page.getByTestId('task-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'campaigns.kyc_required');
  await expect(refusal).toContainText('This reward needs Full verification before it can be claimed');
  await expect(refusal).toContainText('Nothing about your documents is kept by this campaign.');
  // Nothing was written: no reward, and nothing from the identity check (tier, country, documents) is in the record.
  const after = await progressOf(me, campaignId);
  expect(after.reward).toBeNull();
  expect(JSON.stringify(after)).not.toMatch(/kycTier|tier"|country|document|"DE"/i);
  expect((await mine(me)).rewards.filter((r) => r.campaignId === campaignId)).toHaveLength(0);
  await page.reload();
  await expect(page.getByTestId('task-reward-none')).toBeVisible();
});

test(`${J} #3 claims inside the claim window: one reward intent; the status reads "qualified", then "owed", then "paid" with the chain transaction link; with no wallet connected it stays owed and asks me to connect one`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const { me, campaignId, wallet } = state('me', 'campaignId', 'wallet');
  await verifyAs(page, me, 'Full', 'full');
  // Starts: INTAFACED's campaign budget funded (TEST). The pot and the rewards wallet hold our TEST builder fees.
  await fundRewards(me);
  const budgetBefore = (await progressOf(me, campaignId)).budget;
  expect(budgetBefore).toEqual({ asset: ASSET, limit: BUDGET, reserved: '0', spent: '0', left: BUDGET });

  await signIn(page, me);
  await openCampaign(page, campaignId);
  await expect(page.getByTestId('task-budget')).toHaveAttribute('data-reserved', '0');
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  const reward = page.getByTestId('task-reward');
  await expect(reward).toBeVisible();
  // One reward intent, under the business key of campaign, account and task: qualified, then owed by INTAFACED.
  const claimed = (await progressOf(me, campaignId)).reward;
  expect(claimed.rewardKey).toMatch(new RegExp(`^task:${campaignId}:[0-9a-f-]{36}:once$`));
  expect(claimed.attempts.map((a) => a.outcome).slice(0, 2)).toEqual(['qualified', 'owed']);
  expect(claimed.state).toBe('owed');
  expect(claimed.owed?.txId).toBeTruthy();
  await expect(reward).toHaveAttribute('data-state', 'owed');
  await expect(page.getByTestId('task-reward-state')).toHaveText('Owed to you by INTAFACED: not in your wallet');
  await expect(page.getByTestId('task-reward-held-until')).toBeVisible();
  await expect(page.getByTestId('task-reward-chain-tx')).toHaveCount(0);
  // Owed, never spendable: the reservation holds the budget, and no balance of the person's has it.
  expect((await progressOf(me, campaignId)).budget).toEqual({ asset: ASSET, limit: BUDGET, reserved: REWARD, spent: '0', left: '0.04' });
  expect((await (await api(me)).balances())[ASSET]?.free ?? '0').toBe('0');
  const walletUsd = await chainUsd(wallet);
  const walletEth = await chainEth(wallet);

  // The hold ends; the reward is paid once to the connected wallet, and the screen reads paid with the chain link.
  await expect.poll(async () => (await progressOf(me, campaignId)).reward.state, { timeout: 120_000 }).toBe('paid');
  await page.reload();
  await expect(reward).toHaveAttribute('data-state', 'paid');
  await expect(page.getByTestId('task-reward-state')).toHaveText('Paid to your connected wallet');
  const { reward: paid, receipt } = await paidOnce(me, campaignId, wallet);
  const link = page.getByTestId('task-reward-chain-tx');
  await expect(link).toHaveAttribute('data-tx', paid.payout.chainTx);
  await expect(link).toHaveAttribute('href', `/chain/tx/${paid.payout.chainTx}`);
  await expect(page.getByTestId('task-reward-paid-to')).toHaveAttribute('data-wallet', wallet);
  expect(paid.attempts.map((a) => a.outcome)).toEqual(['qualified', 'owed', 'released', 'paid']);
  // The reservation moved to spent once, and reserved, spent and left add up to the budget exactly.
  const budget = (await progressOf(me, campaignId)).budget;
  expect(budget).toEqual({ asset: ASSET, limit: BUDGET, reserved: '0', spent: REWARD, left: '0.04' });
  expect(addExact(budget.reserved, budget.spent, budget.left)).toBe(addExact(BUDGET));
  await expect(page.getByTestId('task-budget')).toHaveAttribute('data-spent', REWARD);
  // The wallet's balance is the chain's: it rose by exactly the reward. The network fee was INTAFACED's: the payment was
  // sent from our wallet, the person's TEST ETH did not move, and the fee shown is the one the chain's receipt states.
  expect(await chainUsd(wallet)).toBe(walletUsd + usdUnits(REWARD));
  expect(await chainEth(wallet)).toBe(walletEth);
  expect(receipt.from).not.toBe(wallet);
  expect(paid.payout.networkFee).toMatchObject({ asset: 'ETH', paidBy: 'intafaced' });
  expect(addExact(paid.payout.networkFee.amount)).toBe(receipt.fee);
  await expect(page.getByTestId('task-reward-network-fee')).toContainText('paid by INTAFACED, not taken from your reward');
  // Still the person's ledger: never a balance of the reward.
  expect((await (await api(me)).balances())[ASSET]?.free ?? '0').toBe('0');
  run.write({ rewardKey: paid.rewardKey, chainTx: paid.payout.chainTx });

  // With no wallet connected: another TEST person finishes a one-step campaign and claims; it stays owed, nothing is
  // sent, and the screen asks them to connect one.
  const otherPage = await (await browser.newContext()).newPage();
  const other = person(`jc02nw${tag}`.slice(0, 20));
  await signUpInBrowser(otherPage, other);
  await signOutBrowser(otherPage.context());
  await verifyAs(otherPage, other, 'Basic', 'basic');
  expect(fund(other.email, 'USDT', '500').tx).toBeTruthy();
  const noWallet = await liveCampaign(`TEST no wallet ${tag}`, ONE_TRADE());
  await call(other, 'POST', 'participation.join', { campaignId: noWallet.id });
  await trade(other, 'buy');
  await waitForProgress(other, noWallet.id, 1);
  expect(await connections(other)).toEqual([]);
  await signIn(otherPage, other);
  await openCampaign(otherPage, noWallet.id);
  await otherPage.getByRole('button', { name: 'Claim the reward' }).click();
  await expect
    .poll(async () => (await progressOf(other, noWallet.id)).reward?.reason, { timeout: 30_000 })
    .toBe('campaigns.no_connected_wallet');
  await otherPage.reload();
  await expect(otherPage.getByTestId('task-reward')).toHaveAttribute('data-state', 'owed');
  const why = otherPage.getByTestId('task-reward-why');
  await expect(why).toHaveAttribute('data-reason', 'campaigns.no_connected_wallet');
  await expect(why).toContainText('No wallet is connected, so it stays owed to you and nothing was sent. Connect your wallet to be paid.');
  await expect(why.getByRole('link', { name: 'Connect a wallet' })).toHaveAttribute('href', '/wallet/venue');
  // A few payer passes later it is still owed, with no payment.
  await otherPage.waitForTimeout(8_000);
  expect((await progressOf(other, noWallet.id)).reward).toMatchObject({ state: 'owed', payout: null });
  run.write({ other, noWalletId: noWallet.id });
});

test(`${J} #4 presses Claim again, or loses the reply: the same reward; the screen re-reads instead of repeating`, async ({ page }) => {
  test.setTimeout(240_000);
  const { me, campaignId, rewardKey, chainTx, wallet } = state('me', 'campaignId', 'rewardKey', 'chainTx', 'wallet');
  // Claim again, through the API: the first reward comes back as it stands, nothing new is created or paid.
  const again = await call(me, 'POST', 'tasks.claim', { campaignId });
  expect(again.created).toBe(false);
  expect(again.reward.rewardKey).toBe(rewardKey);
  expect(again.reward.payout.chainTx).toBe(chainTx);
  await signIn(page, me);
  await openCampaign(page, campaignId);
  await expect(page.getByTestId('task-reward')).toHaveAttribute('data-reward-key', rewardKey);
  await expect(page.getByRole('button', { name: 'Claim the reward' })).toHaveCount(0);

  // Losing the reply: a fresh one-step campaign, and the claim's answer is dropped on its way back to the screen after
  // svc-campaigns took it. The screen says it is checking and reads the reward again; it never claims twice.
  const lost = await liveCampaign(`TEST lost reply ${tag}`, ONE_TRADE({ kycGate: 'full' }));
  await call(me, 'POST', 'participation.join', { campaignId: lost.id });
  await trade(me, 'buy');
  await waitForProgress(me, lost.id, 1);
  await openCampaign(page, lost.id);
  let claims = 0;
  await page.route('**/api/campaigns/trpc/tasks.claim*', async (route) => {
    claims += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  await expect(page.getByTestId('task-checking')).toBeVisible();
  await expect(page.getByTestId('task-reward')).toBeVisible({ timeout: 30_000 });
  await page.unroute('**/api/campaigns/trpc/tasks.claim*');
  expect(claims).toBe(1);
  await expect(page.getByRole('button', { name: 'Claim the reward' })).toHaveCount(0);
  const first = (await progressOf(me, lost.id)).reward;
  const second = await call(me, 'POST', 'tasks.claim', { campaignId: lost.id });
  expect(second.created).toBe(false);
  expect(second.reward.rewardKey).toBe(first.rewardKey);
  // One reward, paid once.
  await expect.poll(async () => (await progressOf(me, lost.id)).reward.state, { timeout: 60_000 }).toBe('paid');
  await page.waitForTimeout(6_000);
  await paidOnce(me, lost.id, wallet);
  // The first campaign's reward still has its one payment.
  await paidOnce(me, campaignId, wallet);
});

test(`${J} #5 claims after the window closed: the claim-expired state, and the reward is forfeited`, async ({ page }) => {
  test.setTimeout(180_000);
  const { me } = state('me');
  const short = await liveCampaign(`TEST short window ${tag}`, ONE_TRADE({ claimWindowSeconds: 20, kycGate: 'full' }));
  await signIn(page, me);
  await openCampaign(page, short.id);
  await page.getByRole('button', { name: `Join ${short.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await trade(me, 'buy');
  await waitForProgress(me, short.id, 1);
  const closes = new Date((await progressOf(me, short.id)).claimClosesAt).getTime();
  await page.waitForTimeout(Math.max(0, closes - Date.now()) + 2_000);
  await page.reload();
  await expect(page.getByTestId('task-progress')).toHaveText('1 of 1 steps done');
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  await expect(page.getByTestId('task-refusal')).toHaveAttribute('data-code', 'campaigns.claim_expired');
  await page.reload();
  await expect(page.getByTestId('task-reward')).toHaveAttribute('data-state', 'forfeited');
  await expect(page.getByTestId('task-reward-state')).toHaveText('Forfeited: claimed after the claim window closed');
  // Forfeited: nothing owed, nothing paid, nothing held on the budget.
  const p = await progressOf(me, short.id);
  expect(p.reward).toMatchObject({ state: 'forfeited', reason: 'campaigns.claim_expired', owed: null, payout: null });
  expect(p.budget).toMatchObject({ reserved: '0', spent: '0', left: BUDGET });
});

test(`${J} #6 opens My Rewards and the connected wallet's activity: the reward owed, then paid once to the connected wallet, with its chain reference matching the reward record; the wallet shows the incoming transfer as the chain reports it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { me, wallet, walletKey } = state('me', 'wallet', 'walletKey');
  // A reward seen on My Rewards while it is owed, then paid: a fresh one-step campaign whose short review hold keeps it
  // owed long enough to look at (the pot and our rewards wallet were funded in #3).
  const hold = await liveCampaign(`TEST owed then paid ${tag}`, ONE_TRADE({ kycGate: 'full', holdSeconds: 30 }));
  await call(me, 'POST', 'participation.join', { campaignId: hold.id });
  await trade(me, 'buy');
  await waitForProgress(me, hold.id, 1);
  await call(me, 'POST', 'tasks.claim', { campaignId: hold.id });
  await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 30_000 }).toBe('owed');
  await signIn(page, me);
  const owedHub = await openHub(page);
  const owedRow = hubRow(owedHub, hold.id);
  // Owed: INTAFACED owes it, it is in no wallet yet, and the row carries no chain transaction.
  await expect(owedRow).toHaveCount(1);
  await expect(owedRow).toHaveAttribute('data-status', 'on_hold');
  await expect(owedRow.getByTestId('reward-amount')).toHaveText(`${REWARD} ${ASSET}`);
  await expect(owedRow.getByTestId('reward-why')).toContainText('Owed to you by INTAFACED.');
  await expect(owedRow.getByTestId('reward-why')).toContainText('it is paid to your connected wallet after that');
  await expect(owedRow.getByTestId('reward-chain-tx')).toHaveCount(0);

  // Then paid once to the connected wallet: the same row now carries the payment's chain transaction, the record's.
  await expect.poll(async () => (await progressOf(me, hold.id)).reward.state, { timeout: 120_000 }).toBe('paid');
  await page.waitForTimeout(6_000);
  const { reward, receipt } = await paidOnce(me, hold.id, wallet);
  const chainTx = reward.payout.chainTx;
  expect(Date.parse(reward.owed.at)).toBeLessThan(Date.parse(reward.payout.at));
  const hub = await openHub(page);
  const row = hubRow(hub, hold.id);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-status', 'paid');
  await expect(row.getByTestId('reward-amount')).toHaveText(`${REWARD} ${ASSET}`);
  await expect(row.getByTestId('reward-why')).toContainText('Paid to your connected wallet');
  await expect(row.getByTestId('reward-chain-tx')).toHaveAttribute('data-tx', chainTx);
  await expect(row.getByTestId('reward-chain-tx')).toHaveAttribute('href', `/chain/tx/${chainTx}`);
  // The rewards from #3 and #4 are listed once each too, each paid with its own chain transaction.
  const { campaignId, chainTx: firstTx } = state('campaignId', 'chainTx');
  await expect(hubRow(hub, campaignId)).toHaveAttribute('data-status', 'paid');
  await expect(hubRow(hub, campaignId).getByTestId('reward-chain-tx')).toHaveAttribute('data-tx', firstTx);

  // The wallet's own activity, read from the chain's index: one incoming TEST USD transfer under the same transaction.
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await walletSection(page, 'Activity');
  const table = page.getByRole('region', { name: 'Activity' }).getByRole('table');
  const activity = table.locator(`tr[data-activity-row="${chainTx.toLowerCase()}"]`);
  await expect(activity).toHaveCount(1, { timeout: 60_000 });
  // As the chain reports it: received, the exact amount the receipt's transfer carries, confirmed.
  const transfer = receipt.transfers.find((t) => t.to === wallet);
  const shown = (Number(transfer.value) / 1e6).toString();
  await expect(activity).toContainText(`You received ${shown}`);
  await expect(activity).toContainText('Confirmed');
  await expect(activity.locator(`a[href="/chain/tx/${chainTx.toLowerCase()}"]`)).toHaveCount(1);
});

test(`${J} #7 opens the redemption log of the reward: the outcome, failure reason if any, the chain reference once paid, and the rollback window, which closes when the reward is paid`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { me, campaignId, chainTx, other, noWalletId } = state('me', 'campaignId', 'chainTx', 'other', 'noWalletId');
  await signIn(page, me);
  await openCampaign(page, campaignId);
  const log = page.getByRole('region', { name: 'Redemption log' });
  await expect(log).toBeVisible();
  const line = (outcome) => log.locator(`[data-testid="redemption-attempt"][data-outcome="${outcome}"]`);
  // The outcome, line by line: qualified, owed, the hold ended, paid; with no failure, each reason reads None.
  await expect(log.getByTestId('redemption-attempt')).toHaveCount(4);
  for (const outcome of ['qualified', 'owed', 'released', 'paid']) await expect(line(outcome)).toHaveCount(1);
  await expect(log.getByTestId('redemption-reason')).toHaveText(['None', 'None', 'None', 'None']);
  // The chain reference once paid: the payment line names the transaction that paid it, and only that line names one.
  await expect(line('paid').getByTestId('redemption-chain-tx')).toHaveAttribute('data-tx', chainTx);
  await expect(line('paid').getByTestId('redemption-chain-tx')).toHaveText(chainTx);
  for (const outcome of ['qualified', 'owed', 'released']) await expect(line(outcome).getByTestId('redemption-chain-tx')).toHaveText('—');
  // The rollback window closes when the reward is paid: closed now, at the payment's time.
  const reward = (await progressOf(me, campaignId)).reward;
  const rollback = page.getByTestId('task-rollback');
  await expect(rollback).toHaveAttribute('data-closes-on', 'payment');
  await expect(rollback).toHaveAttribute('data-closes-at', reward.payout.at);
  await expect(rollback).toHaveAttribute('data-open', 'false');
  await expect(rollback).toContainText('closed when the reward was paid to your wallet, on');
  await expect(rollback).toHaveAttribute('data-code', 'campaigns.reclaim_unavailable');

  // A failure reason, in the log itself: a reward past INTAFACED's TEST reward ceiling (100 USDC a campaign) is refused
  // by the ledger, and its log line names the ledger's reason; it stays open and is never paid.
  const over = await liveCampaign(`TEST over the ceiling ${tag}`, ONE_TRADE({ kycGate: 'full' }), {
    budget: { asset: ASSET, limit: '200' },
    reward: { asset: ASSET, amount: '101' },
  });
  await call(me, 'POST', 'participation.join', { campaignId: over.id });
  await trade(me, 'buy');
  await waitForProgress(me, over.id, 1);
  await call(me, 'POST', 'tasks.claim', { campaignId: over.id });
  await expect
    .poll(async () => (await progressOf(me, over.id)).reward.attempts.some((a) => a.outcome === 'refused'), { timeout: 30_000 })
    .toBe(true);
  await openCampaign(page, over.id);
  const overLog = page.getByRole('region', { name: 'Redemption log' });
  const refused = overLog.locator('[data-testid="redemption-attempt"][data-outcome="refused"]').first();
  await expect(refused).toContainText('Refused, still open');
  await expect(refused.getByTestId('redemption-reason')).toHaveText('ledger.reward_ceiling_exceeded');
  await expect(refused.getByTestId('redemption-chain-tx')).toHaveText('—');
  await expect(overLog.locator('[data-outcome="paid"]')).toHaveCount(0);
  expect((await progressOf(me, over.id)).reward).toMatchObject({ reason: 'ledger.reward_ceiling_exceeded', payout: null });

  // A reward not paid yet keeps its window open until it is paid, and its log names why nothing was sent.
  await signOutBrowser(page.context());
  await signIn(page, other);
  await openCampaign(page, noWalletId);
  const open = page.getByTestId('task-rollback');
  await expect(open).toHaveAttribute('data-closes-on', 'payment');
  await expect(open).toHaveAttribute('data-open', 'true');
  await expect(open).toContainText('open until the reward is paid to your wallet, at most 1 day, until');
  await expect(page.getByTestId('task-reward-why')).toHaveAttribute('data-reason', 'campaigns.no_connected_wallet');
  await expect(page.getByRole('region', { name: 'Redemption log' }).locator('[data-outcome="paid"]')).toHaveCount(0);
});

test(`${J} #8 misses a day in a streak task: the streak resets at the zone boundary`, async ({ page }) => {
  test.setTimeout(240_000);
  const { me } = state('me');
  // A streak step: trade on three days in a row, days read in the platform time zone (the stack's TEST zone is UTC).
  const streak = await liveCampaign(
    `TEST streak ${tag}`,
    {
      steps: [{ title: 'TEST trade three days in a row', event: 'trade.fill', market: SYMBOL, side: null, count: 1, streakDays: 3 }],
      claimWindowSeconds: 3600,
      holdSeconds: 0,
      kycGate: 'full',
    },
    { startsAt: new Date(Date.now() - 7 * DAY).toISOString() },
  );
  await signIn(page, me);
  await openCampaign(page, streak.id);
  await page.getByRole('button', { name: `Join ${streak.name}` }).click();
  await expect(page.getByTestId('campaign-joined')).toBeVisible();
  await trade(me, 'buy');
  await expect.poll(async () => (await progressOf(me, streak.id)).steps[0].streak.days, { timeout: 30_000 }).toBe(1);
  await page.reload();
  const run1 = page.getByTestId('task-streak');
  await expect(page.getByTestId('task-step').first()).toContainText('1 of 3 days in a row');
  await expect(run1).toHaveAttribute('data-reset', 'false');
  await expect(run1).toContainText('Your streak resets at');
  // The boundary is midnight in the platform time zone (UTC on this stack) after the next day: a run whose last day is
  // D lives through D+1 and resets at D+2 00:00.
  const midnightAfter = (day, n) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString();
  const today = (await progressOf(me, streak.id)).steps[0].streak;
  // The trade's day: today, or yesterday if UTC midnight passed since the trade.
  expect([new Date().toISOString().slice(0, 10), new Date(Date.now() - DAY).toISOString().slice(0, 10)]).toContain(today.lastDay);
  expect(today.resetsAt).toBe(midnightAfter(today.lastDay, 2));

  // One side of the boundary (LOCAL TEST fixture): that trading day becomes yesterday, so today is still inside the run
  // and its reset moves to tomorrow's midnight.
  expect(tool('local-test-stack.mjs', 'age-task-progress', me.email, streak.id, '1')).toContain('1 join(s) and 1 counted event(s)');
  const yesterday = (await progressOf(me, streak.id)).steps[0].streak;
  expect(yesterday).toMatchObject({ days: 1, reset: false, lastDay: midnightAfter(today.lastDay, -1).slice(0, 10) });
  expect(yesterday.resetsAt).toBe(midnightAfter(today.lastDay, 1));
  expect(Date.parse(yesterday.resetsAt)).toBeGreaterThan(Date.now());

  // The other side: one day more makes it two days ago, so yesterday was missed and the run ended at last midnight.
  expect(tool('local-test-stack.mjs', 'age-task-progress', me.email, streak.id, '1')).toContain('1 join(s) and 1 counted event(s)');
  await page.reload();
  const reset = page.getByTestId('task-streak');
  await expect(reset).toHaveAttribute('data-reset', 'true');
  await expect(reset).toHaveAttribute('data-days', '0');
  await expect(reset).toHaveAttribute('data-best', '1');
  await expect(reset).toContainText('Streak reset');
  await expect(reset).toContainText('the run ended at midnight in the platform time zone (days in it: 1)');
  await expect(page.getByTestId('task-step').first()).toContainText('0 of 3 days in a row');
  const p = await progressOf(me, streak.id);
  expect(p.steps[0]).toMatchObject({ done: 0, complete: false, streak: { days: 0, best: 1, lastRun: 1, reset: true, resetsAt: null } });

  // Trading again starts a new run of one day; the claim stays closed until three days in a row are done.
  await trade(me, 'sell');
  await expect.poll(async () => (await progressOf(me, streak.id)).steps[0].streak.days, { timeout: 30_000 }).toBe(1);
  await page.reload();
  await expect(page.getByTestId('task-streak')).toHaveAttribute('data-reset', 'false');
  await page.getByRole('button', { name: 'Claim the reward' }).click();
  await expect(page.getByTestId('task-refusal')).toHaveAttribute('data-code', 'campaigns.tasks_incomplete');
});
