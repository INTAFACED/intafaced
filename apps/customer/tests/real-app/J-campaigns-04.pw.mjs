// World: restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { api, journeyState, signOutBrowser, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { testDeposit } from './venue.mjs';

// J-campaigns-04, in the running app (docs/roadmap/journeys.json): finish the welcome checklist. One test per step, titled
// "J-campaigns-04 #<n>", run in order. The welcome campaigns are this run's TEST campaigns, made by the stack's two LOCAL
// TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates). A welcome window
// opens at each account's real sign-up (identity.user.created). Each account connects its own TEST browser wallet
// (svc-protocol's record, J-wallet-09). Each task ticks only from its own real fact: verification approved
// (identity.kyc.approved), and a USDC deposit the venue credited into the venue account the connected wallet owns, read
// from the venue (svc-trade's user-venue door on the stack's TEST venue, which takes the TEST chain's TEST USD at its
// TEST deposit address and credits it as TEST USDC). The ledger posts nothing for a deposit.
// #2 restarts trade with `LOCAL_STACK_USER_VENUE=on` (which starts the TEST venue) and the file puts it back off after.
// #3 and #4 (a deposit of reward money INTAFACED paid the wallet; one reward per task owed and paid once to the
// connected wallet) wait for the payout to the customer's own wallet, which does not exist yet: they are not here.
const J = 'J-campaigns-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHORT_WINDOW = 90;
const REWARDS = { 'identity.verified': '0.01', 'pay.deposit': '0.02', 'trade.fill': '0.03' };
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
async function liveWelcome(name, { windowSeconds, blank = [] }) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const steps = Object.entries(TITLES).map(([event, title]) => ({
    title,
    event,
    count: 1,
    reward: blank.includes(event) ? null : { asset: 'USDT', amount: REWARDS[event] },
  }));
  const definition = {
    name,
    type: 'welcome',
    rules: `TEST rules for ${name}: verify, deposit USDC from your connected wallet into your venue account, and make a first spot trade. Rewards are TEST USDT.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '0.06' },
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
  await expect(row(page, 'identity.verified').getByTestId('welcome-reward')).toHaveText('0.01 USDT');
  await expect(row(page, 'trade.fill').getByTestId('welcome-reward')).toHaveText('0.03 USDT');
  for (const event of Object.keys(TITLES)) await expect(row(page, event)).toHaveAttribute('data-state', 'open');
  // A blank reward is never claimable: no button, and the service refuses it by name.
  await expect(page.getByRole('button', { name: /^Claim the reward for/ })).toHaveCount(0);
  const blank = await (await api(early.who)).post('/api/campaigns/trpc/tasks.welcome.claim', { event: 'pay.deposit' });
  expect(blank.body?.error?.message ?? '').toMatch(/\[campaigns\.(reward_unset|tasks_incomplete)\]/);
  await signOutBrowser(page.context());

  // The main account signs up under the full campaign, with every reward set and a week's window.
  await endCampaign(short.id);
  const full = await liveWelcome(`TEST welcome ${tag}`, { windowSeconds: 7 * 86_400 });
  const me = await newAccountWithWallet(page, 'jc04me', full.id);
  const mine = await openChecklist(page);
  await expect(mine.getByTestId('welcome-campaign')).toHaveText(full.name);
  await expect(mine.getByTestId('welcome-window')).toHaveAttribute('data-state', 'open');
  await expect(row(page, 'pay.deposit').getByTestId('welcome-reward')).toHaveText('0.02 USDT');
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
  await verify(page, me, 'Basic');
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

  // The same transfer reported to the venue again credits nothing, and a second deposit of their own adds no tick: the
  // task stays ticked once, at the same moment, and the identity task likewise.
  expect(await testDeposit(address, 'USDC', DEPOSIT, credited[0].depositRef)).toBe(false);
  expect(await testDeposit(address, 'USDC', '5', `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  for (let i = 0; i < 3; i += 1) {
    const after = await checklistOf(me);
    expect(taskOf(after, 'pay.deposit')).toEqual(taskOf(before, 'pay.deposit'));
    expect(taskOf(after, 'identity.verified')).toEqual(taskOf(before, 'identity.verified'));
  }
  await page.reload();
  await expect(page.getByTestId('welcome-task')).toHaveCount(3);
  await expect(row(page, 'pay.deposit')).toHaveAttribute('data-state', 'done');
  // The ledger posts nothing for the deposit: the person's ledger balances are exactly as before.
  expect(await (await api(me)).balances()).toEqual(ledgerBefore);
});

test(`${J} #5 returns after the window: the tasks read expired and no reward is created`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { early, earlyKey, shortId, fullId } = state('early', 'earlyKey', 'shortId', 'fullId');
  const opened = await checklistOf(early);
  expect(opened.campaign.id).toBe(shortId);
  const wait = new Date(opened.window.closesAt).getTime() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 1_000));
  const page = await (await browser.newContext()).newPage();
  await signIn(page, early);
  // Real facts after the window tick nothing: the account verifies now, and its venue account takes a deposit.
  await verify(page, early, 'Basic');
  if ((await venueDoor(early)).deposit) {
    const address = privateKeyToAccount(earlyKey).address;
    expect(await testDeposit(address, 'USDC', DEPOSIT, `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  }
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
