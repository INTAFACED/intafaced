// World: restart
// Market: live
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { userIdOf } from './copy.mjs';
import { tapeWindow } from './tape.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { testDeposit, testVenue, venueAccount, venueForThisFile, venueRecord } from './venue.mjs';

// J-algo-dev-16, in the running app (docs/roadmap/journeys.json): use Python, Monte Carlo, the data lake and an
// independent approval policy. One test per step, titled "J-algo-dev-16 #<n>". The developer is a verified TEST account.
// #1 runs one strategy in the sandbox twice, in JavaScript and in Python, and compares the order events and the limits
// each run reports. #2 reads the Data room; the gap it shows is made by the stack's TEST founder pausing the lake's
// capture of one symbol through svc-quant's own operator door (`ops.lake.capture`, admin:write), as the founder console
// would, and resuming it. #3 resamples a finished TEST backtest. #4 is a team account: the owner sets the account's
// policy, a teammate the strategy is shared with approves, and the live start, svc-trade's live-run route the deploy
// wizard calls, is refused until then and again after a parameter changes. The live run is made as J-algo-dev-07 and
// J-algo-dev-14 make it: the owner's own TEST wallet on the stack's TEST venue simulator, one funded sub-account and a
// one-block strategy; INTAFACED holds none of it and the ledger posts nothing. Every figure is simulated or TEST.
const J = 'J-algo-dev-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const RUN_ID = process.env.JOURNEY_RUN_ID ?? `local-${Date.now().toString(36)}`;
const LIVE = '/api/v1/quant/live-runs';
const SYMBOL = 'BTC-PERP';
const BLOCK = '0.001';

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};

async function developer(page, prefix = 'jp') {
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signIn(page, who);
  return who;
}

/** Runs one source in the sandbox in one language and returns what the result shows: events, limits, logs. */
async function sandboxRun(page, language, source) {
  await page.goto('/quant/sandbox');
  await page.getByRole('combobox', { name: /^Language/ }).selectOption(language);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Strategy source').fill(source);
  await page.getByRole('button', { name: 'Review simulation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('Paper — not live performance', { exact: true })).toBeVisible();
  const events = await page
    .getByTestId('quant-order-events')
    .getByTestId('quant-order-event')
    .evaluateAll((els) =>
      els.map((el) =>
        ['data-kind', 'data-type', 'data-side', 'data-qty', 'data-limit', 'data-price', 'data-reason', 'data-fee', 'data-cash'].map((a) =>
          el.getAttribute(a),
        ),
      ),
    );
  const limits = await page
    .getByTestId('quant-run-limit')
    .evaluateAll((els) => els.map((el) => [el.getAttribute('data-limit'), el.getAttribute('data-value')]));
  const logs = await page.getByTestId('more-body').innerText();
  return { events, limits, logs };
}

const JS = `const a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc");
const z = oms.limitBuy("BTC-USD", "0", "49990", "gtc");
console.log(z.status);
console.log(z.reason);`;

test(`${J} #1 writes a strategy in Python and runs it in the sandbox: the same events and limits as the JavaScript runtime and a Python client package link`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  await developer(page);
  const js = await sandboxRun(page, 'javascript', JS);
  expect(js.events.length, 'the JavaScript run records order events').toBeGreaterThan(0);

  // The Python template, written in Python, run in the same sandbox.
  await page.goto('/quant/sandbox');
  const python = page.getByTestId('quant-python');
  await python.getByRole('button', { name: 'Use the Python template' }).click();
  await expect(page.getByRole('combobox', { name: /^Language/ })).toHaveValue('python');
  const source = await page.getByLabel('Strategy source').inputValue();
  expect(source).toContain('print(');
  expect(source).not.toContain('const ');
  const py = await sandboxRun(page, 'python', source);

  // The same order events, field by field, and the same limits, each one set.
  expect(py.events).toEqual(js.events);
  expect(py.events.map(([kind]) => kind)).toEqual(expect.arrayContaining(['new', 'accepted', 'filled', 'rejected']));
  expect(py.limits).toEqual(js.limits);
  expect(py.limits.map(([name]) => name)).toEqual(['wallClockMs', 'memoryBytes', 'outputBytes', 'maxOps', 'maxSource']);
  for (const [name, value] of py.limits) expect(value, `${name} is set`).toMatch(/^\d+$/);
  expect(py.logs).toBe(js.logs);

  // The Python client package link opens the package and hands it over as a file.
  await page.getByTestId('quant-python-package').click();
  await expect(page).toHaveURL(/\/developers\/quant#python$/);
  const pkg = page.getByTestId('developers-quant-python');
  await expect(pkg.getByRole('heading', { level: 2, name: 'Python client' })).toBeVisible();
  await expect(pkg.getByTestId('developers-quant-python-install')).toContainText('from intafaced_quant import QuantClient');
  const [download] = await Promise.all([page.waitForEvent('download'), pkg.getByTestId('developers-quant-python-download').click()]);
  expect(download.suggestedFilename()).toBe('intafaced_quant.py');
  const text = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text).toContain('class QuantClient');
  expect(text).toContain('def strategy_template');
  // Its starter is the template this step just ran.
  expect(text).toContain(source);
});

/** svc-quant's operator door for the lake's capture, with the stack's TEST founder's operator token. */
async function lakeDoor() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  let n = 0;
  return async (symbol, capturing) => {
    n += 1;
    const res = await ctx.edge.mutate(
      'quant',
      'ops.lake.capture',
      { symbol, capturing, reason: `LOCAL TEST ${J}`, idempotencyKey: `journey:${J}:${RUN_ID}:${Date.now()}:${n}` },
      token,
    );
    const got = res.json?.result?.data;
    if (!got) throw new Error(`ops.lake.capture refused: ${res.status} ${res.text.slice(0, 300)}`);
    return got;
  };
}

test(`${J} #2 opens the data lake room: normalised ticks, books and fills with coverage per symbol and retention; a gap is shown as a gap`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const session = await api(await developer(page));
  const capture = await lakeDoor();
  const SYM = 'BTC/USDT';
  const OTHER = 'ETH/USDT';
  // The newest tick the lake holds of one symbol, as svc-quant's catalogue reads it.
  const lastTick = async (sym) => {
    const data = body200(await session.get('/api/quant/trpc/lake.catalogue')).result.data;
    const last = data.symbols.find((x) => x.symbol === sym)?.datasets.find((d) => d.kind === 'tick')?.last;
    return last ? Date.parse(last) : 0;
  };
  // The lake has been capturing; a pause of several capture intervals leaves a time with nothing captured.
  await page.goto('/quant/data');
  const room = page.getByTestId('quant-lake');
  const settings = room.getByTestId('quant-lake-settings');
  await expect(settings).toBeVisible();
  const seconds = Number(await settings.getAttribute('data-capture-seconds'));
  await expect(settings).toHaveAttribute('data-retention-days', /^[1-9]\d*$/);
  await expect(settings).toContainText(/Kept for \d+ days/);

  const paused = await capture(SYM, false);
  const pausedAt = Date.parse(paused.at);
  // The other symbol keeps being captured: four more of its passes are four this symbol missed.
  await expect.poll(() => lastTick(OTHER), { timeout: 120_000 }).toBeGreaterThan(pausedAt + seconds * 4 * 1000);
  const resumed = await capture(SYM, true);
  const resumedAt = Date.parse(resumed.at);
  // Passes after the resume, so the covered time after the gap is a range of its own.
  await expect.poll(() => lastTick(SYM), { timeout: 120_000 }).toBeGreaterThan(resumedAt + seconds * 2 * 1000);

  await page.reload();
  await room.getByRole('combobox', { name: /^Symbol/ }).selectOption(SYM);
  const symbol = room.locator(`[data-testid="quant-lake-symbol"][data-symbol="${SYM}"]`);
  await expect(symbol).toBeVisible();
  await expect(symbol.getByTestId('quant-lake-capturing')).toHaveAttribute('data-capturing', 'true');
  for (const kind of ['tick', 'book', 'fill']) {
    const dataset = symbol.locator(`[data-testid="quant-lake-dataset"][data-kind="${kind}"]`);
    await expect(dataset, `${kind} is listed`).toBeVisible();
    expect(Number(await dataset.getAttribute('data-rows')), `${kind} rows`).toBeGreaterThan(0);
    await expect(dataset.getByTestId('quant-lake-row').first(), `${kind} shows its newest normalised row`).toBeVisible();
  }
  const ticks = symbol.locator('[data-testid="quant-lake-dataset"][data-kind="tick"]');
  await expect(ticks.getByTestId('quant-lake-row').first()).toContainText(/bid \d/);
  await expect(symbol.locator('[data-testid="quant-lake-dataset"][data-kind="book"]').getByTestId('quant-lake-row').first()).toContainText(
    'bids',
  );
  // The pause is a gap: shown as a gap between two covered ranges, never filled.
  expect(Number(await ticks.getAttribute('data-ranges'))).toBeGreaterThanOrEqual(2);
  const gaps = await ticks
    .getByTestId('quant-lake-gap')
    .evaluateAll((els) => els.map((el) => [Date.parse(el.getAttribute('data-from')), Date.parse(el.getAttribute('data-to'))]));
  const covering = gaps.filter(([from, to]) => from <= pausedAt + seconds * 1000 && to >= resumedAt - seconds * 1000);
  expect(covering, `a gap spans the pause ${paused.at} to ${resumed.at}; gaps ${JSON.stringify(gaps)}`).toHaveLength(1);
  await expect(ticks.getByTestId('quant-lake-range')).toHaveCount(Number(await ticks.getAttribute('data-ranges')));

  // Filtered by kind, only that kind is listed.
  await room.getByRole('combobox', { name: /^Kind/ }).selectOption('fill');
  await expect(symbol.getByTestId('quant-lake-dataset')).toHaveCount(1);
  await expect(symbol.getByTestId('quant-lake-dataset')).toHaveAttribute('data-kind', 'fill');
});

/** Saves a signal-rules strategy on 1 minute bars of BTC/USDT at version 1, with every risk limit set. TEST inputs. */
async function saveSignalStrategy(page, name) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

async function monteCarlo(room, seed) {
  const panel = room.getByTestId('quant-montecarlo');
  await panel.getByLabel('Seed').fill(String(seed));
  await panel.getByRole('button', { name: 'Run Monte Carlo' }).click();
  const result = panel.getByTestId('quant-montecarlo-result');
  await expect(result).toHaveAttribute('data-seed', String(seed));
  return {
    result,
    rows: await result
      .getByTestId('quant-montecarlo-row')
      .evaluateAll((els) =>
        els.map((el) => [el.getAttribute('data-percentile'), el.getAttribute('data-drawdown'), el.getAttribute('data-final')]),
      ),
    ruin: await result.getByTestId('quant-montecarlo-ruin').getAttribute('data-percent'),
  };
}

test(`${J} #3 runs Monte Carlo resampling on a completed backtest: drawdown and final-equity percentiles and a ruin probability, labelled simulated`, async ({
  page,
}) => {
  test.setTimeout(20 * 60_000);
  await developer(page);
  const window = await tapeWindow(60);
  const name = `TEST resampled ${RUN_ID}`.slice(0, 60);
  await saveSignalStrategy(page, name);
  // The ruin level is the strategy's equity-stop floor, set on its risk screen (TEST value, under the 1000 cash).
  await page.goto('/quant/strategies');
  await page.getByTestId('quant-strategy-name').filter({ hasText: name }).click();
  const screen = page.getByTestId('quant-risk-screen');
  await screen.getByLabel('Equity-stop floor').fill('500');
  await screen.getByRole('combobox', { name: 'When the floor is hit' }).selectOption('reduce_only');
  await screen.getByRole('button', { name: 'Save caps' }).click();
  await expect(screen.getByTestId('quant-risk-note')).toHaveText('Caps saved.');

  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: name });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('0');
  await room.getByTestId('quant-backtest-run').click();
  const finished = room.getByTestId('quant-bar-result');
  await expect(finished).toBeVisible();
  await room.getByRole('group', { name: 'Result views' }).getByRole('button', { name: 'Monte Carlo resampling', exact: true }).click();

  const first = await monteCarlo(room, 7);
  await expect(first.result).toHaveAttribute('data-runs', /^[1-9]\d*$/);
  expect(Number(await first.result.getAttribute('data-trips'))).toBeGreaterThanOrEqual(2);
  await expect(first.result.getByTestId('quant-montecarlo-label')).toHaveText(
    'Simulated resampling of a historical simulation — not a forecast',
  );
  expect(first.rows.map(([p]) => p)).toEqual(['p5', 'p25', 'p50', 'p75', 'p95']);
  const num = (s) => Number(s);
  for (const [p, drawdown, final] of first.rows) {
    expect(drawdown, `${p} drawdown`).toMatch(/^\d+(\.\d+)?$/);
    expect(final, `${p} final equity`).toMatch(/^-?\d+(\.\d+)?$/);
  }
  // Percentiles rise with the rank.
  const finals = first.rows.map(([, , f]) => num(f));
  expect(finals).toEqual([...finals].sort((a, b) => a - b));
  const drawdowns = first.rows.map(([, d]) => num(d));
  expect(drawdowns).toEqual([...drawdowns].sort((a, b) => a - b));
  // A ruin probability against the floor, as a percentage.
  expect(first.ruin).toMatch(/^\d+(\.\d+)?$/);
  expect(num(first.ruin)).toBeGreaterThanOrEqual(0);
  expect(num(first.ruin)).toBeLessThanOrEqual(100);
  await expect(first.result.getByTestId('quant-montecarlo-ruin')).toHaveAttribute('data-level', '500');

  // The same seed reads back the same figures.
  const again = await monteCarlo(room, 7);
  expect(again.rows).toEqual(first.rows);
  expect(again.ruin).toBe(first.ruin);
});

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

/** The owner's TEST wallet with TEST USDC on the venue, one funded sub-account, and a one-block strategy in svc-quant. */
async function liveOwner(session) {
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  await testDeposit(owner, 'USDC', '2000', `deposit:${J}:${RUN_ID}:${Date.now()}`);
  const saved = body200(
    await session.post('/api/quant/trpc/studio.save', {
      name: `TEST reviewed block ${RUN_ID}`.slice(0, 60),
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: BLOCK }],
      risk: { maxDrawdown: '100', maxNotional: '500', kill: '50' },
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: `${J}:${RUN_ID}:live`,
      idempotencyKey: `${J}:${RUN_ID}:live-save`,
    }),
  ).result.data;
  const t = { walletKey, owner, strategyId: saved.id };
  const name = `${J}-${RUN_ID}`.slice(0, 40);
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

/** The deploy wizard's start of a live run of one version, as svc-trade answers it. */
const startLive = (session, t, strategyVersion) =>
  session.post(LIVE, {
    runId: crypto.randomUUID(),
    strategyId: t.strategyId,
    strategyVersion,
    owner: t.owner,
    subAccount: t.sub,
    cap: '150',
    restartAttempts: '1',
    statePolicy: 'keep',
    liveControl: true,
  });

async function approvalPanel(page, path) {
  await page.goto(path);
  const panel = page.getByTestId('quant-approval');
  await expect(panel.getByTestId('quant-approval-policy')).toBeVisible();
  return panel;
}

test(`${J} #4 sets an organisation policy that live use needs an independent reviewer: a strategy cannot go live until a different member approves; any change voids it`, async ({
  page,
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const mate = await signUp(page, 'jr');
  await verify(page, mate);
  const mateId = await userIdOf(mate);
  const owner = await developer(page, 'jq');
  run.reset({ owner, mate });
  const session = await api(owner);
  const t = await liveOwner(session);
  const ownerPage = `/quant/strategies/${encodeURIComponent(t.strategyId)}`;

  // The policy starts not set; the owner turns it on for the account.
  let panel = await approvalPanel(page, ownerPage);
  await expect(panel.getByTestId('quant-approval-policy')).toHaveAttribute('data-required', '');
  await panel.getByRole('button', { name: 'Require an independent reviewer' }).click();
  await expect(panel.getByTestId('quant-approval-policy')).toHaveAttribute('data-required', 'true');
  await expect(panel.getByTestId('quant-approval-live')).toHaveAttribute('data-allowed', 'false');
  await expect(panel.getByTestId('quant-approval-live')).toHaveText('Version 1 can’t go live until a different member approves it.');

  // Live use is refused before anyone approves, and nothing is stored.
  let refused = await startLive(session, t, 1);
  expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).toBe(409);
  expect(refused.body.intafacedCode).toBe('quant.approval_required');
  expect(body200(await session.get(LIVE)).runs ?? body200(await session.get(LIVE))).toEqual([]);

  // The owner asks for a review; approving their own is refused.
  await panel.getByRole('button', { name: 'Ask for a review of version 1' }).click();
  const row = panel.getByTestId('quant-approval-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-decision', 'pending');
  await panel.getByRole('button', { name: 'Approve version 1' }).click();
  await expect(panel.getByTestId('quant-approval-refusal')).toHaveAttribute('data-code', 'quant.approval_self_review');
  await expect(row).toHaveAttribute('data-decision', 'pending');

  // The owner shares the strategy with the teammate, who approves it.
  const team = page.getByTestId('quant-team');
  const form = team.getByTestId('quant-share-form');
  await form.getByLabel('Teammate account id').fill(mateId);
  await form.getByLabel('Permission for the teammate').selectOption('view');
  await form.getByLabel('Allow live control (stop paper runs)').uncheck();
  await form.getByRole('button', { name: 'Save permission' }).click();
  await expect(form.getByTestId('quant-share-note')).toHaveText(`Saved: ${mateId} can view it.`);

  const mateContext = await browser.newContext();
  const matePage = await mateContext.newPage();
  await signIn(matePage, mate);
  const matePanel = await approvalPanel(matePage, `/quant/shared/${encodeURIComponent(t.strategyId)}`);
  await matePanel.getByLabel('Reason (optional)').fill('TEST reviewed');
  await matePanel.getByRole('button', { name: 'Approve version 1' }).click();
  const mateRow = matePanel.getByTestId('quant-approval-row');
  await expect(mateRow).toHaveAttribute('data-decision', 'approved');
  await expect(mateRow).toHaveAttribute('data-reviewer', mateId);
  await expect(matePanel.getByTestId('quant-approval-live')).toHaveAttribute('data-allowed', 'true');
  await mateContext.close();

  // Now version 1 goes live: the run is stored, the wallet signs its permission, and the block fills on the venue.
  panel = await approvalPanel(page, ownerPage);
  await expect(panel.getByTestId('quant-approval-live')).toHaveText('Version 1 may go live.');
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

  // Any change voids it: a new parameter is version 2, which has no approval and cannot go live.
  const head = body200(await session.get(`/api/quant/trpc/studio.get?input=${encodeURIComponent(JSON.stringify({ id: t.strategyId }))}`))
    .result.data;
  body200(
    await session.post('/api/quant/trpc/studio.update', {
      id: t.strategyId,
      name: head.name,
      blocks: [{ side: 'buy', symbol: SYMBOL, qty: '0.002' }],
      risk: head.risk,
      cash: head.cash,
      environment: 'paper',
      presentedAs: 'paper',
      clientStrategyId: head.clientStrategyId,
      idempotencyKey: `${J}:${RUN_ID}:v2`,
    }),
  );
  panel = await approvalPanel(page, ownerPage);
  await expect(panel.getByTestId('quant-approval-live')).toHaveAttribute('data-version', '2');
  await expect(panel.getByTestId('quant-approval-live')).toHaveText('Version 2 can’t go live until a different member approves it.');
  refused = await startLive(session, t, 2);
  expect(refused.status, JSON.stringify(refused.body).slice(0, 400)).toBe(409);
  expect(refused.body.intafacedCode).toBe('quant.approval_required');
  expect(JSON.stringify(refused.body)).toContain('version 2');

  // The live run of version 1 is stopped again; its position stays in the owner's own sub-account.
  const stopped = body200(await session.post(`${LIVE}/${runId}/stop`, { seq: 1 }));
  expect(stopped.state).toBe('stopped');
});
