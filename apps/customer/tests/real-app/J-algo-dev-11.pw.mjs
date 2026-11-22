// World: restart, gates
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { userIdOf } from './copy.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { TEST_VENUE, testDeposit, testVenue, venueAccount, venueForThisFile, venueRecord } from './venue.mjs';

// J-algo-dev-11, in the running app (docs/roadmap/journeys.json): the risk desk halts one strategy or every strategy.
// One test per step, titled "J-algo-dev-11 #<n>", run in order. Founders A and B are the stack's LOCAL TEST founder pair
// (admin.mjs) on the console's quant desk, /more-ops/quant (svc-trade src/quant/live-run/halts.ts).
// The start, "live runs present": two TEST traders, each with their own TEST wallet holding TEST USDC on the stack's TEST
// venue simulator, run strategies of one order block (buy 0.001 BTC-PERP) live on their own venue sub-accounts, as
// J-algo-dev-07 makes them: trader A runs strategy S1 twice (`exit`, `keep`) and strategy S2 once; trader B runs S3 once.
// INTAFACED holds none of it and the ledger posts nothing: every check of orders, positions and fills reads the TEST
// venue's own record. A halt is platform-wide, so every halt this file leaves standing is restored by two founders once
// the file is done, pass or fail.
const J = 'J-algo-dev-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 15_000 });
venueForThisFile(test);

const LIVE = '/api/v1/quant/live-runs';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';
const HALT_REASON = 'TEST risk review of S1';
const ALL_REASON = 'TEST halt every strategy';
const RESTORE_REASON = 'TEST S1 cleared';
const LIVE_STATES = ['signing', 'running', 'unknown'];

const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};

/** One TEST trader: an account, its own TEST wallet with USDC on the venue, and its user id. */
async function trader(page, prefix) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '2000', `deposit:${J}:${prefix}:${Date.now()}`);
  return { who, walletKey, owner, userId: await userIdOf(who) };
}

/** A block strategy saved in svc-quant as the trader. */
async function strategy(t, name) {
  const session = await api(t.who);
  const saved = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: `TEST halt ${name}`,
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: `${J}:${t.owner}:${name}`,
      idempotencyKey: `${J}:${t.owner}:${name}:save`,
    }),
  ).result.data;
  return saved.id;
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
}

/** A sub-account of the wallet's own, funded with TEST USDC, our builder fee approved and BTC-PERP set to 1x isolated. */
async function subAccount(t, name) {
  const session = await api(t.who);
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

const subRecord = async (t, sub, path, extra = {}) => (await venueRecord(t.owner, path, extra, TEST_VENUE, sub)).value;
const openPositions = async (t, sub) => (await subRecord(t, sub, '/positions')).filter((p) => toUnits(p.size) > 0n);
const fillsOf = (t, sub) => subRecord(t, sub, '/fills', { since: '2020-01-01T00:00:00.000Z' });
const openOrdersOf = (t, sub) => subRecord(t, sub, '/open-orders');

const startBody = (t, strategyId, sub, runId) => ({
  runId,
  strategyId,
  strategyVersion: 1,
  owner: t.owner,
  subAccount: sub,
  cap: '150',
  restartAttempts: '1',
  statePolicy: 'keep',
  liveControl: true,
});

/** Starts a live run of `strategyId` on `sub` and signs its agent permission; returns once its block has filled. */
async function liveRun(t, strategyId, sub) {
  const session = await api(t.who);
  const runId = crypto.randomUUID();
  let view = body200(await session.post(LIVE, startBody(t, strategyId, sub, runId)));
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
  await expect
    .poll(async () => (await openPositions(t, sub)).map((x) => x.size), { timeout: 20_000 })
    .toEqual([expect.stringMatching(/^0\.001$/)]);
  return runId;
}

/** A manual market buy for a run under its next sequence number, as the person: { status, body }. */
async function manualBuy(t, runId) {
  const session = await api(t.who);
  const detail = body200(await session.get(`${LIVE}/${runId}`));
  return session.post(`${LIVE}/${runId}/orders`, {
    seq: detail.nextSeq,
    side: 'buy',
    type: 'limit',
    symbol: SYMBOL,
    size: BLOCK,
    price: '50000',
  });
}

/** The quant desk's own server route, from a console page signed in as a founder, with its CSRF token: { status, body }. */
async function deskCall(page, body) {
  return page.evaluate(async (input) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/trade-ops/quant-halts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(input),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, body);
}

async function readDesk(page) {
  const { status, body } = await deskCall(page, { action: 'read' });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.data;
}

/** A founder on the quant desk. */
async function quantDesk(browser, key = 'a') {
  const page = await (await browser.newContext()).newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(`${ADMIN}/more-ops/quant`);
  await expect(page.getByRole('heading', { name: 'Quant desk' })).toBeVisible();
  return { page, founder };
}

const stateCell = (page, runId) => page.locator(`[data-testid="quant-run-state"][data-run="${runId}"]`);
const runRow = (page, runId) => page.getByRole('row').filter({ has: stateCell(page, runId) });

function state() {
  const s = run.read();
  if (!s.a || !s.b || !s.runs) throw new Error(`${J} #1 made no live runs, so this step has nothing to act on`);
  return s;
}

const codeOf = (res) => res.body?.intafacedCode;

test.afterAll(async ({ browser }) => {
  // Every halt standing is lifted by two founders, so no other journey's live run stays halted after this file.
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  try {
    await founderSignIn(a, 'a');
    await a.goto(`${ADMIN}/more-ops/quant`);
    await founderSignIn(b, 'b');
    await b.goto(`${ADMIN}/more-ops/quant`);
    if ((await readDesk(a)).halts.length > 0) {
      const asked = await deskCall(a, { action: 'ask', op: 'restore_all', reason: `TEST ${J} cleanup` });
      if (asked.status === 200) await deskCall(b, { action: 'confirm', requestId: asked.body.data.id });
    }
  } finally {
    await a.context().close();
    await b.context().close();
  }
  // The runs this file started stop, so they place nothing after it.
  const { a: ta, b: tb, runs } = run.read();
  for (const [who, id] of [
    [ta, runs?.keep],
    [ta, runs?.s2],
    [tb, runs?.s3],
  ]) {
    if (who && id) await (await api(who.who)).post(`${LIVE}/${id}/stop`, { seq: 1 }).catch(() => null);
  }
});

test(`${J} #1 opens the quant desk and the runs list: every run with owner, state and version; the account's own strategies only on the customer side`, async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  const a = await trader(page, 'ad11a');
  const b = await trader(page, 'ad11b');
  const s1 = await strategy(a, 'S1');
  const s2 = await strategy(a, 'S2');
  const s3 = await strategy(b, 'S3');
  const subs = { exit: await subAccount(a, `${J}-exit`), keep: await subAccount(a, `${J}-keep`), s2: await subAccount(a, `${J}-s2`) };
  const subB = await subAccount(b, `${J}-s3`);
  const runs = {
    exit: await liveRun(a, s1, subs.exit),
    keep: await liveRun(a, s1, subs.keep),
    s2: await liveRun(a, s2, subs.s2),
    s3: await liveRun(b, s3, subB),
  };
  run.reset({ a, b, s1, s2, s3, subs, subB, runs });

  // The desk: every run, each with its owner, its state and its strategy version.
  const { page: desk } = await quantDesk(browser, 'a');
  const read = await readDesk(desk);
  const expected = [
    [runs.exit, a.userId, s1],
    [runs.keep, a.userId, s1],
    [runs.s2, a.userId, s2],
    [runs.s3, b.userId, s3],
  ];
  for (const [runId, userId, strategyId] of expected) {
    const row = read.runs.find((r) => r.runId === runId);
    expect(row, `the desk lists no run ${runId}`).toMatchObject({ userId, strategyId, strategyVersion: 1, state: 'running', halt: null });
    await expect(stateCell(desk, runId)).toHaveAttribute('data-state', 'running');
    await expect(runRow(desk, runId).getByTestId('quant-run-owner')).toHaveAttribute('data-user', userId);
    await expect(runRow(desk, runId).getByTestId('quant-run-strategy')).toContainText('v1');
  }
  const owners = new Set(read.runs.filter((r) => expected.some(([id]) => id === r.runId)).map((r) => r.userId));
  expect([...owners].sort()).toEqual([a.userId, b.userId].sort());
  await desk.context().close();

  // The customer side: each account lists its own runs only, in the room and from the service.
  const mine = body200(await (await api(a.who)).get(LIVE)).runs.map((r) => r.runId);
  expect(mine.sort()).toEqual([runs.exit, runs.keep, runs.s2].sort());
  const theirs = body200(await (await api(b.who)).get(LIVE)).runs.map((r) => r.runId);
  expect(theirs).toEqual([runs.s3]);
  await signOutBrowser(page.context());
  await signIn(page, a.who);
  await page.goto('/quant/live');
  const rows = page.getByTestId('live-run-row');
  await expect(rows).toHaveCount(3);
  for (const id of [runs.exit, runs.keep, runs.s2])
    await expect(page.locator(`[data-testid="live-run-row"][data-id="${id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="live-run-row"][data-id="${runs.s3}"]`)).toHaveCount(0);
});

test(`${J} #2 halts one strategy with a reason: new orders are denied for it and a reduce-only exit passes; an audit row names the operator`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, s1, s2, subs, runs } = state();
  // The venue's record before the halt: halting places no order of its own.
  const before = {};
  for (const k of ['exit', 'keep', 's2'])
    before[k] = { fills: (await fillsOf(a, subs[k])).length, open: (await openOrdersOf(a, subs[k])).length };

  const { page: desk, founder } = await quantDesk(browser, 'a');
  await runRow(desk, runs.exit).getByRole('button', { name: 'Halt' }).click();
  const form = desk.getByTestId('quant-halt-one');
  await form.getByLabel('Reason').fill(HALT_REASON);
  const [answer] = await Promise.all([
    desk.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'halt'),
    form.getByRole('button', { name: 'Halt this strategy' }).click(),
  ]);
  const halted = await answer.json();
  expect(answer.status(), JSON.stringify(halted).slice(0, 400)).toBe(200);
  expect(halted.data).toMatchObject({ userId: a.userId, strategyId: s1, scope: 'one', reason: HALT_REASON, haltedBy: founder.userId });
  run.write({ s1Halt: halted.data.id });
  // Both runs of S1 read halted; S2's does not.
  await expect(stateCell(desk, runs.exit)).toHaveAttribute('data-halted', 'true');
  await expect(stateCell(desk, runs.keep)).toHaveAttribute('data-halted', 'true');
  await expect(stateCell(desk, runs.s2)).toHaveAttribute('data-halted', 'false');
  // The audit row names the operator and the reason.
  const audit = (await readDesk(desk)).audit.filter((x) => x.kind === 'quant_live.halt' && x.objectId === `strategy:${s1}`);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ operatorId: founder.userId, accountId: a.userId, reason: HALT_REASON, approverId: null });
  const auditRow = desk
    .getByRole('row')
    .filter({ has: desk.locator(`[data-testid="quant-audit-kind"][data-kind="quant_live.halt"]`) })
    .filter({ hasText: s1 });
  await expect(auditRow.getByTestId('quant-audit-operator')).toHaveAttribute('data-operator', founder.userId);
  await desk.context().close();

  // New orders are denied for it: a manual order on its run, and a new run of it, each refused by name with nothing stored.
  const manual = await manualBuy(a, runs.keep);
  expect([manual.status, codeOf(manual)], JSON.stringify(manual.body).slice(0, 300)).toEqual([423, 'quant.strategy_halted']);
  expect(manual.body.haltReason).toBe(HALT_REASON);
  const session = await api(a.who);
  const fresh = crypto.randomUUID();
  const start = await session.post(LIVE, startBody(a, s1, subs.keep, fresh));
  expect([start.status, codeOf(start)], JSON.stringify(start.body).slice(0, 300)).toEqual([423, 'quant.strategy_halted']);
  expect(body200(await session.get(LIVE)).runs.map((r) => r.runId)).not.toContain(fresh);
  // The other strategy still trades: S2 was not halted.
  expect(s2).not.toBe(s1);
  // Nothing was placed on the venue by the halt or by the refused order.
  for (const k of ['exit', 'keep', 's2']) {
    expect((await fillsOf(a, subs[k])).length, k).toBe(before[k].fills);
    expect((await openOrdersOf(a, subs[k])).length, k).toBe(before[k].open);
  }

  // The person's run page says it is halted, with the reason.
  await signIn(page, a.who);
  await page.goto(`/quant/live/${runs.exit}`);
  await expect(page.getByTestId('live-run-halted')).toContainText(HALT_REASON);

  // A reduce-only exit passes: Liquidate closes the halted run's position with one reduce-only order, and the venue's
  // own record reconciles (the position is the net of its fills, and now zero).
  const exit = body200(await session.post(`${LIVE}/${runs.exit}/liquidate`, { seq: 1 }));
  expect(exit.run.state).toBe('flat');
  expect(exit.orders).toEqual([expect.objectContaining({ kind: 'liquidate', reduceOnly: true, side: 'sell', state: 'accepted' })]);
  await expect.poll(async () => (await openPositions(a, subs.exit)).length, { timeout: 20_000 }).toBe(0);
  const fills = (await fillsOf(a, subs.exit)).filter((f) => f.symbol === SYMBOL);
  const net = fills.reduce((s, f) => s + (f.side === 'buy' ? toUnits(f.amount) : -toUnits(f.amount)), 0n);
  expect(net).toBe(0n);
  expect(fills.filter((f) => f.side === 'sell').reduce((s, f) => s + toUnits(f.amount), 0n)).toBe(toUnits(BLOCK));
});

test(`${J} #3 requests halt-all as the only founder: it stays a request and no run is halted`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { runs } = state();
  const { page: desk, founder } = await quantDesk(browser, 'a');
  const before = await readDesk(desk);
  await desk.getByLabel('Reason to halt every strategy').fill(ALL_REASON);
  const [answer] = await Promise.all([
    desk.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'ask'),
    desk.getByRole('button', { name: 'Ask to halt every strategy' }).click(),
  ]);
  const asked = await answer.json();
  expect(answer.status(), JSON.stringify(asked).slice(0, 400)).toBe(200);
  expect(asked.data).toMatchObject({ op: 'halt_all', status: 'awaiting_second', proposedBy: founder.userId, reason: ALL_REASON });
  run.write({ haltAllRequest: asked.data.id });
  // It stays a request: the founder who asked is offered no confirm, and confirming it alone is refused.
  const waiting = desk.getByRole('row').filter({ hasText: ALL_REASON });
  await expect(waiting.getByText('Waiting for a second founder')).toBeVisible();
  await expect(waiting.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  const self = await deskCall(desk, { action: 'confirm', requestId: asked.data.id });
  expect([self.status, self.body.code]).toEqual([409, 'action_approval.same_person']);
  // No run is halted: S2's and S3's runs still read not halted, and the halted count is what it was.
  const after = await readDesk(desk);
  for (const id of [runs.s2, runs.s3]) {
    expect(after.runs.find((r) => r.runId === id)?.halt, id).toBeNull();
    await expect(stateCell(desk, id)).toHaveAttribute('data-halted', 'false');
  }
  expect(after.counts.haltedLive).toBe(before.counts.haltedLive);
  expect(after.waiting.find((w) => w.id === asked.data.id)?.status).toBe('awaiting_second');
  await desk.context().close();
  // And the strategy still trades: S2's run takes an order.
  const { a } = state();
  const order = await manualBuy(a, runs.s2);
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBe(200);
});

test(`${J} #4 a second founder confirms halt-all: every run halts and the desk shows the count`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { a, b, runs, haltAllRequest } = state();
  if (!haltAllRequest) throw new Error(`${J} #3 filed no halt-all request, so there is nothing to confirm`);
  const { page: desk, founder } = await quantDesk(browser, 'b');
  const waiting = desk.getByRole('row').filter({ hasText: ALL_REASON });
  const [answer] = await Promise.all([
    desk.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'confirm'),
    waiting.getByRole('button', { name: 'Confirm' }).click(),
  ]);
  const confirmed = await answer.json();
  expect(answer.status(), JSON.stringify(confirmed).slice(0, 400)).toBe(200);
  expect(confirmed.data).toMatchObject({
    id: haltAllRequest,
    op: 'halt_all',
    status: 'applied',
    approverId: founder.userId,
    confirmedBy: founder.userId,
  });

  // Every live run halts: each one the desk lists live reads halted, this file's three among them.
  const read = await readDesk(desk);
  const live = read.runs.filter((r) => LIVE_STATES.includes(r.state));
  expect(live.length).toBeGreaterThanOrEqual(3);
  for (const r of live) expect(r.halt, r.runId).not.toBeNull();
  for (const id of [runs.keep, runs.s2, runs.s3]) await expect(stateCell(desk, id)).toHaveAttribute('data-halted', 'true');
  expect(read.counts.haltedLive).toBe(read.counts.live);
  expect(confirmed.data.appliedRuns).toBe(read.counts.live);
  // The desk shows the count: on its counts line, and on the halt-all audit row, with both founders named.
  const counts = desk.getByTestId('quant-halt-counts');
  await expect(counts).toHaveAttribute('data-halted', String(read.counts.live));
  await expect(counts).toHaveAttribute('data-live', String(read.counts.live));
  await expect(counts).toContainText(`${read.counts.live} of them halted`);
  const row = read.audit.find((x) => x.kind === 'quant_live.halt_all' && x.detail.requestId === haltAllRequest);
  expect(row).toMatchObject({ approverId: founder.userId, reason: ALL_REASON, detail: { runs: read.counts.live } });
  const auditRow = desk
    .getByRole('row')
    .filter({ has: desk.locator('[data-testid="quant-audit-kind"][data-kind="quant_live.halt_all"]') })
    .filter({ hasText: ALL_REASON });
  await expect(auditRow.first().getByTestId('quant-audit-runs')).toHaveText(String(read.counts.live));
  await desk.context().close();

  // New orders are denied on every strategy: S2's run (trader A) and S3's (trader B).
  for (const [t, id] of [
    [a, runs.s2],
    [b, runs.s3],
  ]) {
    const res = await manualBuy(t, id);
    expect([res.status, codeOf(res)], JSON.stringify(res.body).slice(0, 300)).toEqual([423, 'quant.strategy_halted']);
  }
});

test(`${J} #5 restores a halted strategy: restore needs the same two-person rule and writes an audit row`, async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, s1, runs, s1Halt } = state();
  if (!s1Halt) throw new Error(`${J} #2 left no halt of S1, so there is nothing to restore`);
  const { page: deskA, founder: fa } = await quantDesk(browser, 'a');
  await runRow(deskA, runs.keep).getByRole('button', { name: 'Restore' }).click();
  const form = deskA.getByTestId('quant-restore');
  await form.getByLabel('Reason to restore').fill(RESTORE_REASON);
  // One founder alone: refused, and S1 stays halted.
  const [alone] = await Promise.all([
    deskA.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'now'),
    form.getByRole('button', { name: 'Restore now' }).click(),
  ]);
  expect([alone.status(), (await alone.json()).code]).toEqual([409, 'trade_ops.quant_halt_second_founder_required']);
  await expect(deskA.getByRole('alert').filter({ hasText: 'A second founder must confirm this.' })).toBeVisible();
  // Asked for a second founder: still a request, S1 still halted.
  const [asked] = await Promise.all([
    deskA.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'ask'),
    form.getByRole('button', { name: 'Ask for a second founder' }).click(),
  ]);
  const request = (await asked.json()).data;
  expect(request).toMatchObject({
    op: 'restore',
    haltId: s1Halt,
    strategyId: s1,
    userId: a.userId,
    status: 'awaiting_second',
    proposedBy: fa.userId,
  });
  // The founder who asked is offered no confirm, and confirming it alone is refused: S1 stays halted.
  const mine = deskA.getByRole('row').filter({ hasText: RESTORE_REASON });
  await expect(mine.getByText('Waiting for a second founder')).toBeVisible();
  await expect(mine.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  const self = await deskCall(deskA, { action: 'confirm', requestId: request.id });
  expect([self.status, self.body.code]).toEqual([409, 'action_approval.same_person']);
  expect((await readDesk(deskA)).waiting.find((w) => w.id === request.id)?.status).toBe('awaiting_second');
  await expect(stateCell(deskA, runs.keep)).toHaveAttribute('data-halted', 'true');
  const still = await manualBuy(a, runs.keep);
  expect([still.status, codeOf(still)]).toEqual([423, 'quant.strategy_halted']);
  await deskA.context().close();

  // The second founder confirms: S1 is restored, its run trades again, and the audit row names both founders.
  const { page: deskB, founder: fb } = await quantDesk(browser, 'b');
  const waiting = deskB.getByRole('row').filter({ hasText: RESTORE_REASON });
  const [done] = await Promise.all([
    deskB.waitForResponse((r) => r.url().endsWith('/api/trade-ops/quant-halts') && r.request().postDataJSON()?.action === 'confirm'),
    waiting.getByRole('button', { name: 'Confirm' }).click(),
  ]);
  const applied = (await done.json()).data;
  expect(applied).toMatchObject({ id: request.id, status: 'applied', approverId: fb.userId, appliedStrategies: 1 });
  await expect(stateCell(deskB, runs.keep)).toHaveAttribute('data-halted', 'false');
  // Only S1 came back: S2 stays halted under halt-all.
  await expect(stateCell(deskB, runs.s2)).toHaveAttribute('data-halted', 'true');
  const audit = (await readDesk(deskB)).audit.filter((x) => x.kind === 'quant_live.restore' && x.detail.requestId === request.id);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    operatorId: fa.userId,
    approverId: fb.userId,
    accountId: a.userId,
    objectId: `strategy:${s1}`,
    reason: RESTORE_REASON,
  });
  const auditRow = deskB
    .getByRole('row')
    .filter({ has: deskB.locator('[data-testid="quant-audit-kind"][data-kind="quant_live.restore"]') })
    .filter({ hasText: RESTORE_REASON });
  await expect(auditRow.first().getByTestId('quant-audit-operator')).toHaveAttribute('data-operator', fa.userId);
  await expect(auditRow.first().getByTestId('quant-audit-approver')).toHaveAttribute('data-approver', fb.userId);
  await deskB.context().close();
  const order = await manualBuy(a, runs.keep);
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBe(200);
  expect(order.body.order).toMatchObject({ kind: 'manual', state: 'accepted' });
});
