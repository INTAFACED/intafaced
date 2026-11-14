// World: book, restart
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { api, fund, journeyState, signOutBrowser, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueRecord } from './venue.mjs';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';
import { TEST_VENUE_DEPOSIT_ADDRESS } from '../../../../tooling/scripts/local-test-venue.mjs';

// J-campaigns-04, in the running app (docs/roadmap/journeys.json): finish the welcome checklist. One test per step, titled
// "J-campaigns-04 #<n>", run in order. The welcome campaigns are this run's TEST campaigns, made by the stack's two LOCAL
// TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates). A welcome window
// opens at each account's real sign-up (identity.user.created). Each account connects its own TEST browser wallet
// (svc-protocol's record, J-wallet-09). Each task ticks only from its own real fact: verification approved
// (identity.kyc.approved), and a USDC deposit the venue credited into the venue account the connected wallet owns, read
// from the venue (svc-trade's user-venue door on the stack's TEST venue, which takes the TEST chain's TEST USD at its
// TEST deposit address and credits it as TEST USDC). The ledger posts nothing for a deposit.
// #2 restarts trade with `LOCAL_STACK_USER_VENUE=on` (which starts the TEST venue) and the file puts it back off after.
// Rewards are TEST USDC, INTAFACED's own money (launch money model, OWNER 288): each claim is recorded owed once from the
// campaign's budget, then paid once from INTAFACED's TEST rewards wallet on the stack's TEST chain to the wallet the person
// connected, with its chain transaction (svc-campaigns' payer, J-campaigns-03). The USDC pot and that wallet are funded
// from builder fees the TEST venue credits us on this file's own routed sells, claimed and swept to the rewards wallet, as
// J-campaigns-03 does. #3 is an account paid a 5 USDC reward that deposits exactly that back into its venue account (the
// TEST venue credits a deposit from 5 USDC): it does not tick, because svc-campaigns checks it against our payout records
// to that wallet; money of their own on top does.
const J = 'J-campaigns-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHORT_WINDOW = 90;
const ASSET = 'USDC';
const REWARDS = { 'identity.verified': '0.01', 'pay.deposit': '0.02', 'trade.fill': '0.03' };
/** #3's verification reward: at the TEST venue's deposit minimum, so the person can deposit exactly it back. */
const PAID_BACK = '5';
/** What #3 and #4 pay in all: #3's one reward and #4's three. */
const PAID_IN_ALL = '5.06';
const TITLES = { 'identity.verified': 'TEST verify your identity', 'pay.deposit': 'TEST first deposit', 'trade.fill': 'TEST first trade' };
/** The TEST USDC #2 deposits from the wallet into the venue account. */
const DEPOSIT = '25';

test.describe.configure({ mode: 'default' });

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

/** A TEST welcome campaign, live now; `blank` leaves those tasks' rewards blank, `windowSeconds` is its welcome window. */
async function liveWelcome(name, { windowSeconds, blank = [], rewards = REWARDS }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const steps = Object.entries(TITLES).map(([event, title]) => ({
    title,
    event,
    count: 1,
    reward: blank.includes(event) ? null : { asset: ASSET, amount: rewards[event] },
  }));
  const definition = {
    name,
    type: 'welcome',
    rules: `TEST rules for ${name}: verify, deposit USDC from your connected wallet into your venue account, and make a first spot trade. Rewards are TEST USDC, paid to your connected wallet.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: ASSET, limit: Object.values(rewards).reduce((a, b) => sumDecimal([a, b]), '0') },
    // TEST limits (CM-eligibility-rules-03), wide enough that only a step about limits meets them.
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    tasks: { steps, claimWindowSeconds: null, holdSeconds: 0, kycGate: 'none', welcomeWindowSeconds: windowSeconds },
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

/** Founder A ends a welcome campaign: accounts that sign up after it get none from it. */
async function endCampaign(id) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const ended = data(await ctx.edge.mutate('campaigns', 'ops.campaigns.transition', { id, action: 'end', revision: 1 }, a), 'end');
  expect(ended.state).toBe('ended');
}

/** Founder A asks to sweep earned builder fees into the USDC reward pot; founder B approves, which posts it. */
async function fundPot(reference, amount) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  data(
    await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'builder', asset: ASSET, amount }, a),
    'ops.pot.request',
  );
  const funded = data(await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b), 'ops.pot.approve');
  expect(funded.state, JSON.stringify(funded)).toBe('posted');
}

/** Funds the pot with builder fees once svc-trade has posted them to the ledger (it posts on its own cadence). */
async function fundPotFromFees(reference, amount) {
  await expect
    .poll(
      async () => {
        try {
          await fundPot(`${reference}-${Date.now().toString(36)}`, amount);
          return 'posted';
        } catch (err) {
          return String(err).slice(0, 200);
        }
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe('posted');
}

/** Adds decimal strings exactly (no float). */
function sumDecimal(values) {
  const scale = 18;
  const units = (x) => {
    const [w, f = ''] = String(x).split('.');
    return BigInt(w + f.padEnd(scale, '0'));
  };
  const sum = values
    .reduce((n, v) => n + units(v), 0n)
    .toString()
    .padStart(scale + 1, '0');
  const frac = sum.slice(-scale).replace(/0+$/, '');
  return frac ? `${sum.slice(0, -scale)}.${frac}` : sum.slice(0, -scale);
}

/** A decimal TEST USD amount in the token's base units (6 decimals), exactly. */
const usdUnits = (amount) => {
  const [w, f = ''] = amount.split('.');
  return BigInt(w + f.padEnd(TOKEN_USD.decimals, '0'));
};

// ── Builder fees to fund the pot and our rewards wallet: a TEST trader of this file sells through our venue door ──────

const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const traderKey = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${RUN}`)));
const traderOwner = traderKey.address.toLowerCase();

/** One action through svc-trade's user-venue door as `who`: prepare, sign with the TEST trader's key, submit. */
async function door(who, intent, actionKey) {
  const session = await api(who);
  const signer = { role: 'owner', address: traderOwner };
  const prepared = await session.post('/api/v1/venue/prepare', { owner: traderOwner, signer, intent, ...(actionKey ? { actionKey } : {}) });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  const p = prepared.body.prepared;
  const t = p.typedData;
  const signature = await traderKey.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: p.digest, signature, signedBy: traderOwner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

/**
 * Builder fees the TEST venue credits us on this file's own sells: `who` approves our builder fee, sells SELL_SIZE BTC
 * into a TEST bid `sells` times, and the venue's own fills say what each earned us. Returns their sum. At the stack's
 * TEST 0.5 bps, seven sells of 0.5 BTC earn about 10.5 TEST USDC: enough for the pot to owe PAID_IN_ALL, and, above the
 * TEST float (2) and the TEST venue's withdrawal fee (1), for the sweep to move it to our rewards wallet.
 */
const SELL_SIZE = 0.5;
const SELLS = 7;
let orders = 0;
async function earnBuilderFees(who, sells) {
  const since = new Date(Date.now() - 1000);
  const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: traderOwner, subAccount: null };
  for (const [asset, amount] of [
    ['USDC', '10000'],
    ['BTC', String(SELL_SIZE * sells + 0.5)],
  ]) {
    const ref = `84532:${keccak256(toHex(`${J} ${RUN} ${traderOwner} ${asset}`))}:0`;
    const funded = await testVenue('/test/deposit', { account, asset, amount, depositRef: ref });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
  }
  const status = (await (await api(who)).get('/api/v1/venue/status')).body;
  expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
  run.write({ builder: status.builder.address });
  const markets = await testVenue('/markets', { account: null });
  const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
  await door(who, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap }, `approve-builder:${traderOwner}:${J}`);
  const buyer = `${J}-buyer-${RUN}`;
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '400000', `seed:${buyer}:USDC`);
  const bid = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: String(SELL_SIZE * sells),
    price: '59990',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:bid:${Date.now()}`,
    builderFee: null,
  });
  expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  for (let i = 0; i < sells; i += 1) {
    await door(who, {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'sell',
      type: 'limit',
      amount: String(SELL_SIZE),
      price: '59990',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:${RUN}:${(orders += 1)}`,
      builderFee: null,
    });
  }
  let fees = [];
  await expect
    .poll(
      async () => {
        const body = await venueRecord(traderOwner, '/fills', { since: since.toISOString() });
        fees = body.value.filter((f) => f.feeAsset === ASSET && !/^0(\.0+)?$/.test(f.builderFee)).map((f) => f.builderFee);
        return fees.length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(sells);
  return sumDecimal(fees);
}

/** TEST USD (base units) `address` holds on the TEST chain, read from the node itself. */
async function chainUsd(address) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: TOKEN_USD.address, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'],
    }),
  });
  return BigInt((await res.json()).result);
}

const TRANSFER_FN = 'function transfer(address to, uint256 value) returns (bool)';
/**
 * Pays INTAFACED's TEST rewards wallet from our own TEST builder fees, as the launch money model moves them: this file's
 * TEST trader sends 20 TEST USD to the TEST venue's deposit address on the chain (so the venue holds tokens to pay a
 * withdrawal from), then the TEST venue records a claim of our unclaimed builder fees (its TEST claim control). svc-trade
 * books the claim collected and sweeps what our builder account holds above the TEST float to the rewards wallet; nothing
 * here moves our money itself.
 */
async function claimOurBuilderFees() {
  const { builder } = state('builder');
  fundOnTestChain(traderOwner, 'venue');
  const { createWalletClient, encodeFunctionData, http, parseAbiItem } = await import('viem');
  const chain = {
    id: CHAIN_ID,
    name: 'TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [GATE_URL] } },
  };
  const before = await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS);
  const wallet = createWalletClient({ account: traderKey, chain, transport: http(GATE_URL) });
  await wallet.sendTransaction({
    to: TOKEN_USD.address,
    data: encodeFunctionData({
      abi: [parseAbiItem(TRANSFER_FN)],
      functionName: 'transfer',
      args: [TEST_VENUE_DEPOSIT_ADDRESS, 20_000_000n],
    }),
  });
  await mineBlocks(4);
  expect(await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS)).toBe(before + 20_000_000n);
  const claimed = await testVenue('/test/builder-claim', { builder });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The TEST chain's own receipt of `txHash`: the token transfers it made, as { token, to, value } (read from the chain). */
async function chainTransfers(txHash) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
  });
  const receipt = (await res.json()).result;
  expect(receipt, `the TEST chain has a receipt for ${txHash}`).toBeTruthy();
  expect(receipt.status).toBe('0x1');
  return receipt.logs
    .filter((l) => l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({ token: l.address.toLowerCase(), to: `0x${l.topics[2].slice(26)}`, value: BigInt(l.data) }));
}

/** The door on (it starts the TEST venue), as #2 turns it on when it is off. */
async function doorOn(who) {
  if (!(await venueDoor(who)).deposit) {
    userVenue(true);
    doorTurnedOn = true;
  }
}

/** The person deposits `amount` TEST USDC from their wallet into their venue account, signing it in the wallet. */
async function depositFromWallet(page, wallet, amount) {
  const sent = wallet.sends.length;
  await connectedNow(page);
  await page.getByRole('region', { name: 'Venue actions' }).getByLabel('Amount').fill(amount);
  await venueAction(page, 'Deposit TEST USDC').click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => wallet.sends.length).toBe(sent + 1);
  expect(wallet.sends[sent].method).toBe('eth_sendTransaction');
  // The TEST venue credits after 3 confirmations, and the stack's anvil mines a block per transaction only.
  await mineBlocks(2);
  await expect(page.getByTestId('venue-deposit')).toHaveText(`The venue credited ${amount} TEST USDC.`, { timeout: 60_000 });
}

async function checklistOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/tasks.welcome.list?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`tasks.welcome.list refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

const taskOf = (list, event) => list.tasks.find((t) => t.event === event);

/** Waits until svc-campaigns has read the sign-up from the bus and placed the account under this campaign. */
async function waitForChecklist(who, campaignId) {
  await expect.poll(async () => (await checklistOf(who)).campaign?.id ?? null, { timeout: 30_000 }).toBe(campaignId);
}

/** Waits until the bus has carried an event to svc-campaigns: tasks tick from events, never from this test. */
async function waitForTask(who, event, taskState) {
  await expect.poll(async () => taskOf(await checklistOf(who), event)?.state, { timeout: 60_000 }).toBe(taskState);
}

async function openChecklist(page, path = '/uc/promotion') {
  await page.goto(path);
  const list = page.getByTestId('welcome-checklist');
  await expect(list).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return list;
}

const row = (page, event) => page.locator(`[data-testid="welcome-task"][data-event="${event}"]`);

/** Restarts trade with the user-venue door on (which starts the TEST venue) or off, and puts this process's env back. */
function userVenue(on) {
  const before = process.env.LOCAL_STACK_USER_VENUE;
  if (on) process.env.LOCAL_STACK_USER_VENUE = 'on';
  else delete process.env.LOCAL_STACK_USER_VENUE;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = before;
  }
}
let doorTurnedOn = false;
test.afterAll(() => {
  if (doorTurnedOn) userVenue(false);
});

/** svc-trade's user-venue door as the person reads it. */
async function venueDoor(who) {
  const { status, body } = await (await api(who)).get('/api/v1/venue/status');
  if (status !== 200) throw new Error(`venue status refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Mines `n` empty blocks on the stack's TEST chain (`evm_mine`, the TEST chain's own control). */
async function mineBlocks(n) {
  for (let i = 0; i < n; i += 1) {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`evm_mine: ${JSON.stringify(body.error)}`);
  }
}

const sheet = (page) => page.locator('[data-sheet="sign"]');
const venueAction = (page, name) => page.getByRole('region', { name: 'Venue actions' }).getByRole('button', { name });

/** Signed in, with the TEST wallet in this page, on Wallet's Venue account tab, the browser wallet connected. */
async function openVenue(page, who, privateKey, { rpcUrl = null } = {}) {
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey, rpcUrl });
  await signIn(page, who);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
  return wallet;
}

/** The room has read the connection back: Connected, Connection expired, or Connect. */
async function roomSettled(page) {
  await expect(
    page
      .getByRole('heading', { name: 'Connected' })
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
}

async function connectAndSign(page, button = 'Connect to my account') {
  await page.getByRole('button', { name: button }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible();
}

/** The stack's TEST connection lasts 60 s: a signed action needs this much of it left. */
const CONNECTION_MARGIN_MS = 45_000;
async function connectedNow(page) {
  await roomSettled(page);
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

/** A new account signs up under the live welcome campaign and connects its own TEST wallet: the journey's start. */
async function newAccountWithWallet(page, prefix, campaignId) {
  const who = await signUp(page, prefix);
  const walletKey = testWalletKey();
  const address = privateKeyToAccount(walletKey).address;
  await waitForChecklist(who, campaignId);
  await openVenue(page, who, walletKey);
  await connectAndSign(page);
  expect((await connections(who)).map((c) => [c.address, c.status])).toEqual([[address, 'live']]);
  return { who, walletKey, address };
}

/**
 * The person's verification event delivered to svc-campaigns twice more: their newest identity.kyc.approved on the
 * stack's bus, published again with its payload unchanged under new envelope keys, so the bus does not drop it as its own
 * duplicate and the welcome consumer is what must hold. Returns the payload.
 */
function redeliverKyc(userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId } = process.env;
    const subject = EVENT_CATALOG.kycApproved.subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName('identity', prefix);
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
    const bus = await JetStreamEventBus.connect({ servers, producer: 'svc-identity', streamPrefix: prefix });
    for (const n of [1, 2]) {
      await bus.publish('kycApproved', payload, { idempotencyKey: 'kyc:' + userId + ':welcome-again:' + n + ':' + Date.now() });
    }
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: { ...process.env, NATS_URL: 'nats://127.0.0.1:14232', NATS_STREAM_PREFIX: 'LOCAL_TEST', USER_ID: userId },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering the verification event again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-campaigns' welcome verification consumer has taken and acknowledged every message on the bus. */
async function kycConsumerCaughtUp() {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const consumer = info.account_details
      ?.flatMap((a) => a.stream_detail ?? [])
      .flatMap((st) => st.consumer_detail ?? [])
      .find((c) => c.name === 'campaigns-welcome-kyc-approved');
    expect(consumer?.num_pending ?? -1).toBe(0);
    expect(consumer?.num_ack_pending ?? -1).toBe(0);
  }).toPass({ timeout: 30_000 });
}

test(`${J} #1 opens /uc/promotion on a new account: the checklist with its time window, and a blank reward reads "not set"`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  // A short-window campaign with the deposit reward blank: the account that signs up under it returns in #5.
  const short = await liveWelcome(`TEST welcome short ${tag}`, { windowSeconds: SHORT_WINDOW, blank: ['pay.deposit'] });
  const page = await (await browser.newContext()).newPage();
  const early = await newAccountWithWallet(page, 'jc04x', short.id);
  const list = await openChecklist(page, '/uc/promotion');
  await expect(list.getByTestId('welcome-campaign')).toHaveText(short.name);
  const window = list.getByTestId('welcome-window');
  await expect(window).toHaveAttribute('data-state', 'open');
  await expect(window).toContainText('Your welcome window: From');
  const shown = await checklistOf(early.who);
  expect(new Date(shown.window.closesAt).getTime() - new Date(shown.window.opensAt).getTime()).toBe(SHORT_WINDOW * 1000);
  await expect(window).toHaveAttribute('data-opens', shown.window.opensAt);
  await expect(window).toHaveAttribute('data-closes', shown.window.closesAt);
  await expect(page.getByTestId('welcome-task')).toHaveCount(3);
  await expect(row(page, 'pay.deposit').getByTestId('welcome-reward')).toHaveText('not set');
  await expect(row(page, 'identity.verified').getByTestId('welcome-reward')).toHaveText('0.01 USDC');
  await expect(row(page, 'trade.fill').getByTestId('welcome-reward')).toHaveText('0.03 USDC');
  for (const event of Object.keys(TITLES)) await expect(row(page, event)).toHaveAttribute('data-state', 'open');
  // A blank reward is never claimable: no button, and the service refuses it by name.
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  const blank = await (await api(early.who)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'pay.deposit' });
  expect(blank.body?.error?.message ?? '').toMatch(/\[campaigns\.(reward_unset|tasks_incomplete)\]/);
  await signOutBrowser(page.context());

  // The main account signs up under the full campaign, with every reward set and a week's window.
  await endCampaign(short.id);
  const full = await liveWelcome(`TEST welcome ${tag}`, { windowSeconds: 7 * 86_400 });
  // Its own browser, with its own TEST wallet installed: a page holds one wallet.
  const mePage = await (await browser.newContext()).newPage();
  const me = await newAccountWithWallet(mePage, 'jc04me', full.id);
  const mine = await openChecklist(mePage);
  await expect(mine.getByTestId('welcome-campaign')).toHaveText(full.name);
  await expect(mine.getByTestId('welcome-window')).toHaveAttribute('data-state', 'open');
  await expect(row(mePage, 'pay.deposit').getByTestId('welcome-reward')).toHaveText('0.02 USDC');
  run.write({ early: early.who, earlyKey: early.walletKey, me: me.who, meKey: me.walletKey, shortId: short.id, fullId: full.id });
});

test(`${J} #2 verifies and deposits TEST USDC from the wallet into the venue account: the matching tasks tick once, the deposit read from the venue; a redelivered event changes nothing`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { me, meKey } = state('me', 'meKey', 'fullId');
  const address = privateKeyToAccount(meKey).address;
  expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  // Full, as #4's spot trade on our own TEST book needs; the verify task ticks on the first tier granted.
  await verify(page, me, 'Full');
  await waitForTask(me, 'identity.verified', 'done');
  // Nothing deposited yet: the deposit task is open, read from the venue (or unread while the door is off), never ticked.
  expect(taskOf(await checklistOf(me), 'pay.deposit')).toMatchObject({ state: 'open', doneAt: null });

  if (!(await venueDoor(me)).deposit) {
    userVenue(true);
    doorTurnedOn = true;
  }
  const door = await venueDoor(me);
  expect(door).toMatchObject({ enabled: true, available: true, label: 'TEST', deposit: { chainId: CHAIN_ID, asset: 'USDC' } });
  await expect.poll(async () => (await checklistOf(me)).deposit?.source, { timeout: 30_000 }).toBe('read');
  expect(taskOf(await checklistOf(me), 'pay.deposit').state).toBe('open');
  fundOnTestChain(address, 'venue');
  const ledgerBefore = await (await api(me)).balances();

  // The person deposits from their own wallet into their venue account: they sign it in the wallet.
  const wallet = await openVenue(page, me, meKey, { rpcUrl: testChain().gateUrl });
  await connectedNow(page);
  await page.getByRole('region', { name: 'Venue actions' }).getByLabel('Amount').fill(DEPOSIT);
  await venueAction(page, 'Deposit TEST USDC').click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet' }).click();
  await expect.poll(() => wallet.sends.length).toBe(1);
  expect(wallet.sends[0].method).toBe('eth_sendTransaction');
  await expect(page.getByTestId('venue-deposit')).toBeVisible();
  // The TEST venue credits after 3 confirmations, and the stack's anvil mines a block per transaction only.
  await mineBlocks(2);
  await expect(page.getByTestId('venue-deposit')).toHaveText(`The venue credited ${DEPOSIT} TEST USDC.`, { timeout: 60_000 });

  // The venue's own record of the deposit: the task ticks from it, at the moment the venue saw it.
  const venueRead = await (await api(me)).get(`/api/v1/venue/deposits?owner=${address.toLowerCase()}`);
  const credited = venueRead.body.value.filter((d) => d.status === 'credited');
  expect(credited).toHaveLength(1);
  expect(credited[0]).toMatchObject({ asset: 'USDC', amount: DEPOSIT });
  await waitForTask(me, 'pay.deposit', 'done');
  const before = await checklistOf(me);
  expect(taskOf(before, 'pay.deposit').doneAt).toBe(new Date(credited[0].seenAt).toISOString());
  await openChecklist(page);
  await expect(row(page, 'identity.verified')).toHaveAttribute('data-state', 'done');
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'done');
  await expect(row(page, 'trade.fill')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-why')).toContainText('Done on');

  // The same transfer reported to the venue again credits nothing: the task stays ticked once, at the same moment, and
  // the identity task likewise.
  expect(await testDeposit(address, 'USDC', DEPOSIT, credited[0].depositRef)).toBe(false);
  // The verification event reaches svc-campaigns twice more, and every look below reads the venue's deposits again
  // (svc-campaigns reads the venue on each look, the deposit fact delivered to it again, with a later as-of time).
  const customer = await api(me);
  expect(redeliverKyc(customer.userId)).toMatchObject({ userId: customer.userId, tier: 'full' });
  await kycConsumerCaughtUp();
  let asOf = before.deposit.asOf;
  expect(before.deposit.source).toBe('read');
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 1_100));
    const after = await checklistOf(me);
    expect(after.deposit.source).toBe('read');
    expect(Date.parse(after.deposit.asOf)).toBeGreaterThan(Date.parse(asOf));
    asOf = after.deposit.asOf;
    expect(taskOf(after, 'pay.deposit')).toEqual(taskOf(before, 'pay.deposit'));
    expect(taskOf(after, 'identity.verified')).toEqual(taskOf(before, 'identity.verified'));
  }
  await page.reload();
  await expect(page.getByTestId('welcome-task')).toHaveCount(3);
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'done');
  // The ledger posts nothing for the deposit: the person's ledger balances are exactly as before.
  expect(await (await api(me)).balances()).toEqual(ledgerBefore);
});

test(`${J} #3 deposits only the rewards INTAFACED paid to the wallet: the deposit task does not tick, the deposit checked against our payout records to that wallet`, async ({
  browser,
}) => {
  test.setTimeout(600_000);
  state('me', 'fullId');
  expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
  // An account under its own welcome campaign whose verification reward is 5 USDC, the TEST venue's deposit minimum, so
  // what we pay it can be deposited back exactly. The newest live welcome campaign is the one a sign-up joins.
  const back = await liveWelcome(`TEST welcome paid back ${tag}`, {
    windowSeconds: 7 * 86_400,
    rewards: { ...REWARDS, 'identity.verified': PAID_BACK },
  });
  const signUpPage = await (await browser.newContext()).newPage();
  const other = await newAccountWithWallet(signUpPage, 'jc04b', back.id);
  await verify(signUpPage, other.who, 'Basic');
  await waitForTask(other.who, 'identity.verified', 'done');
  await signOutBrowser(signUpPage.context());

  // Our money for every reward this file pays: builder fees from this file's own routed sells fund the USDC pot, and,
  // claimed from the venue, are swept to our TEST rewards wallet on the chain.
  await doorOn(other.who);
  const fees = await earnBuilderFees(other.who, SELLS);
  expect(Number(fees), `builder fees ${fees}`).toBeGreaterThan(Number(PAID_IN_ALL) + 3);
  await fundPotFromFees(`TEST-${J}-3-${tag}`, PAID_IN_ALL);

  // The person claims the verification reward: owed once from the campaign's budget, then paid once to their wallet.
  const before = await chainUsd(other.address);
  expect(before, 'the wallet holds no TEST USD of its own').toBe(0n);
  const claim = await (await api(other.who)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'identity.verified' });
  expect(claim.body?.result?.data, JSON.stringify(claim.body).slice(0, 300)).toMatchObject({
    created: true,
    reward: { amount: PAID_BACK, asset: ASSET, owed: { txId: expect.any(String) } },
  });
  await claimOurBuilderFees();
  await expect.poll(async () => taskOf(await checklistOf(other.who), 'identity.verified').record?.state, { timeout: 180_000 }).toBe('paid');
  const { payout } = taskOf(await checklistOf(other.who), 'identity.verified').record;
  expect(payout.toWallet).toBe(other.address.toLowerCase());
  expect(await chainTransfers(payout.chainTx)).toEqual([
    { token: TOKEN_USD.address, to: other.address.toLowerCase(), value: usdUnits(PAID_BACK) },
  ]);
  expect(await chainUsd(other.address)).toBe(usdUnits(PAID_BACK));

  // Gas only (TEST ETH, no TEST USD): the wallet holds nothing but the reward we paid it.
  fundOnTestChain(other.address);
  expect(await chainUsd(other.address)).toBe(usdUnits(PAID_BACK));
  const page = await (await browser.newContext()).newPage();
  const wallet = await openVenue(page, other.who, other.walletKey, { rpcUrl: testChain().gateUrl });
  await depositFromWallet(page, wallet, PAID_BACK);
  expect(await chainUsd(other.address)).toBe(0n);
  // The venue credited the deposit, from the wallet we paid: the task reads it from the venue and does not tick.
  const venueRead = await (await api(other.who)).get(`/api/v1/venue/deposits?owner=${other.address.toLowerCase()}`);
  const credited = venueRead.body.value.filter((d) => d.status === 'credited');
  expect(credited).toEqual([expect.objectContaining({ asset: ASSET, amount: PAID_BACK })]);
  // Read from the venue after the venue saw the deposit, and still open.
  let read = null;
  await expect
    .poll(
      async () => {
        read = await checklistOf(other.who);
        return read.deposit?.source === 'read' && Date.parse(read.deposit.asOf) > Date.parse(credited[0].seenAt);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(taskOf(read, 'pay.deposit')).toMatchObject({ state: 'open', doneAt: null, record: null });
  await openChecklist(page);
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-why')).toContainText(
    'Rewards INTAFACED paid to that wallet do not count if you send them back.',
  );
  await expect(row(page, 'pay.deposit').getByTestId('welcome-deposit-source')).toHaveAttribute('data-source', 'read');
  await expect(page.getByRole('button', { name: `Claim the reward for ${TITLES['pay.deposit']}` })).toHaveCount(0);
  // Asking to claim it anyway is refused by name, and nothing is written.
  const refused = await (await api(other.who)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'pay.deposit' });
  expect(refused.body?.error?.message ?? '').toContain('[campaigns.tasks_incomplete]');
  expect(taskOf(await checklistOf(other.who), 'pay.deposit').record).toBeNull();

  // It is checked against what we paid, not ignored: money of their own on top, past what we paid, ticks it.
  fundOnTestChain(other.address, 'venue');
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  // The page keeps the browser wallet connected: it asks to connect it again only when it is not.
  const connectWallet = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect(
    connectWallet
      .or(page.getByRole('heading', { name: 'Connected' }))
      .or(page.getByRole('heading', { name: 'Connection expired' }))
      .or(page.getByRole('button', { name: 'Connect to my account' })),
  ).toBeVisible();
  if (await connectWallet.isVisible()) await connectWallet.click();
  await depositFromWallet(page, wallet, '5');
  const both = (await (await api(other.who)).get(`/api/v1/venue/deposits?owner=${other.address.toLowerCase()}`)).body.value
    .filter((d) => d.status === 'credited')
    .sort((x, y) => Date.parse(x.seenAt) - Date.parse(y.seenAt));
  expect(both).toHaveLength(2);
  await waitForTask(other.who, 'pay.deposit', 'done');
  expect(taskOf(await checklistOf(other.who), 'pay.deposit').doneAt).toBe(new Date(both[1].seenAt).toISOString());
  // The run's later sign-ups go back to the main campaign's rules; this one is left with the account it served.
  await endCampaign(back.id);
});

test(`${J} #4 claims after all tasks are done: one reward per task, each recorded owed once and paid once to the connected wallet`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { me, meKey, fullId } = state('me', 'meKey', 'fullId');
  const address = privateKeyToAccount(meKey).address.toLowerCase();
  // The last task by a real trade: a market buy on the real book, filled against the market maker.
  expect(fund(me.email, 'USDT', '500').tx).toBeTruthy();
  const client = await api(me);
  const order = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.001',
    clientOrderId: `${J}-buy-${Date.now()}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  await waitForTask(me, 'trade.fill', 'done');
  const walletBefore = await chainUsd(address);

  const page = await (await browser.newContext()).newPage();
  await signIn(page, me);
  await openChecklist(page);
  for (const [event, title] of Object.entries(TITLES)) {
    await page.getByRole('button', { name: `Claim the reward for ${title}` }).click();
    await expect(row(page, event)).toHaveAttribute('data-state', 'claimed');
  }
  // Each is owed once from the campaign's budget, then paid once from our rewards wallet to the connected wallet.
  await expect
    .poll(async () => (await checklistOf(me)).tasks.map((t) => t.record?.state), { timeout: 180_000 })
    .toEqual(['paid', 'paid', 'paid']);
  const claimed = await checklistOf(me);
  const chainTxs = new Set();
  const owedTxs = new Set();
  for (const t of claimed.tasks) {
    expect(t.record.rewardKey).toBe(`task:${fullId}:${client.userId.toLowerCase()}:welcome:${t.event}`);
    expect(t.record).toMatchObject({ asset: ASSET, amount: REWARDS[t.event], form: 'paid' });
    expect(t.record.owed.txId).toBeTruthy();
    expect(t.record.payout.toWallet).toBe(address);
    expect(t.record.payout.chainTx).toMatch(/^0x[0-9a-f]{64}$/);
    owedTxs.add(t.record.owed.txId);
    chainTxs.add(t.record.payout.chainTx);
    // The chain's own receipt: one transfer of exactly this reward, in TEST USD, to the connected wallet.
    expect(await chainTransfers(t.record.payout.chainTx)).toEqual([
      { token: TOKEN_USD.address, to: address, value: usdUnits(REWARDS[t.event]) },
    ]);
    // A second claim returns the first: nothing new is owed, sent or paid.
    const again = await client.post('/api/campaigns/trpc/tasks.welcome.claim', { event: t.event });
    expect(again.body?.result?.data, JSON.stringify(again.body).slice(0, 300)).toMatchObject({
      created: false,
      reward: { rewardKey: t.record.rewardKey, state: 'paid', owed: { txId: t.record.owed.txId }, payout: t.record.payout },
    });
  }
  // One owed record and one chain payment per task, and the wallet received exactly the three rewards.
  expect(owedTxs.size).toBe(3);
  expect(chainTxs.size).toBe(3);
  const total = sumDecimal(Object.values(REWARDS));
  expect(await chainUsd(address)).toBe(walletBefore + usdUnits(total));
  // Read again after the second claims and the payer's later passes: still one payment each, nothing more sent.
  expect((await checklistOf(me)).tasks.map((t) => t.record.payout)).toEqual(claimed.tasks.map((t) => t.record.payout));
  expect(await chainUsd(address)).toBe(walletBefore + usdUnits(total));

  await page.reload();
  for (const t of claimed.tasks) {
    await expect(row(page, t.event)).toHaveAttribute('data-state', 'claimed');
    await expect(row(page, t.event).getByTestId('welcome-why')).toContainText(`Paid to your connected wallet ${address} on`);
    await expect(row(page, t.event).getByTestId('welcome-chain-tx')).toHaveAttribute('data-tx', t.record.payout.chainTx);
    // Our booking of the payment is ours, never a transaction in the customer's own activity.
    await expect(row(page, t.event).getByTestId('welcome-tx')).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  // My rewards lists exactly the three, each once, paid.
  await page.goto('/uc/promotion');
  const rows = page.locator(`[data-testid="reward-row"][data-campaign="${fullId}"]`);
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.filter({ has: page.locator('[data-testid="reward-status"]', { hasText: 'Paid' }) })).toHaveCount(3);
  // The owed reward never reached a ledger balance of the customer's: their USDC there is what it was (none).
  expect((await client.balances())[ASSET]?.free ?? '0').toMatch(/^0(\.0+)?$/);
});

test(`${J} #5 returns after the window: the tasks read expired and no reward is created`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { early, shortId, fullId } = state('early', 'shortId', 'fullId');
  const opened = await checklistOf(early);
  expect(opened.campaign.id).toBe(shortId);
  const wait = new Date(opened.window.closesAt).getTime() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1_000));
  const page = await (await browser.newContext()).newPage();
  await signIn(page, early);
  // A real fact after the window ticks nothing: the account verifies now.
  await verify(page, early, 'Basic');
  await signIn(page, early);
  const list = await openChecklist(page);
  await expect(list.getByTestId('welcome-window')).toHaveAttribute('data-state', 'expired');
  for (const event of Object.keys(TITLES)) {
    await expect(row(page, event)).toHaveAttribute('data-state', 'expired');
    await expect(row(page, event).getByTestId('welcome-why')).toHaveText(
      'The welcome window closed before this task was claimed. No reward is given.',
    );
  }
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  for (const event of Object.keys(TITLES)) {
    const res = await (await api(early)).post('/api/campaigns/trpc/tasks.welcome.claim', { event });
    expect(res.body?.error?.message ?? '').toContain('[campaigns.claim_expired]');
  }
  const mine = await (await api(early)).get(`/api/campaigns/trpc/rewards.mine?input=${encodeURIComponent('{}')}`);
  expect(mine.body?.result?.data?.rewards ?? null).toEqual([]);
  expect((await checklistOf(early)).tasks.map((t) => t.record)).toEqual([null, null, null]);
  // The run leaves no welcome campaign running for later sign-ups.
  await endCampaign(fullId);
});
