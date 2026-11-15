// World: restart
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { holderAgain, keyHolder, makeKey, withKey } from './developer.mjs';
import { tapeWindow } from './tape.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { TEST_VENUE, testDeposit, testVenue, venueAccount, venueForThisFile, venueRecord } from './venue.mjs';

// J-algo-dev-14, in the running app (docs/roadmap/journeys.json): drive Algo dev from my own code with the strategy API.
// One test per step, titled "J-algo-dev-14 #<n>", run in order. The developer is a verified TEST account with a passkey
// (only such an account may hold a key; the passkey gives each create its fresh step-up), signed in and on
// /developers/quant, with one signal-rules strategy saved in svc-quant. A second TEST account holds a strategy and a
// backtest of its own, so a read says whose account answered. Keys are made through /uc/safe/api-keys/new with exactly
// the permissions each step names, and every call is sent with the key, as the developer's program would send it.
// The live strategy of #7 is made as J-algo-dev-07 makes it: the developer's own TEST wallet holds TEST USDC on the
// stack's TEST venue simulator, opens one funded sub-account, and a one-block strategy (buy 0.001 BTC-PERP) runs live on
// it through an agent permission the wallet signs. INTAFACED holds none of it and the ledger posts nothing: the stop is
// checked against the TEST venue's own record of the sub-account. Every figure is TEST.
const J = 'J-algo-dev-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const RUN_ID = process.env.JOURNEY_RUN_ID ?? `local-${Date.now().toString(36)}`;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const LIVE = '/api/v1/quant/live-runs';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';
const RULES = {
  symbol: 'BTC/USDT',
  barSize: '1m',
  signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
  sizing: { kind: 'quantity', value: '0.01' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
/** A word only the other account's strategy holds, in its name and its generated source, so a leak is visible. */
const OTHER_MARK = `TESTotheraccount${RUN_ID.replace(/[^a-z0-9]/gi, '')}`;

const dataOf = (body) => body?.result?.data?.json ?? body?.result?.data;
const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};
const query = (procedure, input) => `/api/quant/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** A call of svc-quant with an API key, as the developer's program sends it. */
async function keyQuant(key, procedure, input, { method = 'GET', headers = {} } = {}) {
  const res =
    method === 'GET'
      ? await withKey(key, { path: query(procedure, input), headers })
      : await withKey(key, { method: 'POST', path: `/api/quant/trpc/${procedure}`, body: input, headers });
  return { ...res, data: dataOf(res.body) };
}

/** The same call as the signed-in person (the screen's own session). */
async function sessionQuant(who, procedure, input, method = 'GET') {
  const client = await api(who);
  const res = method === 'GET' ? await client.get(query(procedure, input)) : await client.post(`/api/quant/trpc/${procedure}`, input);
  return { status: res.status, body: res.body, data: dataOf(res.body) };
}

async function saveStrategy(who, name) {
  const saved = await sessionQuant(
    who,
    'studio.save',
    {
      name,
      blocks: [],
      modules: RULES,
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      clientStrategyId: `${J}:${RUN_ID}:${name}`,
      idempotencyKey: `studio.save:${J}:${RUN_ID}:${name}`,
    },
    'POST',
  );
  expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);
  return saved.data.id;
}

/** The backtest every step starts: version 1 on the last hour of the TEST tape, with its costs set. */
function backtestOf(strategyId, tape, cash = '1000') {
  return {
    strategyId,
    strategyVersion: 1,
    cash,
    from: `${tape.from}:00.000Z`,
    to: `${tape.to}:00.000Z`,
    fillTiming: 'next_open',
    costs: { feeRole: 'taker', slippageBps: '5', delayBars: '0' },
  };
}

/** The person's own backtest runs of one strategy, as the session reads them. */
async function runsOf(who, strategyId) {
  const res = await sessionQuant(who, 'backtest.history', { limit: 50, strategyId });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return res.data.runs;
}

/** The key's record on the account, as the keys page reads it. */
async function keyRecord(who, name) {
  const session = await api(who);
  const listed = body200(await session.get(`/api/identity/trpc/apiKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`));
  const data = dataOf(listed);
  return (data.keys ?? data).find((row) => row.name === name);
}

function state(...keys) {
  const s = run.read();
  for (const key of ['who', 'other', 'strategyId', 'otherStrategyId', 'otherRunId', 'tape', ...keys])
    if (!s[key]) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to act on`);
  return s;
}

test(`${J} #1 mints a key with the quant read scope: the key carries only that scope`, async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  // The start: a signed-in developer on /developers/quant, with one strategy, and another account with its own.
  const { page, who } = await keyHolder(browser, 'aq14');
  const otherPage = await (await browser.newContext()).newPage();
  const other = await signUp(otherPage, 'aq14o');
  await verify(otherPage, other);
  await otherPage.context().close();
  const tape = await tapeWindow(60);
  const strategyId = await saveStrategy(who, `TEST api cross ${RUN_ID}`);
  const otherStrategyId = await saveStrategy(other, `${OTHER_MARK} cross`);
  const otherRun = await sessionQuant(other, 'backtest.start', backtestOf(otherStrategyId, tape), 'POST');
  expect(otherRun.status, JSON.stringify(otherRun.body).slice(0, 400)).toBe(200);
  run.reset({ who, other, strategyId, otherStrategyId, otherRunId: otherRun.data.runId, tape });

  await page.goto('/developers/quant');
  await expect(page.getByTestId('developers-quant')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Strategy API' })).toBeVisible();

  const name = `TEST quant read ${RUN_ID}`;
  const readKey = await makeKey(page, { name, scopes: ['quant:read'] });
  expect(readKey).toBeTruthy();
  const record = await keyRecord(who, name);
  expect(record, `the keys list has ${name}`).toBeTruthy();
  expect(record.scopes).toEqual(['quant:read']);
  // The keys page shows the same one permission on the key's row.
  const row = page.getByTestId('api-keys__table').locator('tbody tr', { hasText: name });
  await expect(row).toContainText('quant:read');
  await expect(row).not.toContainText('quant:run');
  await expect(row).not.toContainText('trade:');
  run.write({ readKey });
});

test(`${J} #2 lists projects with the key: only the person's own account's projects`, async () => {
  const s = state('readKey');
  const listed = await keyQuant(s.readKey, 'studio.list', { limit: 50 });
  expect(listed.status, JSON.stringify(listed.body).slice(0, 400)).toBe(200);
  const ids = listed.data.strategies.map((row) => row.id);
  expect(ids).toContain(s.strategyId);
  expect(ids).not.toContain(s.otherStrategyId);
  expect(JSON.stringify(listed.body)).not.toContain(OTHER_MARK);
  // The list is the account's own, the same as the screen's session reads.
  const own = await sessionQuant(s.who, 'studio.list', { limit: 50 });
  expect(ids).toEqual(own.data.strategies.map((row) => row.id));
  // The other account's project, asked for by its id, is not found.
  const foreign = await keyQuant(s.readKey, 'studio.get', { id: s.otherStrategyId });
  expect(foreign.status).toBe(404);
  expect(JSON.stringify(foreign.body)).not.toContain(OTHER_MARK);
  // A body accountId does not select another account.
  const asOther = await keyQuant(s.readKey, 'studio.list', { limit: 50, accountId: s.other.userId });
  expect(asOther.status).toBe(200);
  expect(asOther.data.strategies.map((row) => row.id)).not.toContain(s.otherStrategyId);
});

test(`${J} #3 starts a backtest with the read key: the scope refusal`, async () => {
  const s = state('readKey');
  const before = await runsOf(s.who, s.strategyId);
  const res = await keyQuant(s.readKey, 'backtest.start', backtestOf(s.strategyId, s.tape), {
    method: 'POST',
    headers: { 'idempotency-key': `${J}:${RUN_ID}:read` },
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(403);
  expect(res.body.error.data.cause.code).toBe('scope.denied');
  expect(res.body.error.message).toContain('quant:run');
  // Nothing ran.
  expect(await runsOf(s.who, s.strategyId)).toHaveLength(before.length);
});

test(`${J} #4 starts a backtest with a read-and-run key twice with one Idempotency-Key: one stored run`, async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const s = state();
  const name = `TEST quant run ${RUN_ID}`;
  const runKey = await makeKeyWithPasskey(browser, s.who, name, ['quant:read', 'quant:run']);
  run.write({ runKey });

  expect(await runsOf(s.who, s.strategyId)).toEqual([]);
  const input = backtestOf(s.strategyId, s.tape);
  const idem = `${J}:${RUN_ID}:bt-1`;
  const first = await keyQuant(runKey, 'backtest.start', input, { method: 'POST', headers: { 'idempotency-key': idem } });
  expect(first.status, JSON.stringify(first.body).slice(0, 600)).toBe(200);
  const second = await keyQuant(runKey, 'backtest.start', input, { method: 'POST', headers: { 'idempotency-key': idem } });
  expect(second.status, JSON.stringify(second.body).slice(0, 600)).toBe(200);
  expect(first.data.runId).toBeTruthy();
  expect(second.data.runId).toBe(first.data.runId);
  expect(second.data.metrics).toEqual(first.data.metrics);
  // One stored run, as the key and as the screen read it.
  const stored = await runsOf(s.who, s.strategyId);
  expect(stored.map((row) => row.runId)).toEqual([first.data.runId]);
  const byKey = await keyQuant(runKey, 'backtest.history', { limit: 50, strategyId: s.strategyId });
  expect(byKey.status).toBe(200);
  expect(byKey.data.runs.map((row) => row.runId)).toEqual([first.data.runId]);
  // The same Idempotency-Key with a different request runs nothing; a start with no key is refused.
  const changed = await keyQuant(
    runKey,
    'backtest.start',
    { ...input, cash: '2000' },
    { method: 'POST', headers: { 'idempotency-key': idem } },
  );
  expect(changed.status, JSON.stringify(changed.body).slice(0, 400)).toBe(409);
  expect(changed.body.error.data.cause.code).toBe('quant.idempotency_key_reused');
  const bare = await keyQuant(runKey, 'backtest.start', { ...input, cash: '3000' }, { method: 'POST' });
  expect(bare.status, JSON.stringify(bare.body).slice(0, 400)).toBe(400);
  expect(bare.body.error.data.cause.code).toBe('quant.idempotency_key_required');
  expect((await runsOf(s.who, s.strategyId)).map((row) => row.runId)).toEqual([first.data.runId]);
  run.write({ runId: first.data.runId });
});

test(`${J} #5 reads the report: metrics from J-algo-dev-01 and no source of another account`, async () => {
  const s = state('runKey', 'runId');
  const report = await keyQuant(s.runKey, 'backtest.report', { runId: s.runId });
  expect(report.status, JSON.stringify(report.body).slice(0, 400)).toBe(200);
  expect(report.data.runId).toBe(s.runId);
  expect(report.data.claimLabel).toBe('Historical simulation — not a forecast');
  expect(report.data.simulated).toBe(true);
  expect(report.data.live).toBe(false);
  const stats = Object.fromEntries(report.data.sections.find((section) => section.id === 'statistics').rows.map((r) => [r.name, r.value]));
  // J-algo-dev-01 #7's metrics, from the engine's own trades: the same figures the stored run holds.
  const result = await sessionQuant(s.who, 'backtest.result', { runId: s.runId });
  expect(result.status).toBe(200);
  const line = (metric) => metric.value ?? `not defined (${metric.reason ?? 'unset'})`;
  const m = result.data.metrics;
  expect(stats).toMatchObject({
    net: line(m.returns.net),
    profitFactor: line(m.returns.profitFactor),
    maxDrawdown: line(m.risk.maxDrawdown),
    maxRunUp: line(m.risk.maxRunUp),
    winRate: line(m.trades.winRate),
    roundTrips: String(m.trades.roundTrips),
    sharpe: line(m.returns.sharpe),
  });
  // Nothing of the other account: its run is not found by the key, and no report carries its strategy.
  expect(JSON.stringify(report.body)).not.toContain(OTHER_MARK);
  for (const procedure of ['backtest.report', 'backtest.result']) {
    const foreign = await keyQuant(s.runKey, procedure, { runId: s.otherRunId });
    expect(foreign.status, procedure).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(OTHER_MARK);
  }
});

test(`${J} #6 asks to deploy a strategy by key: no such endpoint and the reference says so`, async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const s = state('runKey');
  const name = `TEST quant trade ${RUN_ID}`;
  const tradeKey = await makeKeyWithPasskey(browser, s.who, name, ['quant:read', 'trade:read', 'trade:write']);
  run.write({ tradeKey });
  const session = await api(s.who);
  const before = body200(await session.get(LIVE)).runs.length;
  for (const key of [s.runKey, tradeKey]) {
    const deploy = await keyQuant(key, 'live.deploy', { strategyId: s.strategyId, strategyVersion: 1 }, { method: 'POST' });
    expect(deploy.status, JSON.stringify(deploy.body).slice(0, 400)).toBe(404);
    expect(deploy.body.error.data.cause.code).toBe('quant.key_no_such_endpoint');
  }
  // The trade door's start of a live run, the screen's deploy, answers a key the same: there is no deploy by key.
  const start = await withKey(tradeKey, {
    method: 'POST',
    path: LIVE,
    body: { runId: crypto.randomUUID(), strategyId: s.strategyId, strategyVersion: 1 },
  });
  expect(start.status, JSON.stringify(start.body).slice(0, 400)).toBe(404);
  expect(start.body.intafacedCode).toBe('quant.key_no_such_endpoint');
  expect(body200(await session.get(LIVE)).runs).toHaveLength(before);

  // The reference says so, and lists no deploy endpoint.
  const page = await (await browser.newContext()).newPage();
  await page.goto('/developers/quant');
  const noDeploy = page.getByTestId('developers-quant-no-deploy');
  await expect(noDeploy).toContainText('There is no endpoint to deploy a strategy with an API key.');
  await expect(noDeploy).toContainText('quant.key_no_such_endpoint');
  const paths = await page.getByTestId('developers-quant-endpoint').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path')));
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((p) => /deploy/.test(p))).toEqual([]);
  expect(paths).toContain('/api/v1/quant/live-runs/:id/stop');
  const md = await page.request.get('/developers/quant.md');
  expect(md.status()).toBe(200);
  expect(await md.text()).toContain('There is no endpoint to deploy a strategy with an API key.');
  await page.context().close();
});

test(`${J} #7 stops a live strategy with and without the trade scope: refused without it; works under the same rules as the screen with it`, async ({
  browser,
}) => {
  test.setTimeout(6 * 60_000);
  const s = state('runKey', 'tradeKey');
  const session = await api(s.who);
  const t = await liveTrader(s.who, session);
  const runId = await liveRun(t, session);
  await restingLimit(session, runId);
  expect(await subRecord(t, '/open-orders')).toHaveLength(1);
  const fills = (await fillsOf(t)).length;

  // Without trade:write: refused, and the run, its order and its position are as they were.
  const refused = await withKey(s.runKey, { method: 'POST', path: `${LIVE}/${runId}/stop`, body: { seq: 1 } });
  expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).toBe(403);
  expect(refused.body.intafacedCode).toBe('scope.denied');
  expect(body200(await session.get(`${LIVE}/${runId}`)).state).toBe('running');
  expect(await subRecord(t, '/open-orders')).toHaveLength(1);

  // With it: the screen's own Stop, by key. The open order is cancelled, the position kept, the state stopped.
  const stopped = await withKey(s.tradeKey, { method: 'POST', path: `${LIVE}/${runId}/stop`, body: { seq: 1 } });
  expect(stopped.status, JSON.stringify(stopped.body).slice(0, 400)).toBe(200);
  expect(stopped.body).toMatchObject({ state: 'stopped', stopSeq: 1, endReason: 'user_stop' });
  expect(await subRecord(t, '/open-orders')).toEqual([]);
  expect((await openPositions(t)).map((x) => x.size)).toEqual([BLOCK]);
  // The same stop again (algo:stop:<run>:1) changes nothing, as the screen's second press does.
  const before = body200(await session.get(`${LIVE}/${runId}`));
  const again = await withKey(s.tradeKey, { method: 'POST', path: `${LIVE}/${runId}/stop`, body: { seq: 1 } });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ state: 'stopped', stopSeq: 1, nextSeq: before.nextSeq, endReason: 'user_stop' });
  expect(await fillsOf(t)).toHaveLength(fills);
  expect(body200(await session.get(`${LIVE}/${runId}`)).orders).toHaveLength(before.orders.length);
  // The J-algo-dev-07 reconciliation: the run shows the venue's own record of the sub-account, to the last decimal.
  await venueMatches(t, runId, session);

  // The screen reads the same stopped run.
  const page = await holderAgain(browser, s.who);
  await page.goto(`/quant/live/${runId}`);
  const room = page.getByTestId('live-run');
  await expect(room.getByTestId('live-run-state')).toHaveAttribute('data-state', 'stopped');
  await expect(room.getByTestId('live-run-reason')).toHaveAttribute('data-reason', 'user_stop');
  await expect(room.getByTestId('live-run-no-open-order')).toBeVisible();
  await expect(room.getByTestId('live-run-position')).toHaveAttribute('data-size', BLOCK);
  await page.context().close();
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A key made on a fresh passkey page of the same account (each create takes the passkey's fresh step-up). */
async function makeKeyWithPasskey(browser, who, name, scopes) {
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  await signIn(page, who);
  await addPasskey(page);
  const key = await makeKey(page, { name, scopes });
  const record = await keyRecord(who, name);
  expect([...record.scopes].sort()).toEqual([...scopes].sort());
  await page.context().close();
  return key;
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

/**
 * The developer's own TEST wallet with TEST USDC on the venue, a one-block strategy saved in svc-quant, and one funded
 * sub-account with the builder fee approved and BTC-PERP at 1x isolated, as J-algo-dev-07 makes them.
 */
async function liveTrader(who, session) {
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '2000', `deposit:${J}:${RUN_ID}:${Date.now()}`);
  const saved = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: `TEST live block ${RUN_ID}`,
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: `${J}:${RUN_ID}:live`,
      idempotencyKey: `${J}:${RUN_ID}:live-save`,
    }),
  ).result.data;
  const t = { who, walletKey, owner, strategyId: saved.id };
  const name = `${J}-stop-${RUN_ID}`.slice(0, 40);
  await ownVenueAction(t, { kind: 'create_sub_account', name, subAccountKey: `own:${J}:${RUN_ID}:${Date.now()}` });
  const listed = (await venueRecord(owner, '/sub-accounts')).value.find((x) => x.name === name);
  expect(listed, `the venue lists no sub-account named ${name}`).toBeTruthy();
  t.sub = listed.subAccount;
  await ownVenueAction(t, {
    kind: 'sub_account_transfer',
    subAccount: t.sub,
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: '200',
    moveKey: `own:${J}:${RUN_ID}:fund:${Date.now()}`,
  });
  const status = body200(await session.get('/api/v1/venue/status'));
  await ownVenueAction(t, { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps }, t.sub);
  await ownVenueAction(t, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 10_000, marginMode: 'isolated' }, t.sub);
  return t;
}

const subRecord = async (t, path, extra = {}) => (await venueRecord(t.owner, path, extra, TEST_VENUE, t.sub)).value;
const openPositions = async (t) => (await subRecord(t, '/positions')).filter((p) => toUnits(p.size) > 0n);
const fillsOf = (t) => subRecord(t, '/fills', { since: '2020-01-01T00:00:00.000Z' });

/** Starts the live run from the session, as the deploy wizard does, signs its permission, and waits for the block's fill. */
async function liveRun(t, session) {
  const runId = crypto.randomUUID();
  let view = body200(
    await session.post(LIVE, {
      runId,
      strategyId: t.strategyId,
      strategyVersion: 1,
      owner: t.owner,
      subAccount: t.sub,
      cap: '150',
      restartAttempts: '1',
      statePolicy: 'keep',
      liveControl: true,
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
  await expect
    .poll(async () => (await openPositions(t)).map((x) => x.size), { timeout: 20_000 })
    .toEqual([expect.stringMatching(/^0\.001$/)]);
  return runId;
}

/** A manual limit order for the run, under its next sequence number, resting below the market (as J-algo-dev-07). */
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

/** The J-algo-dev-07 reconciliation: what the run shows of the sub-account is the venue's own record, to the last decimal. */
async function venueMatches(t, runId, session) {
  const [cash, positions, fills] = [await subRecord(t, '/balances'), await openPositions(t), await fillsOf(t)];
  const shown = body200(await session.get(`${LIVE}/${runId}`)).venue;
  expect(shown, 'the run shows no venue record').toBeTruthy();
  expect(Number.isNaN(Date.parse(shown.asOf)), `as-of ${shown.asOf}`).toBe(false);
  const units = (b) => b && [toUnits(b.free), toUnits(b.locked), toUnits(b.total)];
  for (const b of cash) expect(units(shown.balances.find((x) => x.asset === b.asset)), b.asset).toEqual(units(b));
  expect(shown.balances).toHaveLength(cash.length);
  const net = fills
    .filter((f) => f.symbol === SYMBOL)
    .reduce((sum, f) => sum + (f.side === 'buy' ? toUnits(f.amount) : -toUnits(f.amount)), 0n);
  const held = positions.filter((p) => p.symbol === SYMBOL);
  expect(held.reduce((sum, p) => sum + toUnits(p.size), 0n)).toBe(net < 0n ? -net : net);
  expect(shown.positions.filter((p) => toUnits(p.size) > 0n).map((p) => [p.symbol, p.size])).toEqual(held.map((p) => [p.symbol, p.size]));
}
