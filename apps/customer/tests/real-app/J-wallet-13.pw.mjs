// World: restart, stack
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, journeyState, signOutBrowser, staffFreeze, staffRestore, toUnits } from './stack.mjs';
import { makeKey, withKey } from './developer.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { browserHoldsPasskey } from './p2p.mjs';
import { OWN_AGENT, createOwnAgent } from './agents.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { body200 } from './answers.mjs';
import { TEST_VENUE, testDeposit, testVenue, venueAccount, venueForThisFile, venueRecord } from './venue.mjs';

// J-wallet-13, in the running app (docs/roadmap/journeys.json): I freeze everything in an emergency. One test per step,
// titled "J-wallet-13 #<n>", run in order on one TEST person: a verified account with a passkey and a live API key, its
// own TEST wallet holding TEST USDC on the stack's TEST venue simulator, and a live strategy running on a venue
// sub-account of that wallet through an agent permission the wallet signed (svc-trade quant/live-run). INTAFACED holds
// none of it and the ledger posts nothing: every figure of cash, orders and positions is the TEST venue's own record.
// A step whose earlier step left nothing stops at once with a named error.
const J = 'J-wallet-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const LIVE = '/api/v1/quant/live-runs';
const STATUS = '/api/identity/trpc/accountStatus.mine';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';
/** The stack's lift wait, the TEST owner value IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS. */
const WAIT_SECONDS = 20;
/** What the person is told about their funds, the same sentence wherever INTAFACED says it. */
const FUNDS = 'Your funds stay in your own wallet and venue account, which only your wallet controls.';

const codeOn = (res) =>
  res.body?.intafacedCode ??
  res.body?.error?.data?.intafacedCode ??
  res.body?.error?.data?.cause?.code ??
  res.body?.error?.data?.code ??
  res.body?.code ??
  null;

/** The person's own agent's consents, as svc-agents holds them, read on a sign-in of its own. */
async function consentsOf(who, agentId) {
  const query = `?input=${encodeURIComponent(JSON.stringify({ id: agentId }))}`;
  return body200(await (await api(who)).get(`/api/agents/trpc/own.consents.list${query}`)).result.data;
}

function state(...keys) {
  const s = run.read();
  for (const key of keys) if (s[key] === undefined) throw new Error(`an earlier step of ${J} left no ${key}`);
  return s;
}
const walletOf = (s) => privateKeyToAccount(s.walletKey);
const subRecord = async (s, path, extra = {}) => (await venueRecord(s.owner, path, extra, TEST_VENUE, s.sub)).value;
const openPositions = async (s) => (await subRecord(s, '/positions')).filter((p) => toUnits(p.size) > 0n);

/** The wallet signs one action on its own venue account (main or a sub-account) on the TEST venue directly. */
async function ownVenueAction(s, intent, subAccount = null) {
  const account = { ...(await venueAccount(s.owner)), subAccount };
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: s.owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const p = prepared.body.typedData;
  const signature = await walletOf(s).signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: s.owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
  return sent.body;
}

/** A sub-account of the wallet's own, funded with TEST USDC, the builder fee approved and BTC-PERP at 1x isolated. */
async function subAccount(s, session, name) {
  await ownVenueAction(s, { kind: 'create_sub_account', name, subAccountKey: `own:${J}:${name}:${Date.now()}` });
  const listed = (await venueRecord(s.owner, '/sub-accounts')).value.find((x) => x.name === name);
  expect(listed, `the venue lists no sub-account named ${name}`).toBeTruthy();
  const sub = listed.subAccount;
  await ownVenueAction(s, {
    kind: 'sub_account_transfer',
    subAccount: sub,
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: '200',
    moveKey: `own:${J}:${name}:fund:${Date.now()}`,
  });
  const status = body200(await session.get('/api/v1/venue/status'));
  await ownVenueAction(s, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps }, sub);
  await ownVenueAction(s, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 10_000, marginMode: 'isolated' }, sub);
  return sub;
}

/** Starts a live run on `s.sub` and has the wallet sign its agent permission; returns once its one block has filled. */
async function liveRun(s, session) {
  const runId = crypto.randomUUID();
  let view = body200(
    await session.post(LIVE, {
      runId,
      strategyId: s.strategyId,
      strategyVersion: 1,
      owner: s.owner,
      subAccount: s.sub,
      cap: '150',
      restartAttempts: '1',
      statePolicy: 'keep',
      liveControl: true,
    }),
  );
  expect(view.state).toBe('signing');
  const p = view.next.prepared;
  const signature = await walletOf(s).signTypedData({
    domain: p.typedData.domain,
    types: p.typedData.types,
    primaryType: p.typedData.primaryType,
    message: p.typedData.message,
  });
  view = body200(
    await session.post(`${LIVE}/${runId}/submit`, {
      actionKey: view.next.actionKey,
      signature: { digest: p.digest, signature, signedBy: s.owner },
    }),
  );
  expect(view.state).toBe('running');
  await expect.poll(async () => (await openPositions(s)).map((x) => x.size), { timeout: 20_000 }).toEqual([BLOCK]);
  return runId;
}

/** Freezes the person's own account on Safe (/uc/safe) with their password. Returns the time just before the press. */
async function freezeOnSafe(page, who) {
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account', exact: true }) });
  // Before the press the card says what the freeze does, all of it at once.
  await expect(card).toContainText(
    'Freezing applies at once: every device is signed out, every API key and every permission you gave an agent or app is revoked, and your scheduled agent orders stop.',
  );
  await card.getByLabel('Your password', { exact: true }).fill(who.password);
  const at = Date.now();
  await card.getByRole('button', { name: 'Freeze my account', exact: true }).click();
  await expect(
    page
      .getByRole('heading', { name: 'You froze this account', exact: true })
      .or(page.getByRole('heading', { name: 'Sign in to continue', exact: true })),
  ).toBeVisible();
  return at;
}

/** Signs in again through /login to an account its owner froze; the sign-in lands on that freeze. */
async function signInFrozen(page, who) {
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByTestId('frozen-by-you')).toBeVisible();
}

test(`${J} #1 Presses Freeze on Safe: at once every session ends, every agent permission stored for the person is revoked, and their scheduled agent orders stop`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  // A verified person with a passkey (only such an account holds an API key), a live key, and their own TEST wallet.
  // The passkey is a TEST key in this browser's virtual authenticator; it is kept for #2, which uses it again.
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  const who = await signUp(page, 'wf');
  await verify(page, who);
  await signIn(page, who);
  await addPasskey(page);
  const key = await makeKey(page, { name: 'freeze-all', preset: 'Read only' });
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '2000', `deposit:${J}:${owner}:${Date.now()}`);
  const session = await api(who);
  const saved = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: 'TEST freeze block',
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: `${J}:${owner}:strategy`,
      idempotencyKey: `${J}:${owner}:save`,
    }),
  ).result.data;
  const s = { who, walletKey, owner, strategyId: saved.id };
  s.sub = await subAccount(s, session, `${J}-agent`);
  // A scheduled agent order: the strategy runs live through the wallet's signed agent permission, with a manual limit
  // order of the run's resting on the venue.
  s.runId = await liveRun(s, session);
  const detail = body200(await session.get(`${LIVE}/${s.runId}`));
  expect(detail).toMatchObject({ state: 'running', permission: 'active' });
  body200(
    await session.post(`${LIVE}/${s.runId}/orders`, {
      seq: detail.nextSeq,
      side: 'buy',
      type: 'limit',
      symbol: SYMBOL,
      size: BLOCK,
      price: '50000',
    }),
  );
  expect(await subRecord(s, '/open-orders')).toHaveLength(1);
  // A stored agent permission in svc-agents: the person's own agent, allowed to use their own data.
  await createOwnAgent(page);
  const mine = body200(await session.get(`/api/agents/trpc/own.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  s.agentId = mine.result.data.find((row) => row.name === OWN_AGENT).id;
  body200(await session.post('/api/agents/trpc/own.consents.grant', { id: s.agentId, dataClass: 'own_data' }));
  expect(await consentsOf(who, s.agentId)).toEqual([expect.objectContaining({ dataClass: 'own_data', state: 'granted', revokedAt: null })]);
  // Before the freeze the key and the sign-in both answer.
  expect((await withKey(key, { path: STATUS })).status).toBe(200);
  expect((await session.get(STATUS)).status).toBe(200);

  const frozenAt = await freezeOnSafe(page, who);
  s.frozenAt = frozenAt;
  const [credential] = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  s.passkey = {
    credentialId: Buffer.from(credential.credentialId, 'base64').toString('base64url'),
    privateKey: credential.privateKey,
    signCount: credential.signCount,
  };
  run.reset(s);

  // At once: the run is stopped, its open order cancelled on the venue and its agent permission revoked in svc-trade's
  // own record, without waiting for anyone to open it. The position stays in the person's own sub-account.
  const fresh = await api(who);
  await expect
    .poll(async () => (await subRecord(s, '/open-orders')).length, { timeout: 10_000, message: 'the run left an order open on the venue' })
    .toBe(0);
  expect((await openPositions(s)).map((x) => x.size)).toEqual([BLOCK]);
  const after = body200(await fresh.get(`${LIVE}/${s.runId}`));
  expect(after).toMatchObject({ state: 'stopped', endReason: 'account_frozen', permission: 'revoked' });
  expect(after.log.map((e) => e.kind)).toEqual(expect.arrayContaining(['stopped', 'permission_revoked']));
  expect(Date.parse(after.log.find((e) => e.kind === 'permission_revoked').at)).toBeLessThan(frozenAt + 10_000);
  // The own agent's permission is revoked in svc-agents' own record too.
  await expect
    .poll(async () => (await consentsOf(who, s.agentId)).map((c) => c.state), { timeout: 10_000, message: 'the agent kept its permission' })
    .toEqual(['withdrawn']);
  // The agent signed nothing on the sub-account since the freeze.
  expect(await subRecord(s, '/fills', { since: new Date(frozenAt).toISOString() })).toEqual([]);

  // Every session ends and the key is revoked: the sign-in made before the freeze and the key both answer revoked.
  // Edge may hold a sign-in's authority for its cache window, so each is read until that window has passed.
  const { EDGE_AUTHORITY_CACHE_MAX_MS } = await import(path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'));
  const window = { timeout: EDGE_AUTHORITY_CACHE_MAX_MS + 5_000 };
  await expect.poll(async () => (await session.get(STATUS)).status, window).toBe(401);
  await expect.poll(async () => (await withKey(key, { path: STATUS })).status, window).toBe(401);
  const oldKey = await withKey(key, { path: STATUS });
  // Revoked, said by Edge once its cache knows, or by identity behind it before then.
  expect(codeOn(oldKey)).toMatch(/^(edge|auth)\.api_key_revoked$/);
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
  const read = body200(await fresh.get(STATUS)).result.data;
  expect(read.state).toBe('frozen_self');
});

test(`${J} #2 Tries an agent order, a permission change and a new key: each refused with the freeze reason`, async ({ browser }) => {
  test.setTimeout(180_000);
  const s = state('who', 'runId', 'sub', 'owner', 'walletKey', 'strategyId', 'passkey', 'agentId');
  // Signed in again (to the freeze) in a browser that holds the person's passkey.
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await browserHoldsPasskey(page, s.passkey);
  await signInFrozen(page, s.who);
  const session = await api(s.who);
  const detail = body200(await session.get(`${LIVE}/${s.runId}`));

  // An agent order: the run's manual order and a new live start are refused with the freeze; nothing reaches the venue.
  const order = await session.post(`${LIVE}/${s.runId}/orders`, {
    seq: detail.nextSeq,
    side: 'buy',
    type: 'limit',
    symbol: SYMBOL,
    size: BLOCK,
    price: '50000',
  });
  expect(codeOn(order), JSON.stringify(order.body)).toBe('quant.account_frozen');
  expect(JSON.stringify(order.body)).toContain('froze');
  const start = await session.post(LIVE, {
    runId: crypto.randomUUID(),
    strategyId: s.strategyId,
    strategyVersion: 1,
    owner: s.owner,
    subAccount: s.sub,
    cap: '150',
    restartAttempts: '1',
    statePolicy: 'keep',
    liveControl: true,
  });
  expect(codeOn(start), JSON.stringify(start.body)).toBe('quant.account_frozen');
  expect(await subRecord(s, '/open-orders')).toEqual([]);

  // A new key: the form answers in words that the person froze the account, and nothing was created.
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name', { exact: true }).fill('after-freeze');
  await page.getByLabel('Read only', { exact: true }).check();
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/developerKeys.create'));
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  const res = await answered;
  expect(codeOn({ body: await res.json() })).toBe('identity.account_frozen_self');
  await expect(
    page.getByText('You froze this account, so no new API key can be made. Nothing was created. Reactivate it in Security first.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your new key', exact: true })).toHaveCount(0);

  // A permission change: giving an agent an account of its own on the person's venue account is refused with the
  // freeze before anything is asked of the wallet, and no account is made.
  const made = await session.post('/api/v1/venue/agent-accounts', {
    accountId: crypto.randomUUID(),
    owner: s.owner,
    asset: 'USDC',
    cap: '100',
    fund: '50',
  });
  expect(made.status, JSON.stringify(made.body)).toBe(423);
  expect(codeOn(made), JSON.stringify(made.body)).toBe('trade.account_frozen_self');
  expect(JSON.stringify(made.body)).toContain('you froze this account');
  expect(JSON.stringify(made.body)).toContain(FUNDS.slice(5));
  const listed = body200(await session.get('/api/v1/venue/agent-accounts'));
  expect(listed.accounts).toEqual([]);
  // Allowing the person's own agent again is refused with the freeze too, and it stays revoked.
  const consent = await session.post('/api/agents/trpc/own.consents.grant', { id: s.agentId, dataClass: 'own_data' });
  expect(codeOn(consent), JSON.stringify(consent.body)).toBe('agents.identity.owner_frozen_self');
  expect((await consentsOf(s.who, s.agentId)).map((c) => c.state)).toEqual(['withdrawn']);
});

test(`${J} #3 Looks at the wallet: a notice that funds stay in their own wallet and venue account, which only their wallet controls`, async ({
  browser,
}) => {
  const s = state('who');
  const page = await (await browser.newContext()).newPage();
  await signInFrozen(page, s.who);
  for (const room of ['/wallet', '/wallet/venue']) {
    await page.goto(room);
    const notice = page.getByTestId('own-freeze-notice');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('heading', { name: 'Your account is frozen', exact: true })).toBeVisible();
    await expect(notice).toContainText(FUNDS);
    await expect(notice).toContainText('INTAFACED takes no action for you while the freeze holds.');
  }
  // The person's own wallet still controls the sub-account: it moves TEST USDC out of it on the venue, frozen or not.
  const st = state('owner', 'sub', 'walletKey');
  const cash = async () => (await subRecord(st, '/balances')).find((b) => b.asset === 'USDC')?.free ?? '0';
  const before = toUnits(await cash());
  await ownVenueAction(st, {
    kind: 'sub_account_transfer',
    subAccount: st.sub,
    direction: 'out_of_sub_account',
    asset: 'USDC',
    amount: '1',
    moveKey: `own:${J}:out:${Date.now()}`,
  });
  expect(toUnits(await cash())).toBe(before - toUnits('1'));
});

/** Presses Reactivate on the frozen card and confirms with the person's passkey; the account reads active again. */
async function reactivate(page) {
  await page.goto('/uc/safe');
  const frozen = page
    .getByTestId('security__card')
    .filter({ has: page.getByRole('heading', { name: 'You froze this account', exact: true }) });
  await frozen.getByRole('button', { name: 'Reactivate my account', exact: true }).click();
  const confirm = frozen.getByTestId('step-up-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(
    page.getByText(
      'Your account is active again. Your other devices stay signed out; sign in there again to use them. Revoked agent permissions and API keys stay revoked: sign a new permission for any agent you want back.',
      { exact: true },
    ),
  ).toBeVisible();
}

/** Waits until `seconds` have passed since `at` (ms), plus one second of margin. */
async function waitOut(page, at, seconds) {
  const due = at + (seconds + 1) * 1000;
  // svc-identity has no test-age door for a freeze, so the owner's TEST wait (20 s) is waited out on the clock.
  // oxlint-disable-next-line garden/no-wait-for-timeout -- the lift wait is an identity expiry with no test-age door
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());
}

test(`${J} #4 Asks to unfreeze before the wait is over, then after it: refused with the seconds left, then step-up reactivates; a staff freeze also needs staff; agent permissions must be signed again`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = state('who', 'frozenAt', 'runId', 'sub', 'owner', 'walletKey', 'strategyId', 'agentId', 'passkey');
  // Signed in again (to the freeze) in a browser holding the person's passkey, its counter past #2's use of it.
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await browserHoldsPasskey(page, { ...s.passkey, signCount: s.passkey.signCount + 100 });
  await signInFrozen(page, s.who);
  // The freeze of #1 is past its wait: step-up with the passkey reactivates it.
  await waitOut(page, s.frozenAt, WAIT_SECONDS);
  await reactivate(page);
  const session = await api(s.who);
  expect(body200(await session.get(STATUS)).result.data.state).toBe('active');

  // Agent permissions must be signed again: the run's permission stays revoked after the lift and the run stays
  // stopped; a new run asks the wallet to sign a new permission before it can trade.
  expect(body200(await session.get(`${LIVE}/${s.runId}`))).toMatchObject({ state: 'stopped', permission: 'revoked' });
  const again = body200(
    await session.post(LIVE, {
      runId: crypto.randomUUID(),
      strategyId: s.strategyId,
      strategyVersion: 1,
      owner: s.owner,
      subAccount: s.sub,
      cap: '150',
      restartAttempts: '1',
      statePolicy: 'keep',
      liveControl: true,
    }),
  );
  expect(again.state).toBe('signing');
  expect(again.next?.prepared?.typedData, 'a new run asks the wallet for a new signature').toBeTruthy();
  // The own agent's permission stays revoked until the person allows it again, which now works.
  expect((await consentsOf(s.who, s.agentId)).map((c) => c.state)).toEqual(['withdrawn']);
  body200(await session.post('/api/agents/trpc/own.consents.grant', { id: s.agentId, dataClass: 'own_data' }));
  expect((await consentsOf(s.who, s.agentId)).map((c) => c.state)).toEqual(['granted']);

  // Before the wait is over: the person freezes again and at once asks to reactivate. Refused with the whole seconds
  // left, and no confirmation is asked for.
  await page.goto('/uc/safe');
  const second = await freezeOnSafe(page, s.who);
  await signInFrozen(page, s.who);
  await page.goto('/uc/safe');
  const frozen = page
    .getByTestId('security__card')
    .filter({ has: page.getByRole('heading', { name: 'You froze this account', exact: true }) });
  await frozen.getByRole('button', { name: 'Reactivate my account', exact: true }).click();
  const refusal = frozen.getByTestId('freeze__lift-refusal');
  await expect(refusal).toHaveText(/^Too soon\. You can reactivate in \d+ seconds?\.$/);
  const left = Number((await refusal.textContent()).match(/in (\d+) second/)[1]);
  const elapsed = Math.ceil((Date.now() - second) / 1000);
  expect(left).toBeGreaterThanOrEqual(1);
  expect(left).toBeLessThanOrEqual(WAIT_SECONDS);
  expect(left + elapsed).toBeGreaterThanOrEqual(WAIT_SECONDS);
  await expect(frozen.getByTestId('step-up-confirm')).toHaveCount(0);
  // After the wait: step-up and reactivation succeed.
  await waitOut(page, second, WAIT_SECONDS);
  await reactivate(page);

  // A staff freeze also needs staff: frozen by the person and by staff, the person cannot reach their own lift (the
  // sign-in is refused, naming that only support lifts it). Once staff lift theirs, the person's own freeze is still
  // there and is theirs to lift.
  await freezeOnSafe(page, s.who);
  const userId = await staffFreeze(s.who);
  try {
    await page.goto('about:blank');
    await signOutBrowser(page.context());
    await page.goto('/login');
    await page.fill('input[name=identifier]', s.who.email);
    await page.fill('input[name=password]', s.who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByTestId('failure')).toContainText('Only support can lift a freeze');
    await expect(page.getByTestId('frozen-by-you')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reactivate in Security', exact: true })).toHaveCount(0);
  } finally {
    await staffRestore(userId);
  }
  await signInFrozen(page, s.who);
  const status = body200(await (await api(s.who)).get(STATUS)).result.data;
  expect(status.state).toBe('frozen_self');
  expect(status.restrictions.map((r) => r.kind)).toEqual(['self_freeze']);
});
