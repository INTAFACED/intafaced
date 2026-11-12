// World: restart
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { testDeposit, testVenue, venueAccount, venueForThisFile, venueRecord } from './venue.mjs';

// J-algo-dev-07, in the running app (docs/roadmap/journeys.json): stop, liquidate or recover a live strategy. One test
// per step, titled "J-algo-dev-07 #<n>", run in order. A TEST pro-trader's own TEST wallet holds TEST USDC on the stack's
// TEST venue simulator and opens one venue sub-account per run, each funded by the wallet's own signed move; a strategy
// of one order block (buy 0.001 BTC-PERP) runs live on each, through an agent permission the wallet signs for that run's
// key only (svc-trade src/quant/live-run/). INTAFACED holds none of it and the ledger posts nothing: every check of cash,
// orders, positions and fills reads the TEST venue's own record of the sub-account. Every figure is TEST.
// The start ("a live strategy with an open limit order and a position") is made through the services the deploy wizard
// of J-algo-dev-06 calls, as the person: the strategy saved in svc-quant, the run started and its permission signed, the
// block filled, and a manual limit order resting. The sub-accounts are opened and funded by the wallet on the TEST venue
// directly, as in J-agents-08: a customer cannot open plain sub-accounts in the app yet.
const J = 'J-algo-dev-07';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const LIVE = '/api/v1/quant/live-runs';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';

const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};

/** One TEST trader: an account, its own TEST wallet, a block strategy saved in svc-quant, and USDC on the venue. */
async function trader(page, prefix) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '2000', `deposit:${J}:${prefix}:${Date.now()}`);
  const session = await api(who);
  const saved = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: `TEST live block ${prefix}`,
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      clientStrategyId: `${J}:${prefix}:strategy`,
      idempotencyKey: `${J}:${prefix}:save`,
    }),
  ).result.data;
  return { who, walletKey, owner, strategyId: saved.id };
}

const walletOf = (t) => privateKeyToAccount(t.walletKey);

/** The wallet signs one action on its own venue account (main or a sub-account) on the TEST venue directly. */
async function ownVenueAction(t, intent, subAccount = null) {
  const account = { ...(await venueAccount(t.owner)), subAccount };
  const prepared = await testVenue('/prepare', { account, signer: { role: 'owner', address: t.owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const p = prepared.body.typedData;
  const signature = await walletOf(t).signTypedData({ domain: p.domain, types: p.types, primaryType: p.primaryType, message: p.message });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: t.owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.accepted, JSON.stringify(sent.body)).toBe(true);
  return sent.body;
}

/** A sub-account of the wallet's own, funded with TEST USDC, our builder fee approved and BTC-PERP set to 1x isolated. */
async function subAccount(t, session, name) {
  await ownVenueAction(t, { kind: 'create_sub_account', name, subAccountKey: `own:${J}:${name}:${Date.now()}` });
  const listed = (await venueRecord(t.owner, '/sub-accounts')).value.find((s) => s.name === name);
  expect(listed, `the venue lists no sub-account named ${name}`).toBeTruthy();
  const sub = listed.subAccount;
  await ownVenueAction(t, {
    kind: 'sub_account_transfer',
    subAccount: sub,
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: '200',
    moveKey: `own:${J}:${name}:fund:${Date.now()}`,
  });
  const status = body200(await session.get('/api/v1/venue/status'));
  await ownVenueAction(t, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps }, sub);
  await ownVenueAction(t, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 10_000, marginMode: 'isolated' }, sub);
  return sub;
}

/** The TEST venue's own record of a sub-account. */
async function subRecord(t, sub, path, extra = {}) {
  const { status, body } = await testVenue(path, { account: { ...(await venueAccount(t.owner)), subAccount: sub }, ...extra });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.value;
}
const openPositions = async (t, sub) => (await subRecord(t, sub, '/positions')).filter((p) => toUnits(p.size) > 0n);
const fillsOf = (t, sub) => subRecord(t, sub, '/fills', { since: '2020-01-01T00:00:00.000Z' });

/** Starts a live run of the trader's strategy on `sub` and signs its agent permission; returns once its block has filled. */
async function liveRun(t, session, sub, over = {}) {
  const runId = crypto.randomUUID();
  let view = body200(
    await session.post(LIVE, {
      runId,
      strategyId: t.strategyId,
      strategyVersion: 1,
      owner: t.owner,
      subAccount: sub,
      cap: '150',
      restartAttempts: '1',
      statePolicy: 'keep',
      liveControl: true,
      ...over,
    }),
  );
  expect(view.state).toBe('signing');
  const p = view.next.prepared;
  const signature = await walletOf(t).signTypedData({
    domain: p.typedData.domain,
    types: p.typedData.types,
    primaryType: p.typedData.primaryType,
    message: p.typedData.message,
  });
  view = body200(
    await session.post(`${LIVE}/${runId}/submit`, {
      actionKey: view.next.actionKey,
      signature: { digest: p.digest, signature, signedBy: t.owner },
    }),
  );
  expect(view.state).toBe('running');
  // The run's process places the strategy's one block; the venue fills it.
  await expect
    .poll(async () => (await openPositions(t, sub)).map((x) => x.size), { timeout: 20_000 })
    .toEqual([expect.stringMatching(/^0\.001$/)]);
  return runId;
}

/** A manual limit order for the run, under its next sequence number, resting below the market. */
async function restingLimit(session, runId) {
  const detail = body200(await session.get(`${LIVE}/${runId}`));
  return body200(
    await session.post(`${LIVE}/${runId}/orders`, {
      seq: detail.nextSeq,
      side: 'buy',
      type: 'limit',
      symbol: SYMBOL,
      size: BLOCK,
      price: '50000',
    }),
  );
}

const room = (page) => page.getByTestId('live-run');

function state() {
  const s = run.read();
  if (!s.trader) throw new Error(`${J} #1 made no trader, so this step has no one to act as`);
  return s;
}

test(`${J} #1 opens the live run and presses Stop: the open order is cancelled, the position is kept, the state reads stopped; a second Stop with the same key changes nothing`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const t = await trader(page, 'ad7');
  run.reset({ trader: t });
  const session = await api(t.who);
  const subs = {};
  for (const name of ['stop', 'liquidate', 'manual', 'nogrant', 'recover']) subs[name] = await subAccount(t, session, `${J}-${name}`);
  run.write({ subs });
  const runId = await liveRun(t, session, subs.stop);
  await restingLimit(session, runId);
  run.write({ stopRun: runId });
  expect(await subRecord(t, subs.stop, '/open-orders')).toHaveLength(1);

  await signIn(page, t.who);
  await page.goto(`/quant/live/${runId}`);
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'running');
  await expect(room(page).getByTestId('live-run-open-order')).toHaveCount(1);
  await expect(room(page).getByTestId('live-run-position')).toHaveAttribute('data-size', BLOCK);

  await room(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(room(page).getByTestId('live-run-note')).toHaveText('Stopped. Open orders are cancelled; the position is kept.');
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'stopped');
  await expect(room(page).getByTestId('live-run-reason')).toHaveAttribute('data-reason', 'user_stop');
  await expect(room(page).getByTestId('live-run-no-open-order')).toBeVisible();
  await expect(room(page).getByTestId('live-run-position')).toHaveAttribute('data-size', BLOCK);
  // The venue's own record: no open order, the position kept.
  expect(await subRecord(t, subs.stop, '/open-orders')).toEqual([]);
  expect((await openPositions(t, subs.stop)).map((x) => x.size)).toEqual([BLOCK]);

  // The same Stop again (same key, algo:stop:<run>:1), from the page and from the API: nothing changes.
  const fills = (await fillsOf(t, subs.stop)).length;
  const before = body200(await session.get(`${LIVE}/${runId}`));
  await room(page).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'stopped');
  const again = body200(await session.post(`${LIVE}/${runId}/stop`, { seq: before.stopSeq }));
  expect(again).toMatchObject({ state: 'stopped', stopSeq: before.stopSeq, nextSeq: before.nextSeq, endReason: 'user_stop' });
  expect(await fillsOf(t, subs.stop)).toHaveLength(fills);
  expect(await subRecord(t, subs.stop, '/open-orders')).toEqual([]);
  expect(body200(await session.get(`${LIVE}/${runId}`)).orders).toHaveLength(before.orders.length);
});

test(`${J} #2 presses Liquidate on another run: a reduce-only order closes the position once and the run ends flat`, async ({ page }) => {
  test.setTimeout(180_000);
  const { trader: t, subs } = state();
  const session = await api(t.who);
  const runId = await liveRun(t, session, subs.liquidate);
  run.write({ liquidateRun: runId });

  await signIn(page, t.who);
  await page.goto(`/quant/live/${runId}`);
  await expect(room(page).getByTestId('live-run-position')).toHaveAttribute('data-size', BLOCK);
  await room(page).getByRole('button', { name: 'Liquidate', exact: true }).click();
  await room(page).getByRole('button', { name: 'Confirm liquidation' }).click();
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'flat');
  await expect(room(page).getByTestId('live-run-reason')).toHaveAttribute('data-reason', 'liquidated');
  await expect(room(page).getByTestId('live-run-no-position')).toBeVisible();
  const close = room(page).locator('[data-testid="live-run-order"][data-kind="liquidate"]');
  await expect(close).toHaveCount(1);
  await expect(close).toHaveAttribute('data-reduce-only', 'true');
  await expect(close).toHaveAttribute('data-key', new RegExp(`^algo:liquidate:${runId}:\\d+$`));

  // The venue's own record: flat, closed by exactly one reduce-only sell of the block's size.
  expect(await openPositions(t, subs.liquidate)).toEqual([]);
  const sells = (await fillsOf(t, subs.liquidate)).filter((f) => f.side === 'sell');
  expect(sells.reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(toUnits(BLOCK));
  // Pressed again (the same press), nothing more is sent.
  const out = body200(await session.post(`${LIVE}/${runId}/liquidate`, { seq: 1 }));
  expect(out.run.state).toBe('flat');
  expect((await fillsOf(t, subs.liquidate)).filter((f) => f.side === 'sell')).toHaveLength(sells.length);
  expect(body200(await session.get(`${LIVE}/${runId}`)).orders.filter((o) => o.kind === 'liquidate')).toHaveLength(1);
});

test(`${J} #3 sends a manual order to a running strategy twice with the same sequence: one order; without the live-control grant the typed permission refusal`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { trader: t, subs } = state();
  const session = await api(t.who);
  const granted = await liveRun(t, session, subs.manual);
  const withheld = await liveRun(t, session, subs.nogrant, { liveControl: false });

  await signIn(page, t.who);
  await page.goto(`/quant/live/${granted}`);
  const form = room(page).getByRole('form', { name: 'Manual order' });
  const seq = String(body200(await session.get(`${LIVE}/${granted}`)).nextSeq);
  await expect(form.getByLabel('Sequence')).toHaveValue(seq);
  await form.getByLabel('Size').fill(BLOCK);
  await form.getByLabel('Limit price').fill('50000');
  await form.getByRole('button', { name: 'Send order' }).click();
  await expect(room(page).getByTestId('live-run-manual-note')).toHaveText(`Order under sequence ${seq}: accepted by the venue.`);
  // The page re-reads the run: the same sequence is still in the form after a reload of its fields; send it again.
  await page.reload();
  await room(page).getByRole('form', { name: 'Manual order' }).getByLabel('Sequence').fill(seq);
  await room(page).getByRole('form', { name: 'Manual order' }).getByLabel('Size').fill(BLOCK);
  await room(page).getByRole('form', { name: 'Manual order' }).getByLabel('Limit price').fill('50000');
  await room(page).getByRole('form', { name: 'Manual order' }).getByRole('button', { name: 'Send order' }).click();
  await expect(room(page).getByTestId('live-run-manual-note')).toHaveText(`Order under sequence ${seq}: accepted by the venue.`);
  // One order: one manual row in the run's orders and one resting order on the venue.
  await expect(room(page).locator('[data-testid="live-run-order"][data-kind="manual"]')).toHaveCount(1);
  await expect(room(page).locator('[data-testid="live-run-order"][data-kind="manual"]')).toHaveAttribute(
    'data-key',
    `algo:order:${granted}:${seq}`,
  );
  expect(await subRecord(t, subs.manual, '/open-orders')).toHaveLength(1);

  // The run deployed without the live-control grant refuses it, typed, and nothing reaches the venue.
  await page.goto(`/quant/live/${withheld}`);
  const denied = room(page).getByRole('form', { name: 'Manual order' });
  await denied.getByLabel('Size').fill(BLOCK);
  await denied.getByLabel('Limit price').fill('50000');
  await denied.getByRole('button', { name: 'Send order' }).click();
  await expect(room(page).getByTestId('live-run-refusal')).toHaveAttribute('data-code', 'quant.permission_denied');
  await expect(room(page).getByTestId('live-run-refusal')).toContainText('without the live-control grant');
  expect(await subRecord(t, subs.nogrant, '/open-orders')).toEqual([]);
  const res = await session.post(`${LIVE}/${withheld}/orders`, {
    seq: 2,
    side: 'buy',
    type: 'limit',
    symbol: SYMBOL,
    size: BLOCK,
    price: '50000',
  });
  expect(res.status).toBe(403);
  expect(res.body.intafacedCode).toBe('quant.permission_denied');
});

test(`${J} #4 watches a run whose process dies: unknown, reconciled by the original client order ids, restarted within the attempt limit from the venue; exhausted, it ends typed and places nothing`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { trader: t, subs } = state();
  const session = await api(t.who);
  const runId = await liveRun(t, session, subs.recover, { restartAttempts: '1', statePolicy: 'keep' });
  run.write({ recoverRun: runId });
  const kinds = async () => body200(await session.get(`${LIVE}/${runId}`)).log.map((e) => e.kind);

  await signIn(page, t.who);
  // The process dies: its heartbeat stops (TEST venue only). The run reads unknown until the next supervisor pass.
  body200(await session.post(`${LIVE}/${runId}/test/kill-process`, {}));
  await expect
    .poll(async () => body200(await session.get(`${LIVE}/${runId}`)).state, { timeout: 20_000, intervals: [100] })
    .toBe('unknown');
  await expect.poll(async () => body200(await session.get(`${LIVE}/${runId}`)).health.restarts, { timeout: 20_000 }).toBe(1);
  const restarted = body200(await session.get(`${LIVE}/${runId}`));
  expect(restarted.state).toBe('running');
  const log = restarted.log.map((e) => e.kind);
  expect(log.indexOf('unknown')).toBeLessThan(log.indexOf('reconciled'));
  expect(log.indexOf('reconciled')).toBeLessThan(log.indexOf('restarted'));
  // The reconciler read each of the run's orders back by its original client order id: the venue's own record under
  // that id is the order the run placed, and every fill on the sub-account carries it.
  expect(restarted.orders).toHaveLength(1);
  const [placed] = restarted.orders;
  const cloid = placed.order?.venueClientOrderId;
  expect(cloid, JSON.stringify(placed)).toBeTruthy();
  const byId = await subRecord(t, subs.recover, '/order-by-client-id', { venueClientOrderId: cloid });
  expect(byId).toMatchObject({ venueClientOrderId: cloid, symbol: SYMBOL, side: 'buy', amount: BLOCK });
  const venueFills = await fillsOf(t, subs.recover);
  expect(venueFills.length).toBeGreaterThan(0);
  expect(new Set(venueFills.map((f) => f.venueClientOrderId))).toEqual(new Set([cloid]));
  expect(restarted.log.find((e) => e.kind === 'reconciled').detail).toMatch(
    /^Reconciler read 1 order from the venue by their client order ids; 1 on record\.$/,
  );
  // Restarted from what the venue holds: its open orders and its position, as the venue reports them now.
  const venueOpen = await subRecord(t, subs.recover, '/open-orders');
  const venuePositions = await openPositions(t, subs.recover);
  expect(venuePositions.map((x) => x.size)).toEqual([BLOCK]);
  expect(restarted.log.find((e) => e.kind === 'restarted').detail).toContain(
    `reloaded ${venueOpen.length} open order${venueOpen.length === 1 ? '' : 's'} and ${venuePositions.length} position from the venue`,
  );
  // Reloaded from the venue, the block it placed before is not placed again.
  expect(restarted.orders).toHaveLength(1);

  await page.goto(`/quant/live/${runId}`);
  await expect(room(page).getByTestId('live-run-restarts')).toHaveAttribute('data-restarts', '1');

  // It dies again with its one restart spent: it ends with the typed reason and places no new order.
  const fills = (await fillsOf(t, subs.recover)).length;
  body200(await session.post(`${LIVE}/${runId}/test/kill-process`, {}));
  await expect.poll(async () => body200(await session.get(`${LIVE}/${runId}`)).state, { timeout: 20_000 }).toBe('ended');
  const ended = body200(await session.get(`${LIVE}/${runId}`));
  expect(ended).toMatchObject({ endReason: 'attempts_exhausted', health: { restarts: 1, restartAttempts: 1 } });
  expect(ended.orders).toHaveLength(1);
  expect(await fillsOf(t, subs.recover)).toHaveLength(fills);
  const res = await session.post(`${LIVE}/${runId}/orders`, {
    seq: ended.nextSeq,
    side: 'buy',
    type: 'market',
    symbol: SYMBOL,
    size: BLOCK,
  });
  expect(res.body.intafacedCode).toBe('quant.run_not_running');
});

test(`${J} #5 opens the run when the account freeze is on: the freeze stopped it and revoked its permission; a liquidate is refused with the freeze reason, the row stays, the position stays in the user's own venue account`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A trader of its own: the freeze ends every session of the account it freezes.
  const t = await trader(page, 'ad7f');
  const session = await api(t.who);
  const sub = await subAccount(t, session, `${J}-freeze`);
  const runId = await liveRun(t, session, sub);
  await restingLimit(session, runId);
  expect(await subRecord(t, sub, '/open-orders')).toHaveLength(1);

  // The person freezes their own account from Security; every session ends.
  await signIn(page, t.who);
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account' }) });
  await card.getByLabel('Your password').fill(t.who.password);
  await card.getByRole('button', { name: 'Freeze my account' }).click();

  // The freeze stops the run: its open order is cancelled on the venue; the position stays in the person's sub-account.
  await expect.poll(async () => (await subRecord(t, sub, '/open-orders')).length, { timeout: 20_000 }).toBe(0);
  expect((await openPositions(t, sub)).map((x) => x.size)).toEqual([BLOCK]);

  // Signed in again (to the freeze), the person opens the run.
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', t.who.email);
  await page.fill('input[name=password]', t.who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByTestId('frozen-by-you')).toBeVisible();
  await page.goto(`/quant/live/${runId}`);
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'stopped');
  await expect(room(page).getByTestId('live-run-reason')).toHaveAttribute('data-reason', 'account_frozen');
  await expect(room(page).getByTestId('live-run-permission')).toHaveAttribute('data-permission', 'revoked');
  await expect(room(page).getByTestId('live-run-frozen')).toContainText(
    'Your position stays in your own venue account, which only your wallet controls.',
  );
  // The run's stored agent permission is revoked in svc-trade's own record, as the person reads it.
  const frozenSession = await api(t.who);
  const detail = body200(await frozenSession.get(`${LIVE}/${runId}`));
  expect(detail).toMatchObject({ state: 'stopped', endReason: 'account_frozen', permission: 'revoked' });
  expect(detail.log.map((e) => e.kind)).toEqual(expect.arrayContaining(['stopped', 'permission_revoked']));
  // INTAFACED takes no action for the person: a manual order is refused with the freeze reason and reaches no venue.
  const manual = await frozenSession.post(`${LIVE}/${runId}/orders`, {
    seq: detail.nextSeq,
    side: 'buy',
    type: 'limit',
    symbol: SYMBOL,
    size: BLOCK,
    price: '50000',
  });
  expect(manual.body.intafacedCode, JSON.stringify(manual.body)).toBe('quant.account_frozen');
  expect(await subRecord(t, sub, '/open-orders')).toEqual([]);

  // A liquidation from INTAFACED is refused with the freeze reason; the row stays as it was and nothing reaches the venue.
  const fills = (await fillsOf(t, sub)).length;
  await room(page).getByRole('button', { name: 'Liquidate', exact: true }).click();
  await room(page).getByRole('button', { name: 'Confirm liquidation' }).click();
  await expect(room(page).getByTestId('live-run-refusal')).toHaveAttribute('data-code', 'quant.account_frozen');
  await page.reload();
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'stopped');
  await expect(room(page).getByTestId('live-run-reason')).toHaveAttribute('data-reason', 'account_frozen');
  await expect(room(page).locator('[data-testid="live-run-order"][data-kind="liquidate"]')).toHaveCount(0);
  await expect(room(page).getByTestId('live-run-position')).toHaveAttribute('data-size', BLOCK);
  expect(await fillsOf(t, sub)).toHaveLength(fills);
  expect((await openPositions(t, sub)).map((x) => x.size)).toEqual([BLOCK]);
  // The person's own wallet still controls the sub-account: it moves TEST USDC out of it on the venue, frozen or not.
  const cash = async () => (await subRecord(t, sub, '/balances')).find((b) => b.asset === 'USDC')?.free ?? '0';
  const before = toUnits(await cash());
  await ownVenueAction(t, {
    kind: 'sub_account_transfer',
    subAccount: sub,
    direction: 'out_of_sub_account',
    asset: 'USDC',
    amount: '1',
    moveKey: `own:${J}:freeze:out:${Date.now()}`,
  });
  expect(toUnits(await cash())).toBe(before - toUnits('1'));
  expect((await openPositions(t, sub)).map((x) => x.size)).toEqual([BLOCK]);
});

test(`${J} #6 reads the run's health and log: restart count, state kept or dropped and the termination reason; a blank restart-attempt setting refused the deploy`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { trader: t, subs, recoverRun } = state();
  if (!recoverRun) throw new Error(`${J} #4 made no recovered run, so this step has nothing to read`);
  const session = await api(t.who);

  await signIn(page, t.who);
  await page.goto(`/quant/live/${recoverRun}`);
  const health = room(page).getByTestId('live-run-health');
  await expect(health.getByTestId('live-run-restarts')).toHaveText('1 of 1');
  await expect(health.getByTestId('live-run-policy')).toHaveText('Kept');
  await expect(room(page).getByTestId('live-run-state')).toHaveAttribute('data-state', 'ended');
  await expect(room(page).getByTestId('live-run-reason')).toHaveText('Restart attempts exhausted');
  const log = room(page).getByTestId('live-run-log');
  await expect(log.locator('li[data-kind="restarted"]')).toContainText('strategy state kept');
  await expect(log.locator('li[data-kind="ended"]')).toContainText('Restart attempts exhausted');
  await expect(log.locator('li[data-kind="deployed"]')).toContainText('restart attempts 1');

  // The deploy with the restart-attempt setting left blank was refused by name, and no run was written.
  const runId = crypto.randomUUID();
  const res = await session.post(LIVE, {
    runId,
    strategyId: t.strategyId,
    strategyVersion: 1,
    owner: t.owner,
    subAccount: subs.recover,
    cap: '150',
    restartAttempts: '',
    statePolicy: 'keep',
    liveControl: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body).toMatchObject({ intafacedCode: 'quant.restart_attempts_unset', field: 'restartAttempts' });
  expect(body200(await session.get(LIVE)).runs.map((r) => r.runId)).not.toContain(runId);
  expect((await session.get(`${LIVE}/${runId}`)).status).toBe(404);
});
