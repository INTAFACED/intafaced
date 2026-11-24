// World: gates, restart, stack
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, api, mailedLines, signOutBrowser, signUpInBrowser, staffFreeze, staffRestore, toUnits, tool } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { signIn, verify } from './desk.mjs';
import { OWN_AGENT, createOwnAgent } from './agents.mjs';
import { body200 } from './answers.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  TEST_VENUE,
  openVenueDesk,
  sameDecimal,
  venueInfo,
  shownBalance,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-11, in the running app (docs/roadmap/journeys.json): I freeze my own account and later reactivate it.
// One test per step this build serves, titled "J-identity-11 #<n>". Every person here is a TEST person on the local
// stack, signed up through the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-11';

test.describe.configure({ mode: 'default' });
// Each person holds TEST USDC in their own venue account on the stack's TEST venue, under their own TEST wallet: the
// Money line says a freeze moves none of it. Every step reads the TEST venue's own record of that account.
venueForThisFile(test);

/** What the person is told about their funds, the same sentence wherever INTAFACED says it. */
const FUNDS = 'Your funds stay in your own wallet and venue account, which only your wallet controls.';
const HELD = '500';

/** The venue desk serves only a verified person: the stack's TEST operators verify them, and they sign in again. */
async function verifiedAgain(page, who) {
  await verify(page, who);
  await signIn(page, who);
}

/** The person's own TEST wallet and its venue account, funded with TEST USDC by the TEST venue's deposit control. */
async function ownVenueAccount() {
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', HELD, `deposit:${J}:${owner}`);
  return { walletKey, owner };
}

/**
 * The USDC the desk shows for the person's connected wallet, read on a device of its own, and the TEST venue's own record
 * of the same account: they must agree. Returns the venue's figure.
 */
async function deskAgreesWithVenue(browser, who, own) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openVenueDesk(page, who, '/trade/futures', own.walletKey);
    const venue = await venueBalance(own.owner, 'USDC');
    await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).total, venue.total), { timeout: 15_000 }).toBe(true);
    return venue;
  } finally {
    await context.close();
  }
}

/**
 * The same comparison on a page the person is already signed in on (a fresh sign-in would ask for the second factor the
 * person added): the TEST wallet is installed in it and connected on the desk.
 */
async function signedInDeskAgrees(page, own) {
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey: own.walletKey });
  await page.goto('/trade/futures');
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect TEST Wallet', exact: true }).click();
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(wallet.address.toLowerCase());
  const venue = await venueBalance(own.owner, 'USDC');
  await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).total, venue.total), { timeout: 15_000 }).toBe(true);
  return venue;
}

/** The account as the TEST venue itself records it: still exactly what the person put in, with no order resting on it. */
async function venueUntouched(own) {
  const venue = await venueBalance(own.owner, 'USDC');
  expect(sameDecimal(venue.total, HELD), JSON.stringify(venue)).toBe(true);
  expect(sameDecimal(venue.locked, '0'), JSON.stringify(venue)).toBe(true);
  expect((await venueRecord(own.owner, '/open-orders')).value).toEqual([]);
  return venue;
}

function person(prefix = 'jf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

/** The TEST lift reason from identity's appeal decision reasons (IDENTITY_APPEAL_DECISION_REASONS), as identity returns it. */
const LIFT_REASON = (() => {
  const raw = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values/identity.json', import.meta.url), 'utf8'));
  const [listed] = JSON.parse(raw.values.IDENTITY_APPEAL_DECISION_REASONS.value);
  return { code: listed.code, text: listed.reason, guidance: listed.guidance };
})();

/** Identity's typed refusal code, wherever the tRPC error carries it. */
const typedCode = (data) => data?.intafacedCode ?? data?.cause?.code ?? data?.code;

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** Freezes the person's own account from Security with their password; every session ends. Returns when it was asked. */
async function freezeOwn(page, who) {
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account' }) });
  await card.getByLabel('Your password').fill(who.password);
  // Taken before the click, so it is never later than the freeze the service records.
  const frozenAt = Date.now();
  await card.getByRole('button', { name: 'Freeze my account' }).click();
  // The freeze ends this session too: the room shows the frozen card until its next read finds the session gone, then
  // drops to signed out. Either is the answer; the sign-in after it proves the freeze.
  await expect(
    page.getByRole('heading', { name: 'You froze this account' }).or(page.getByRole('heading', { name: 'Sign in to continue' })),
  ).toBeVisible();
  return frozenAt;
}

/** Signs in again through /login to an account its owner froze; the sign-in lands on that freeze. */
async function signInFrozen(page, who) {
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const frozen = page.getByTestId('frozen-by-you');
  await expect(frozen).toBeVisible();
  return frozen;
}

const ACTIONS = [
  'Sign in',
  'Trade',
  'Create API keys',
  'Change your password',
  'Change your sign-in methods',
  'Reset your password',
  'Reset your second factor',
  'Add recovery keys or change their plan',
  'Add a withdrawal address',
  'Start a send to a withdrawal address',
];

test(`${J} #1 Account status lists what I can still do and what I cannot; an active account blocks nothing`, async ({ page, browser }) => {
  test.setTimeout(180_000);
  const who = person();
  await signUpInBrowser(page, who);
  await verifiedAgain(page, who);
  // The person's own venue account: the desk shows what the TEST venue records for it.
  const venueAcct = await ownVenueAccount();
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByRole('heading', { name: 'Account status' })).toBeVisible();
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__state')).toHaveText('Your account is active. Nothing is restricted.');
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(ACTIONS);
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Nothing']);
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);

  // A restriction shows in both lists with its reason and how it ends: the owner's own security lock.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Turn on the lock' }).click();
  await page.getByRole('button', { name: 'Turn it on now' }).click();
  await expect(page.getByText('The lock is on.').first()).toBeVisible();
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  const lock = status.getByTestId('account-status__restrictions').locator('li[data-kind="security_lock"]');
  await expect(lock).toContainText('Security lock');
  await expect(lock).toContainText('Reason: you turned it on.');
  await expect(lock).toContainText('It holds until you ask to unlock it in Security.');
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(ACTIONS.slice(3));
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(['Sign in', 'Trade', 'Create API keys']);
  // The lock moved nothing: the venue account holds what it held, and the desk still shows the venue's own figure.
  await venueUntouched(venueAcct);
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
});

/** The freeze link on the newest security notice mailed to `email`, as the path the mail links to. */
async function mailedFreezeLink(email) {
  let link = null;
  await expect
    .poll(
      () => {
        const lines = mailedLines(email, 'factor-changed').filter((line) => / freeze=/.test(line));
        link = lines.length ? /\bfreeze=(\S+)/.exec(lines.at(-1))[1] : null;
        return link;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^freeze\/confirm#token=[A-Za-z0-9_-]{40,}$/);
  return `/${link}`;
}

// The person's agent that trades: a live strategy run on a sub-account of their own TEST wallet, through an agent
// permission the wallet signs (svc-trade quant/live-run), as J-wallet-13 #1 sets it up. Its orders are agent orders.
const LIVE = '/api/v1/quant/live-runs';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';
/** What the wallet moves into the agent's sub-account; deposited on top of HELD first, so the main account still holds HELD. */
const RUN_CASH = '200';
const walletOf = (own) => privateKeyToAccount(own.walletKey);
const subRecord = async (own, sub, route, extra = {}) => (await venueRecord(own.owner, route, extra, TEST_VENUE, sub)).value;
const openPositions = async (own, sub) => (await subRecord(own, sub, '/positions')).filter((p) => toUnits(p.size) > 0n);

/** The wallet signs one action on its own venue account (main or a sub-account) on the TEST venue directly. */
async function ownVenueAction(own, intent, subAccount = null) {
  const account = { ...(await venueAccount(own.owner)), subAccount };
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: own.owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const p = prepared.body.typedData;
  const signature = await walletOf(own).signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: own.owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
}

/**
 * The person's trading agent: a strategy saved and run live on a funded sub-account of their own wallet, the wallet
 * signing the agent's permission, with the agent's own limit order resting on the venue. Returns the run and its sub-account.
 */
async function tradingAgent(session, own) {
  await testDeposit(own.owner, 'USDC', RUN_CASH, `deposit:${J}:${own.owner}:agent`);
  const name = `${J}-agent`;
  await ownVenueAction(own, { kind: 'create_sub_account', name, subAccountKey: `own:${J}:${name}:${own.owner}` });
  const sub = (await venueRecord(own.owner, '/sub-accounts')).value.find((x) => x.name === name)?.subAccount;
  expect(sub, `the venue lists no sub-account named ${name}`).toBeTruthy();
  await ownVenueAction(own, {
    kind: 'sub_account_transfer',
    subAccount: sub,
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: RUN_CASH,
    moveKey: `own:${J}:${name}:fund:${own.owner}`,
  });
  const status = body200(await session.get('/api/v1/venue/status'));
  await ownVenueAction(own, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps }, sub);
  await ownVenueAction(own, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 10_000, marginMode: 'isolated' }, sub);
  const strategy = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: 'TEST freeze agent',
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: `${J}:${own.owner}:strategy`,
      idempotencyKey: `${J}:${own.owner}:save`,
    }),
  ).result.data;
  const runId = crypto.randomUUID();
  let view = body200(
    await session.post(LIVE, {
      runId,
      strategyId: strategy.id,
      strategyVersion: 1,
      owner: own.owner,
      subAccount: sub,
      cap: '150',
      restartAttempts: '1',
      statePolicy: 'keep',
      liveControl: true,
    }),
  );
  expect(view.state).toBe('signing');
  const p = view.next.prepared;
  const signature = await walletOf(own).signTypedData({
    domain: p.typedData.domain,
    types: p.typedData.types,
    primaryType: p.typedData.primaryType,
    message: p.typedData.message,
  });
  view = body200(
    await session.post(`${LIVE}/${runId}/submit`, {
      actionKey: view.next.actionKey,
      signature: { digest: p.digest, signature, signedBy: own.owner },
    }),
  );
  expect(view.state).toBe('running');
  await expect.poll(async () => (await openPositions(own, sub)).map((x) => x.size), { timeout: 20_000 }).toEqual([BLOCK]);
  // The agent's own order, resting on the venue under the permission the wallet signed.
  const detail = body200(await session.get(`${LIVE}/${runId}`));
  expect(detail).toMatchObject({ state: 'running', permission: 'active' });
  body200(
    await session.post(`${LIVE}/${runId}/orders`, {
      seq: detail.nextSeq,
      side: 'buy',
      type: 'limit',
      symbol: SYMBOL,
      size: BLOCK,
      price: '50000',
    }),
  );
  expect(await subRecord(own, sub, '/open-orders')).toHaveLength(1);
  return { runId, sub };
}

/** The bank's withdrawal guard, asked as the address form asks it before any code: may this person add this address? */
const WITHDRAW_TO = '0x52908400098527886E0F7030069857D2E4169EE7';
const withdrawalCheck = (session) =>
  session.get(`/api/bank/trpc/ramps.destinations.check?input=${encodeURIComponent(JSON.stringify({ ref: WITHDRAW_TO }))}`);
const refusalOf = (res) => res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.cause?.code ?? null;

/** The typed code on an Edge or service refusal, wherever the answer carries it. */
const codeOn = (res) =>
  res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.code ?? res.body?.code ?? res.body?.error?.code ?? null;
const query = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input))}`;
/** Every live sign-in of the person, as identity lists them to the person themself. */
const sessionsOf = async (session) =>
  (await session.get(query('/api/identity/trpc/listSessions', { userId: session.userId, limit: 200 }))).body.result.data.sessions;
/** The person's key named `name`, as identity lists the person's keys. */
const keyNamed = async (session, name) =>
  (await session.get(query('/api/identity/trpc/apiKeys.list', { limit: 200 }))).body.result.data.filter((record) => record.name === name);

test(`${J} #2 Freeze my account from the mailed link: no session and no key remain, every agent permission is revoked and an agent order refused, the link used twice shows the stored result, a withdrawal is refused`, async ({
  browser,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // A verified person with a passkey (only such an account holds an API key) and a live key. Adding the passkey is a
  // security change, so identity mails the "your sign-in methods changed" notice, and that notice carries the link.
  const { page, who } = await keyHolder(browser, 'jl');
  const key = await makeKey(page, { name: 'freeze-me', preset: 'Read only' });
  const session = await api(who);
  // Their own venue account, which the desk shows as the TEST venue records it.
  const venueAcct = await ownVenueAccount();
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
  // An agent permission stored for the person: their own agent, allowed to use their own data.
  await createOwnAgent(page);
  const agents = body200(await session.get(query('/api/agents/trpc/own.list', { limit: 50 })));
  const agentId = agents.result.data.find((row) => row.name === OWN_AGENT).id;
  body200(await session.post('/api/agents/trpc/own.consents.grant', { id: agentId, dataClass: 'own_data' }));
  expect((await consentsOf(who, agentId)).map((c) => c.state)).toEqual(['granted']);
  // An agent permission the person's wallet signed: their trading agent, with its own order resting on the venue.
  const agent = await tradingAgent(session, venueAcct);
  const STATUS = '/api/identity/trpc/accountStatus.mine';
  expect((await session.get(STATUS)).status).toBe(200);
  expect((await withKey(key, { path: STATUS })).status).toBe(200);
  // Before the freeze identity lists the key live and more than one sign-in (the browser's and this one).
  expect((await keyNamed(session, 'freeze-me')).map((record) => record.revoked)).toEqual([false]);
  const before = await sessionsOf(session);
  expect(before.length).toBeGreaterThanOrEqual(2);
  // Before the freeze the withdrawal guard lets this person go on to the address form.
  const open = await withdrawalCheck(session);
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  expect(open.body.result.data.address).toBe('ok');

  // A link nobody was sent gets the one generic page and freezes nothing.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/freeze/confirm#token=${randomBytes(32).toString('base64url')}`);
  await stranger.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(stranger.getByRole('heading', { level: 1 })).toHaveText('This freeze link does not work');
  expect((await session.get(STATUS)).body.result.data.state).toBe('active');

  // "This was not me": the person opens the link from the notice in a browser that is not signed in.
  const link = await mailedFreezeLink(who.email);
  const mailbox = await (await browser.newContext()).newPage();
  await mailbox.goto(link);
  await expect(mailbox.getByRole('heading', { level: 1 })).toHaveText('Freeze your account');
  // Opening the page spent nothing: the account still reads active.
  expect((await session.get(STATUS)).body.result.data.state).toBe('active');
  await mailbox.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(mailbox.getByRole('heading', { level: 1 })).toHaveText('Your account is frozen');
  await expect(mailbox.getByTestId('freeze-link-result')).toHaveAttribute('data-first-use', 'true');
  const first = await mailbox.getByTestId('freeze-link-result').locator('time').getAttribute('datetime');
  expect(Number.isNaN(Date.parse(first))).toBe(false);

  // No session and no key remain: the sign-in made before the freeze is refused as revoked, the key as revoked, and
  // the browser's own session is signed out. Edge may hold a session's authority for its cache window, so the first
  // read waits that window out once.
  const { EDGE_AUTHORITY_CACHE_MAX_MS } = await import(path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'));
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  const oldSession = await session.get(STATUS);
  expect(oldSession.status, JSON.stringify(oldSession.body).slice(0, 300)).toBe(401);
  // Edge passes an ended sign-in on as signed out, so identity's own door answers it: not signed in. That the sign-in
  // itself is gone is read below from identity's list of the person's sessions.
  expect(codeOn(oldSession), JSON.stringify(oldSession.body)).toBe('UNAUTHORIZED');
  const oldKey = await withKey(key, { path: STATUS });
  expect(oldKey.status, JSON.stringify(oldKey.body).slice(0, 300)).toBe(401);
  expect(codeOn(oldKey), JSON.stringify(oldKey.body)).toBe('edge.api_key_revoked');
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  // Signed in again, identity lists only this new sign-in and the key as revoked, and the account reads frozen by its
  // owner since the moment the link page showed.
  const again = await api(who);
  const listed = await sessionsOf(again);
  expect(listed.map((seat) => seat.isCurrent)).toEqual([true]);
  expect(before.map((seat) => seat.id)).not.toContain(listed[0].id);
  expect((await keyNamed(again, 'freeze-me')).map((record) => record.revoked)).toEqual([true]);
  const frozen = (await again.get(STATUS)).body.result.data;
  expect(frozen.state).toBe('frozen_self');
  expect(frozen.restrictions.map((restriction) => [restriction.kind, restriction.since])).toEqual([['self_freeze', first]]);

  // The same link again, opened from the mail in a new tab, shows the result stored at its first use and changes nothing.
  // (A goto on the open tab would only change its fragment, so the page would not load again.)
  const reopened = await mailbox.context().newPage();
  await reopened.goto(link);
  await reopened.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(reopened.getByRole('heading', { level: 1 })).toHaveText('This link was already used');
  await expect(reopened.getByTestId('freeze-link-result')).toHaveAttribute('data-first-use', 'false');
  await expect(reopened.getByTestId('freeze-link-result').locator('time')).toHaveAttribute('datetime', first);
  // Changes nothing: the freeze reads the same, and the sign-in made after the first use is still live and still the only one.
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  const still = await again.get(STATUS);
  expect(still.status).toBe(200);
  expect(still.body.result.data).toEqual(frozen);
  expect((await sessionsOf(again)).map((seat) => seat.id)).toEqual([listed[0].id]);

  // The bank's withdrawal guard refuses the frozen account by name.
  const refused = await withdrawalCheck(again);
  expect(refused.status).toBe(412);
  expect(refusalOf(refused)).toBe('bank.account_frozen_self');

  // Every agent permission stored for the person is revoked: the own agent's in svc-agents, and the trading agent's in
  // svc-trade's record of its run, which the freeze stopped, cancelling the agent's resting order on the venue.
  await expect
    .poll(async () => (await consentsOf(who, agentId)).map((c) => c.state), { timeout: 10_000, message: 'the agent kept its permission' })
    .toEqual(['withdrawn']);
  await expect
    .poll(async () => (await subRecord(venueAcct, agent.sub, '/open-orders')).length, {
      timeout: 10_000,
      message: 'the agent left an order open',
    })
    .toBe(0);
  await expect
    .poll(
      async () => {
        const r = body200(await again.get(`${LIVE}/${agent.runId}`));
        return { state: r.state, endReason: r.endReason, permission: r.permission };
      },
      { timeout: 10_000, message: 'the freeze did not stop the trading agent' },
    )
    .toEqual({ state: 'stopped', endReason: 'account_frozen', permission: 'revoked' });
  // An agent order: the trading agent's next order, sent on its run, is refused with the freeze.
  const run = body200(await again.get(`${LIVE}/${agent.runId}`));
  const agentOrder = await again.post(`${LIVE}/${agent.runId}/orders`, {
    seq: run.nextSeq,
    side: 'buy',
    type: 'limit',
    symbol: SYMBOL,
    size: BLOCK,
    price: '50000',
  });
  expect(agentOrder.body?.intafacedCode ?? codeOn(agentOrder), JSON.stringify(agentOrder.body)).toBe('quant.account_frozen');
  // Nothing reached the venue: the agent's sub-account has no order and no fill since the freeze and keeps its position,
  // and the person's own main account holds what it held, with no order on it.
  expect(await subRecord(venueAcct, agent.sub, '/open-orders')).toEqual([]);
  expect(await subRecord(venueAcct, agent.sub, '/fills', { since: first })).toEqual([]);
  expect((await openPositions(venueAcct, agent.sub)).map((x) => x.size)).toEqual([BLOCK]);
  await venueUntouched(venueAcct);

  // Signed in again to the freeze, the wallet room tells the person their funds stay in their own wallet and venue account.
  const wallet = await (await browser.newContext()).newPage();
  await signInFrozen(wallet, who);
  await wallet.goto('/wallet/venue');
  const notice = wallet.getByTestId('own-freeze-notice');
  await expect(notice).toContainText(FUNDS);
  await stepPicture(wallet);
});

/** The person's own agent's consents, as svc-agents holds them, read on a sign-in of its own. */
async function consentsOf(who, agentId) {
  return body200(await (await api(who)).get(query('/api/agents/trpc/own.consents.list', { id: agentId }))).result.data;
}

test(`${J} #3 Signing in again after freezing lands on a typed "frozen by you" page with the lift path, not a generic error`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const who = person('jg');
  await signUpInBrowser(page, who);
  await verifiedAgain(page, who);
  const venueAcct = await ownVenueAccount();
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
  await freezeOwn(page, who);

  // The sign-in succeeds and lands on the person's own freeze, typed from identity's account status, with no refusal.
  const frozen = await signInFrozen(page, who);
  await expect(frozen).toHaveAttribute('data-state', 'frozen_self');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You froze this account');
  await expect(frozen.getByTestId('frozen-by-you__since')).toHaveText(/^Frozen on .+\.$/);
  // The stack's TEST wait (IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20) has not passed, so the page says from when.
  const lift = frozen.getByTestId('frozen-by-you__lift');
  await expect(lift).toHaveAttribute('data-lift', 'liftAt');
  await expect(lift).toHaveText(/^You can reactivate it yourself from .+, in Security, with your authenticator code or a passkey\.$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('failure')).toHaveCount(0);

  // The page states what identity holds: the same account reads frozen by its owner, with one self freeze.
  const own = await api(who);
  const read = await own.get('/api/identity/trpc/accountStatus.mine');
  expect(read.status).toBe(200);
  expect(read.body.result.data.state).toBe('frozen_self');
  expect(read.body.result.data.restrictions.map((restriction) => restriction.kind)).toEqual(['self_freeze']);
  // What the page says the freeze stops is exactly what identity's guard refuses for it.
  const stops = await frozen
    .getByTestId('frozen-by-you__stops')
    .locator('li')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-action')));
  expect(stops).toEqual(read.body.result.data.restrictions[0].blocks);
  expect(stops.length).toBeGreaterThan(0);
  // Frozen and signed in again, the person's own venue account holds what the desk showed before the freeze.
  await venueUntouched(venueAcct);

  // The step's screen, before the person follows its lift path.
  await stepPicture(page);
  // The lift path: Security holds the reactivation for this freeze.
  await frozen.getByRole('button', { name: 'Reactivate in Security' }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await expect(card.getByRole('button', { name: 'Reactivate my account' })).toBeVisible();
});

test(`${J} #4 Asking to reactivate before the wait is over is refused with the seconds left; after it, step-up lifts the freeze`, async ({
  page,
  browser,
  stepPicture,
}) => {
  // The stack's waiting time is the TEST owner value IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20; a blank one refuses
  // (svc-identity self-freeze-lift tests). The lift needs a second factor, so the person adds an authenticator app.
  test.setTimeout(240_000);
  const who = person('jr');
  await signUpInBrowser(page, who);
  await verifiedAgain(page, who);
  const venueAcct = await ownVenueAccount();
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);

  // The person freezes their own account from Security; every session ends.
  const frozenAt = await freezeOwn(page, who);

  // They sign in again and Account status names their own freeze.
  await signInFrozen(page, who);
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'frozen_self');
  await expect(status.getByTestId('account-status__restrictions').locator('li[data-kind="self_freeze"]')).toHaveCount(1);

  // Too soon: the service refuses with the whole seconds left, and no confirmation is asked for.
  await page.goto('/uc/safe');
  const frozen = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const refusal = frozen.getByTestId('freeze__lift-refusal');
  await expect(refusal).toHaveText(/^Too soon\. You can reactivate in \d+ seconds?\.$/);
  const left = Number((await refusal.textContent()).match(/in (\d+) second/)[1]);
  const elapsed = Math.ceil((Date.now() - frozenAt) / 1000);
  expect(left).toBeGreaterThanOrEqual(1);
  expect(left).toBeLessThanOrEqual(20);
  expect(left + elapsed).toBeGreaterThanOrEqual(20);
  await expect(frozen.getByTestId('step-up-confirm')).toHaveCount(0);

  // The person adds an authenticator app (a freeze stops only new API keys), then waits out the rest.
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  const due = frozenAt + 21_000;
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());

  // After the wait: the same button asks for a fresh code, and the code lifts the freeze.
  await page.goto('/uc/safe');
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const confirm = frozen.getByTestId('step-up-confirm');
  await expect(confirm).toBeVisible();
  const next = await nextCode(totp, secret, step);
  await confirm.getByLabel('Authenticator code').fill(next.code);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Freeze your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You froze this account' })).toHaveCount(0);
  await stepPicture(page);

  // Account status agrees: nothing is restricted any more.
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);
  // Through the freeze and the lift the venue account was never touched, and the desk shows the venue's own figure again.
  await venueUntouched(venueAcct);
  expect(sameDecimal((await signedInDeskAgrees(page, venueAcct)).total, HELD)).toBe(true);
});

// A staff freeze refuses signing in, so the customer path (sign in, then reactivate) stops at the sign-in page, which
// names the freeze, says only support lifts it and points to the appeal. The appeal is filed signed out with the
// password, as the page says, and identity's appeal door holds it (I-account-lifecycle-12).
test(`${J} #5 A staff freeze shows its own page that only staff can lift, with the appeal path`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const who = person('js');
  await signUpInBrowser(page, who);
  await verifiedAgain(page, who);
  const venueAcct = await ownVenueAccount();
  expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
  const userId = await staffFreeze(who);
  let lifted = false;
  try {
    // The same path as #3: sign in again. Identity refuses it as frozen, named only after the password verified.
    await page.goto('about:blank');
    await signOutBrowser(page.context());
    await page.goto('/login');
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/auth.login'));
    await page.getByRole('button', { name: /^sign in$/i }).click();
    const refused = await (await answered).json();
    expect(typedCode(refused.error.data)).toBe('auth.account_frozen');
    expect(refused.error.data.accountState).toBe('frozen');
    const failure = page.getByTestId('failure');
    await expect(failure).toContainText('This account is frozen. Sign-in and money actions are paused. Only support can lift a freeze');
    // Not the person's own freeze: no reactivation is offered, only the appeal.
    await expect(page.getByTestId('frozen-by-you')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reactivate in Security' })).toHaveCount(0);
    // The staff freeze moved nothing on the person's own venue account.
    await venueUntouched(venueAcct);
    await failure.getByRole('link', { name: 'Appeal this freeze' }).click();
    await expect(page).toHaveURL(/\/appeal$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appeal a freeze');
    await expect(page.getByText('Only support can lift a freeze.')).toBeVisible();

    const form = page.getByTestId('appeal-signed-out__form');
    const send = async (password, text) => {
      await form.getByLabel('Email or handle').fill(who.email);
      await form.getByLabel('Password', { exact: true }).fill(password);
      await form.getByLabel('Why should the freeze be lifted?').fill(text);
      const res = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/accountAppeal.submitSignedOut'));
      await form.getByRole('button', { name: 'Send appeal' }).click();
      const got = await res;
      const body = await got.json();
      return { status: got.status(), data: body.result?.data, code: typedCode(body.error?.data) };
    };
    // A wrong password is the sign-in refusal, and files nothing.
    const wrong = await send(`${who.password}x`, 'TEST: please look again');
    expect(wrong.code).toBe('auth.invalid_credentials');
    await expect(page.locator('.lt-refusal .lt-ref')).toHaveText('auth.invalid_credentials');
    // With the password, the appeal of this staff freeze is filed and waits for a decision.
    const filed = await send(who.password, 'TEST: please look again');
    expect(filed.status, JSON.stringify(filed)).toBe(200);
    expect(filed.data).toMatchObject({ restriction: 'staff_freeze', status: 'submitted', decision: null });
    const result = page.getByTestId('appeal-signed-out__result');
    await expect(result).toHaveAttribute('data-status', 'submitted');
    await expect(result).toContainText('Waiting for a decision');
    // One open appeal: a second from a fresh page is refused by name, and still nothing else is filed.
    await page.goto('/appeal');
    const again = await send(who.password, 'TEST: a second appeal');
    expect(again.status).toBe(409);
    expect(again.code).toBe('identity.appeal_open');
    // The refusal is the flow template's, in words with the typed code small under them.
    const refusal = page.locator('.lt-refusal');
    await expect(refusal).toContainText('You already have an appeal waiting for this freeze. Only one can be open at a time.');
    await expect(refusal.locator('.lt-ref')).toHaveText('identity.appeal_open');

    // Only staff lift it: the founder who froze it cannot decide the appeal; the other founder lifts it through the
    // unfreeze four-eyes, and the person can sign in again.
    expect(tool('local-test-gates.mjs', 'appeal-decide', who.handle, 'lift', LIFT_REASON.code, '--as-restrictor')).toMatch(
      /REFUSED .* appeal lift: .*identity\.appeal_decider_restricted/,
    );
    expect(tool('local-test-gates.mjs', 'appeal-decide', who.handle, 'lift', LIFT_REASON.code)).toMatch(/OK .* appeal lift: lifted/);
    lifted = true;
    const own = await api(who);
    const status = await own.get('/api/identity/trpc/accountStatus.mine');
    expect(status.body.result.data.state).toBe('active');
    const appeals = await own.get('/api/identity/trpc/accountAppeal.mine');
    expect(appeals.body.result.data.appeals).toHaveLength(1);
    expect(appeals.body.result.data.appeals[0]).toMatchObject({
      restriction: 'staff_freeze',
      status: 'lifted',
      decision: { outcome: 'lifted', reason: LIFT_REASON },
    });
    await expect.poll(() => mailedLines(who.email, 'appeal-decided'), { timeout: 30_000 }).toHaveLength(1);
    // Lifted, the desk shows the venue account's own figure, unchanged through the freeze.
    await venueUntouched(venueAcct);
    expect(sameDecimal((await deskAgreesWithVenue(browser, who, venueAcct)).total, HELD)).toBe(true);
  } finally {
    if (!lifted) {
      try {
        await staffRestore(userId);
      } catch (error) {
        console.warn(`J-identity-11 #5: the restore after a failure failed too: ${error}`);
      }
    }
  }
});
