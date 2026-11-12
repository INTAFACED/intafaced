// World: book, restart, gates
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api, fund, journeyState, mailedCodes, nextMailedCode, restartWithSetting, signOutBrowser, tool } from './stack.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { sameDecimal, testDeposit, venueBalance } from './venue.mjs';

// J-campaigns-06, in the running app (docs/roadmap/journeys.json): I watch my invitees qualify and get paid. One test per
// step, titled "J-campaigns-06 #<n>", run in order. The referral programme is this run's TEST referral campaign, made by
// the stack's two LOCAL TEST founders through svc-campaigns' operator doors (A creates and asks, B approves, A activates),
// double sided, with TEST criteria (full verification, a TEST USDT crypto deposit of at least 20 and spot trades worth at
// least 0.01 TEST USDT, inside a week of the attach) and TEST rewards. The referrer is a verified TEST account; the friend
// signs up from the referrer's invitation link in a browser of their own, which attaches them (identity.referral.created).
// Each step of the friend's progress ticks only from their own real event: verification approved (identity.kyc.approved),
// a crypto deposit credited on the TEST chain (pay.deposit_credit.posted) and a spot fill against the stack's market
// maker (trade.fill.settled). #2's move between the friend's own wallet and venue account: the friend connects their own
// TEST wallet to their account in the venue room, then the stack's TEST venue credits 25 TEST USDT from it to their venue
// account (its TEST deposit control), with svc-trade's user-venue door switched on for that moment only and off after.
// #3 to #8 (rewards, rebate share, commissions, tiers and caps, a frozen beneficiary, the statement) are added in full by
// the slices that build them (CM-referral-03, CM-referral-04).
const J = 'J-campaigns-06';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REFERRER_REWARD = '0.01';
const REFEREE_REWARD = '0.005';

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

/** This run's TEST referral programme, live now and the one started last, so every attach from here on is under it. */
async function liveProgramme(name) {
  const { ctx, pair } = await operators();
  const a = await pair.a.campaignsOpsToken();
  const b = await pair.b.campaignsOpsToken();
  const definition = {
    name,
    type: 'referral',
    rules: `TEST rules for ${name}: bring a friend who verifies, deposits and trades within a week. Rewards are TEST USDT.`,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    participation: { exclusions: [], regionScope: 'platform' },
    budget: { asset: 'USDT', limit: '1' },
    limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
    referral: {
      sides: 'double',
      criteria: { verification: 'full', asset: 'USDT', depositMin: '20', tradeVolumeMin: '0.01', windowSeconds: 7 * 86_400 },
      rewards: { referrer: { asset: 'USDT', amount: REFERRER_REWARD }, referee: { asset: 'USDT', amount: REFEREE_REWARD } },
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

/** The referrer's own invitee list, as svc-campaigns answers their session. */
async function inviteesOf(who) {
  const res = await (await api(who)).get(`/api/campaigns/trpc/referral.invitees?input=${encodeURIComponent('{}')}`);
  if (!res.body?.result) throw new Error(`referral.invitees refused (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** Waits until the bus has carried an event to svc-campaigns: steps tick from events, never from this test. */
async function waitForInvitee(who, check, timeout = 60_000) {
  await expect.poll(async () => check((await inviteesOf(who)).invitees[0] ?? null), { timeout }).toBe(true);
}

/** The referrer's invitation link, made on /uc/promotion/mycards as a person makes it; returns its token. */
async function invitationToken(page) {
  await page.goto('/uc/promotion/mycards');
  await page.getByRole('button', { name: 'Review link request' }).click();
  await page.getByRole('button', { name: 'Get or create link' }).click();
  const field = page.getByLabel('Invitation link · private');
  await expect(field).toHaveValue(/\/invite\?token=[0-9a-f-]{36}$/);
  return new URL(await field.inputValue()).searchParams.get('token');
}

/** The friend signs up from the invitation's own "Create account" link (details, then the mailed code). */
async function signUpFromInvitation(page, token) {
  const handle = `jc6f${Date.now().toString(36)}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await page.goto(`/invite?token=${token}`);
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(`/register?invite=${token}`);
  const seen = mailedCodes(who.email).length;
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Code from the email').fill(await nextMailedCode(who.email, seen));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await expect(page).toHaveURL(`/invite?token=${token}`);
  return who;
}

/** The invitee list on the referrer's promotion records page, once read. */
async function openInvitees(page) {
  await page.goto('/uc/promotion/mypromotion');
  const list = page.getByTestId('referral-invitees');
  await expect(list).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return list;
}

const stepCell = (row, step) => row.getByTestId(`invitee-step-${step}`);

/** The customer's TEST Ethereum USDT deposit address, read on Deposit as a person reads it. */
async function depositAddress(page) {
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('combobox', { name: /^Asset Coins you hold/ }).selectOption('USDT');
  await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption({ label: 'TEST Ethereum' });
  await page.getByRole('checkbox', { name: 'I will send only USDT on TEST Ethereum.' }).check();
  await page.getByRole('button', { name: 'Show my deposit address' }).click();
  return (await page.getByTestId('deposit-address').locator('strong[data-testid="numeric"]').innerText()).trim();
}

/**
 * The friend's newest event of one kind delivered to svc-campaigns twice more: read off the stack's bus and published
 * again with its payload unchanged (the same deposit or fill id) under new envelope keys, so the bus does not drop it as
 * its own duplicate and the referral consumer is what must hold. Returns the payload.
 */
function redeliver(eventName, stream, producer, userId) {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, JetStreamEventBus, decodeEnvelope, streamName } from '@intafaced/events';
    const { NATS_URL: servers, NATS_STREAM_PREFIX: prefix, USER_ID: userId, EVENT: event, STREAM: s, PRODUCER: producer } = process.env;
    const subject = EVENT_CATALOG[event].subject;
    const nc = await connect({ servers });
    const jsm = await nc.jetstreamManager();
    const stream = streamName(s, prefix);
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
    const bus = await JetStreamEventBus.connect({ servers, producer, streamPrefix: prefix });
    for (const n of [1, 2]) await bus.publish(event, payload, { idempotencyKey: event + ':referral-again:' + n + ':' + Date.now() });
    await bus.close();
    console.log(JSON.stringify(payload));`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(root, 'packages', 'events'),
    env: {
      ...process.env,
      NATS_URL: 'nats://127.0.0.1:14232',
      NATS_STREAM_PREFIX: 'LOCAL_TEST',
      USER_ID: userId,
      EVENT: eventName,
      STREAM: stream,
      PRODUCER: producer,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`delivering ${eventName} again failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/** Until svc-campaigns' named referral consumers have taken and acknowledged every message on the bus. */
async function consumersCaughtUp(...names) {
  await expect(async () => {
    const info = await fetch('http://127.0.0.1:18232/jsz?consumers=true').then((r) => r.json());
    const all = info.account_details?.flatMap((a) => a.stream_detail ?? []).flatMap((st) => st.consumer_detail ?? []) ?? [];
    for (const name of names) {
      const consumer = all.find((c) => c.name === name);
      expect(consumer?.num_pending ?? -1, name).toBe(0);
      expect(consumer?.num_ack_pending ?? -1, name).toBe(0);
    }
  }).toPass({ timeout: 30_000 });
}

test(`${J} #1 opens /uc/promotion/mypromotion: the invitee list with each invitee's progress (verified, deposited, traded) and no private invitee detail`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  const programme = await liveProgramme(`TEST referral ${tag}`);
  const page = await (await browser.newContext()).newPage();
  const referrer = await signUp(page, 'jc6r');
  await verify(page, referrer);
  await signIn(page, referrer);

  // Before anyone joins: the list's honest empty state, with no invented row.
  const empty = await openInvitees(page);
  await expect(empty.getByTestId('referral-invitees-empty')).toContainText('No invitees yet');
  await expect(empty.getByTestId('referral-invitee')).toHaveCount(0);

  const token = await invitationToken(page);
  const friendPage = await (await browser.newContext()).newPage();
  const friend = await signUpFromInvitation(friendPage, token);
  const friendId = (await api(friend)).userId;
  await waitForInvitee(referrer, (row) => row?.state === 'in_progress');

  const list = await openInvitees(page);
  const row = list.getByTestId('referral-invitee');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'in_progress');
  await expect(row).toContainText('Invitee 1');
  await expect(row.getByTestId('invitee-state')).toHaveText('In progress');
  for (const step of ['verified', 'deposited', 'traded']) {
    await expect(stepCell(row, step)).toHaveAttribute('data-done', 'false');
    await expect(stepCell(row, step)).toHaveText('Not done');
  }
  await expect(list.getByRole('columnheader')).toHaveText(['Invitee', 'Joined', 'Verified', 'Deposited', 'Traded', 'State']);
  await expect(row).toContainText(`Programme: ${programme.name}`);

  // No private invitee detail: not on the page, and not in what the service answers the referrer.
  for (const detail of [friend.handle, friend.email, friendId]) await expect(list).not.toContainText(detail);
  const answer = await inviteesOf(referrer);
  const text = JSON.stringify(answer);
  for (const detail of [friend.handle, friend.email, friendId, friendId.toLowerCase()]) expect(text).not.toContain(detail);
  expect(answer.total).toBe(1);
  expect(Object.keys(answer.invitees[0]).sort()).toEqual(
    ['attachedAt', 'place', 'programme', 'qualifiedAt', 'state', 'steps', 'windowClosesAt'].sort(),
  );
  // Another person's list does not show this invitee.
  expect((await inviteesOf(friend)).invitees).toEqual([]);
  await signOutBrowser(friendPage.context());
  run.write({ referrer, friend, friendId, programmeId: programme.id, token });
});

test(`${J} #2 an invitee finishes the last step: the summary moves from in progress to qualified exactly once even if events repeat, and a move between their own wallet and venue accounts does not count`, async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const { referrer, friend, friendId } = state('referrer', 'friend', 'friendId');
  const page = await (await browser.newContext()).newPage();

  // Verified: the friend's full verification, approved by the stack's two TEST operators.
  await signIn(page, friend);
  await verify(page, friend, 'Full');
  await waitForInvitee(referrer, (row) => row?.steps.verified === true);

  // A move between the friend's own wallet and their venue account is no deposit: the step stays undone. The friend
  // connects their own TEST wallet to their account in the venue room (signing the connection in it), then moves 25 TEST
  // USDT, the programme's asset and above its deposit minimum, from that wallet into their venue account.
  const walletKey = testWalletKey();
  const wallet = privateKeyToAccount(walletKey).address;
  restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'on');
  try {
    const venuePage = await (await browser.newContext()).newPage();
    await installTestWallet(venuePage, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
    await signIn(venuePage, friend);
    await venuePage.goto('/wallet/venue');
    await venuePage.getByRole('button', { name: `Connect ${TEST_WALLET.name}` }).click();
    await venuePage.getByRole('button', { name: 'Connect to my account' }).click();
    await venuePage.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
    await expect(venuePage.getByRole('heading', { name: 'Connected' })).toBeVisible();
    await expect(venuePage.locator('[data-venue-address]')).toHaveText(wallet);
    expect(await testDeposit(wallet, 'USDT', '25', `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(sameDecimal((await venueBalance(wallet, 'USDT')).free, '25')).toBe(true);
    await signOutBrowser(venuePage.context());
  } finally {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE', 'off');
  }
  // TEST funds credited through the ledger (a trial fund, not a deposit of the friend's own) do not count either.
  expect(fund(friend.email, 'USDT', '500').tx).toBeTruthy();
  await consumersCaughtUp('campaigns-referral-deposit-credited');
  expect((await inviteesOf(referrer)).invitees[0]).toMatchObject({ state: 'in_progress', steps: { deposited: false } });

  // Deposited: a crypto deposit of the friend's own, credited on the TEST chain.
  await signIn(page, friend);
  const address = await depositAddress(page);
  expect(tool('local-test-stack.mjs', 'chain-deposit', address, 'USDT', '20', '6', '--tx', `jc06-${friend.handle}`)).toContain(
    '"received":true',
  );
  await waitForInvitee(referrer, (row) => row?.steps.deposited === true);
  expect((await inviteesOf(referrer)).invitees[0].state).toBe('in_progress');

  // Traded, the last step: a market buy on the real book, filled against the market maker.
  const client = await api(friend);
  const order = await client.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.001',
    clientOrderId: `${J}-buy-${Date.now()}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  await waitForInvitee(referrer, (row) => row?.state === 'qualified');
  const qualified = (await inviteesOf(referrer)).invitees[0];
  expect(qualified.steps).toEqual({ verified: true, deposited: true, traded: true });
  expect(qualified.qualifiedAt).toBeTruthy();

  await signOutBrowser(page.context());
  await signIn(page, referrer);
  const list = await openInvitees(page);
  const row = list.getByTestId('referral-invitee');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'qualified');
  await expect(row.getByTestId('invitee-state')).toHaveText('Qualified');
  for (const step of ['verified', 'deposited', 'traded']) await expect(stepCell(row, step)).toHaveText('Done');
  await expect(row.getByTestId('invitee-why')).toContainText('Qualified on');

  // The deposit and the fill reach svc-campaigns twice more: still one invitee, qualified at the same moment.
  expect(redeliver('payDepositCreditPosted', 'pay', 'svc-pay', friendId)).toMatchObject({ userId: friendId, assetId: 'USDT' });
  expect(redeliver('fillSettled', 'trade', 'svc-trade', friendId)).toMatchObject({ userId: friendId });
  await consumersCaughtUp('campaigns-referral-deposit-credited', 'campaigns-referral-fill-settled');
  const after = await inviteesOf(referrer);
  expect(after.total).toBe(1);
  expect(after.invitees[0]).toEqual(qualified);
  await page.reload();
  await expect(page.getByTestId('referral-invitee')).toHaveCount(1);
  await expect(page.getByTestId('referral-invitee')).toHaveAttribute('data-state', 'qualified');
  run.write({ qualifiedAt: qualified.qualifiedAt });
});
