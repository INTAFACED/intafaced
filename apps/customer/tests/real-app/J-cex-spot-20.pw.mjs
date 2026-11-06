// World: book, restart, gates
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { fundedTrader } from './desk.mjs';
import { api, bestPrices, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';

// J-cex-spot-20 "I see the venue's health: matching, FIX, seeded liquidity and the published rulebook", in the founder
// console (apps/admin) against the running stack. One test per step, titled "J-cex-spot-20 #<n>". The founder is founder A;
// a second operator who approves is founder B. Every figure on a tile is checked against the service that owns it, read
// on its own: the engine's own /health (svc-matching, the stack's port 14505), svc-trade's reads through the customer API,
// and the ledger's fee postings as the customer's own fills report them.
const J = 'J-cex-spot-20';
const SYMBOL = 'BTC/USDT';
const MATCHING = 'http://127.0.0.1:14505';
const RUN = Date.now().toString(36);
const run = journeyState(J);

// Not serial: steps still to build stay red on their own and never stop the others from running (the run's
// Left-or-replaced line names them). Steps share state through journeyState, and the stack runs one worker.

/** The engine's own health answer, read straight from svc-matching (no console, no edge). */
async function engineHealth() {
  const res = await fetch(`${MATCHING}/health`);
  expect(res.status).toBe(200);
  return res.json();
}

/** The engine's first health answer after a restart: it may still be replaying its journal when the restart returns. */
async function engineBackUp() {
  let body = null;
  await expect
    .poll(
      async () => {
        body = await engineHealth().catch(() => null);
        return body !== null;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return body;
}

/** The founder console's Health room, signed in as founder `key`. */
async function health(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/trade-ops`);
  await expect(page.getByRole('region', { name: 'Venue / matching' })).toBeVisible();
  return page;
}

async function place(who, body) {
  const res = await (await api(who)).post('/api/v1/orders', { symbol: SYMBOL, timeInForce: 'GTC', ...body });
  // A new order answers 201 Created; any other answer is a refusal to read.
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
  return res.body;
}

async function customerFills(who, id) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${id}/trades?limit=100`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return Array.isArray(body) ? body : (body.trades ?? body.items ?? []);
}

/** Founder B approves exactly `payloadHash` in Freezes & approvals. */
async function approveAsB(browser, approvalId, payloadHash) {
  const context = await browser.newContext();
  const b = await context.newPage();
  await founderSignIn(b, 'b');
  await b.goto(`${ADMIN}/trade-ops/approvals`);
  await b.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await b.getByLabel('Payload hash you reviewed').fill(payloadHash);
  await b.getByRole('button', { name: 'Approve request' }).click();
  const dialog = b.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
  await context.close();
}

/** The value next to `label` in a filed request's key/value list. */
const filed = (scope, label) => scope.locator(`[data-field="${label}"]`);

test.beforeAll(async ({ browser }) => {
  if (run.read().customer) return;
  test.setTimeout(240_000);
  const page = await browser.newPage();
  const customer = await fundedTrader(page, 'jcs20', '1000');
  await page.close();
  run.write({ customer });
});

test(`${J} #1 opens matching and trade health: venue health from the engine; a metric not yet read shows matching_metrics_unread`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { customer } = run.read();
  // A fresh engine has timed nothing since it started. The stack's own market maker submits on its quoted markets at
  // once (run 42241363359 saw 6 submits before the first read), so the metric not yet read is the submit latency of the
  // unquoted TEST market IFC/USDC, which nothing but a journey trades. The restart replays the journal, so the books
  // come back as they were (the engine's own restingOrders below says so).
  tool('local-test-stack.mjs', 'restart', 'matching');
  await engineBackUp();

  await health(page);
  const venue = page.getByRole('region', { name: 'Venue / matching' });
  await expect(venue).toHaveAttribute('data-tile-state', 'live');
  // Every figure is the engine's own: halt state, markets, resting orders, admission and hold-halted markets. The stack's
  // market maker re-quotes every few seconds, so the resting count moves (run 42247381475: 44 read, 46 shown). It is
  // compared inside a still window: the engine read before and after the page load agree, and the page must show
  // exactly that.
  let engine = null;
  await expect
    .poll(
      async () => {
        const before = await engineHealth();
        await page.reload();
        const shown = await page
          .getByRole('region', { name: 'Venue / matching' })
          .locator('[data-metric=resting-orders]')
          .getAttribute('data-value');
        const after = await engineHealth();
        if (before.restingOrders !== after.restingOrders) return 'moving';
        engine = after;
        return shown === String(after.restingOrders) ? 'equal' : `shown ${shown}, engine ${after.restingOrders}`;
      },
      { timeout: 90_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe('equal');
  await expect(venue.locator('[data-metric=venue-halted]')).toHaveText(engine.venueHalted ? 'Halted' : 'Running');
  await expect(venue.locator('[data-metric=markets]')).toHaveAttribute('data-value', String(engine.markets));
  await expect(venue.locator('[data-metric=admission]')).toHaveText(engine.admissionOpen ? 'Open' : `Closed: ${engine.admissionReason}`);
  await expect(venue.locator('[data-metric=hold-halted]')).toHaveAttribute('data-value', engine.holdHalted.join(','));
  await expect(venue.locator('[data-metric=engine-started]')).toHaveAttribute('data-value', engine.metrics.startedAt);
  // The venue-wide submit latency is read, with the engine's own bucket bound.
  const all = venue.locator('[data-metric=latency-submit]');
  if (engine.metrics.operations.submit.count > 0) await expect(all).toHaveAttribute('data-state', 'read');

  // IFC/USDC's submit latency has no reading since the engine started: the typed blocker, and no number.
  const quiet = venue.locator('[data-metric=latency-submit-market][data-market-symbol="IFC/USDC"]');
  await expect(quiet).toHaveAttribute('data-state', 'unread');
  await expect(quiet).toContainText('matching_metrics_unread');
  await expect(quiet).not.toContainText(/\d+(\.\d+)? ms/);
  const marketId = await quiet.getAttribute('data-market-id');
  expect(engine.metrics.submitByMarket[marketId]?.count ?? 0).toBe(0);

  // One IFC/USDC order reaches the engine (a TEST bid far under any price, cancelled again so the book stays empty);
  // after a refresh the same metric is read, and it is the engine's own figure.
  expect(fund(customer.email, 'USDC', '5').tx).toBeTruthy();
  const order = await place(customer, {
    symbol: 'IFC/USDC',
    type: 'limit',
    side: 'buy',
    amount: '1',
    price: '0.01',
    clientOrderId: `${J}-1-${RUN}`,
  });
  try {
    await expect
      .poll(async () => (await engineHealth()).metrics.submitByMarket[marketId]?.count ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.reload();
    const after = await engineHealth();
    const read = page
      .getByRole('region', { name: 'Venue / matching' })
      .locator(`[data-metric=latency-submit-market][data-market-id="${marketId}"]`);
    await expect(read).toHaveAttribute('data-state', 'read');
    await expect(read).not.toContainText('matching_metrics_unread');
    expect(Number(await read.getAttribute('data-count'))).toBe(after.metrics.submitByMarket[marketId].count);
    await expect(read).toContainText(`p99 ≤ ${after.metrics.submitByMarket[marketId].p99Ms} ms`);
  } finally {
    const res = await (await api(customer)).delete(`/api/v1/orders/${order.id}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  }
});

test(`${J} #2 opens the reconcile tile: the blocker reconcile_route_missing until support reconcile exists`, async ({ page }) => {
  test.setTimeout(180_000);
  // Support reconcile exists (svc-trade admin.orders.reconcileStatus and the sweep, J-cex-spot-18), so the tile reads the
  // last sweep instead of the blocker. A sweep run now is the one the tile must show.
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/orders`);
  const sweep = page.getByRole('region', { name: 'Reconcile sweep' });
  await sweep.getByRole('button', { name: 'Start reconcile sweep' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Reason (kept in the audit)').fill(`TEST ${J} venue health check`);
  await dialog.getByRole('button', { name: 'Start reconcile sweep' }).click();
  await expect(dialog.getByRole('status')).toContainText('Swept', { timeout: 60_000 });
  // The dialog is modal: the run's counts behind it are read once it is closed.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  const ran = sweep.locator('[data-sweep-result]').last();
  const checked = await ran.getAttribute('data-checked');
  const released = await ran.getAttribute('data-released');

  await page.goto(`${ADMIN}/trade-ops`);
  const tile = page.getByRole('region', { name: 'Reconcile' });
  await expect(tile).toHaveAttribute('data-tile-state', 'live');
  await expect(tile).not.toContainText('reconcile_route_missing');
  await expect(tile).not.toContainText('there is no route to start or read it');
  const last = tile.locator('[data-last-sweep]');
  await expect(last).toHaveAttribute('data-checked', checked);
  await expect(last).toHaveAttribute('data-released', released);
  await expect(last).toContainText(`${checked} orders checked · ${released} holds released`);
});

test(`${J} #3 opens FIX sessions and SBE consumers: sessions, CompID mapping and consumers from the adapter's own status; no balance or Greeks computed there`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops`);
  await page.getByRole('link', { name: 'Open FIX and SBE' }).click();
  await expect(page).toHaveURL(/\/trade-ops\/adapters$/);
  const fix = page.getByRole('region', { name: 'FIX sessions' });
  const sbe = page.getByRole('region', { name: 'SBE consumers' });
  await expect(fix).toHaveAttribute('data-read', 'ok');
  await expect(sbe).toHaveAttribute('data-read', 'ok');

  // The adapter's own status, read through the edge's operator door; the room shows exactly that, row for row.
  const status = JSON.parse(
    tool('local-test-gates.mjs', 'adapter-status')
      .split('\n')
      .find((l) => l.startsWith('ADAPTER_STATUS_JSON '))
      .slice(20),
  );
  expect(status.fix.sessions.length).toBeGreaterThan(0);
  await expect(fix.locator('tr[data-session]')).toHaveCount(status.fix.sessions.length);
  for (const s of status.fix.sessions) {
    const row = fix.locator(`tr[data-session="${s.senderCompId}:${s.targetCompId}"]`);
    await expect(row).toContainText(s.senderCompId);
    await expect(row).toContainText(s.targetCompId);
    await expect(row.locator('[data-col=state]')).toHaveText(s.state);
    // A drop-copy session carries no orders, so it maps to no account; an order-entry one shows the account svc-fix
    // submits its orders as, or that none is mapped.
    await expect(row.locator('[data-col=account]')).toHaveText(
      s.role === 'drop-copy' ? 'Drop copy (no orders)' : (s.accountId ?? 'Not mapped'),
    );
  }
  // The CompID mapping, row for row as svc-fix holds it.
  const map = page.getByRole('region', { name: 'CompID mapping' });
  await expect(map).toHaveAttribute('data-read', 'ok');
  expect(status.fix.compIdMapSet).toBe(true);
  await expect(map.locator('tr[data-compid]')).toHaveCount(status.fix.compIdMap.length);
  for (const m of status.fix.compIdMap) {
    await expect(map.locator(`tr[data-compid="${m.compId}"] [data-col=account]`)).toHaveText(m.accountId);
  }
  await expect(sbe.locator('tr[data-consumer]')).toHaveCount(status.sbe.consumers.length);
  await expect(sbe.locator('[data-codec]')).toHaveAttribute('data-codec', status.sbe.codecLinked ? 'linked' : 'unlinked');
  for (const c of status.sbe.consumers) {
    await expect(sbe.locator(`tr[data-consumer="${c.id}"] [data-col=last-sequence]`)).toHaveText(c.lastSequence ?? 'None sent');
  }
  // Adapters carry orders and market data only: no balance, margin or Greeks column anywhere in the room.
  for (const word of [/balance/i, /greeks/i, /delta/i, /margin/i]) {
    await expect(page.locator('main th')).not.toContainText([word]);
  }
});

/** The unquoted TEST market (seed-spot-test-listing.mjs `UNQUOTED_TEST_SPOT`): its book is empty, so the seed may place. */
const SEED_MARKET = 'IFC/USDC';
/** A TEST mid for it: the stack has no price feed for IFC/USDC, and the configured source is what an operator types. */
const SEED_MID = '1';

/** Fills the seeding form as `values` says; a value left out stays blank. */
async function fillSeeding(form, values) {
  await form.getByLabel('Market').selectOption(SEED_MARKET);
  if (values.enabled) await form.getByLabel('Enabled').check();
  else await form.getByLabel('Enabled').uncheck();
  await form.getByLabel('Half spread (bps)').fill(values.half ?? '');
  await form.getByLabel('Step (bps)').fill(values.step ?? '');
  await form.getByLabel('Levels').fill(values.levels ?? '');
  await form.getByLabel('Quantity per level').fill(values.qty ?? '');
  await form.getByLabel('Mid source').selectOption(values.midSource ?? '');
  await form.getByLabel('Configured mid').fill(values.mid ?? '');
}

/** Founder A files the version, founder B approves it, founder A writes it. Returns the approval id. */
async function writeSeeding(page, browser, values) {
  await page.goto(`${ADMIN}/trade-ops/seeding`);
  const room = page.locator('[data-room=seeding]');
  const form = room.getByRole('form', { name: 'Seeding configuration' });
  await fillSeeding(form, values);
  await form.getByRole('button', { name: 'Propose configuration' }).click();
  const request = room.locator('[data-filed]');
  await expect(request).toBeVisible();
  const approvalId = (await filed(request, 'Approval id').textContent()).trim();
  const payloadHash = (await filed(request, 'Payload hash').textContent()).trim();
  expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  // Filed, not written: the room as it was read still shows no version under this approval.
  await expect(room.locator(`[data-config][data-approval="${approvalId}"]`)).toHaveCount(0);
  await approveAsB(browser, approvalId, payloadHash);
  await form.getByLabel('Approved request id').fill(approvalId);
  await form.getByRole('button', { name: 'Apply approved configuration' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Write configuration' }).click();
  await expect(dialog.getByRole('status')).toContainText('Written', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  return approvalId;
}

/** The seeded orders the Orders room flags on the seed market. */
async function houseSeeds(page) {
  await page.goto(`${ADMIN}/trade-ops/orders?limit=500`);
  await expect(page.locator('[data-origin]').first()).toBeVisible();
  return {
    house: await page.locator(`[data-origin="House seed"][data-order-symbol="${SEED_MARKET}"]`).count(),
    customer: await page.locator(`[data-origin="Customer"][data-order-symbol="${SEED_MARKET}"]`).count(),
  };
}

test(`${J} #5 writes the internal book seeding configuration: an operator-written config and console with approvals`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/seeding`);
  const room = page.locator('[data-room=seeding]');
  await expect(room).toBeVisible();
  const form = room.getByRole('form', { name: 'Seeding configuration' });
  const full = { enabled: true, half: '500', step: '50', levels: '3', qty: '10', midSource: 'configured', mid: SEED_MID };

  // A blank step is refused by name, with svc-trade's own code, and nothing is filed.
  await fillSeeding(form, { ...full, step: '' });
  await form.getByRole('button', { name: 'Propose configuration' }).click();
  const alert = room.getByRole('alert');
  await expect(alert).toContainText('mm.seed_unset');
  await expect(alert).toContainText('step is not set');
  await expect(alert).toContainText('Nothing was filed.');
  await expect(room.locator('[data-filed]')).toHaveCount(0);

  // The complete version, filed by A, approved by B, written by A.
  const approvalId = await writeSeeding(page, browser, full);
  await page.reload();
  const current = room.locator(`[data-config][data-market="${SEED_MARKET}"]`);
  await expect(current).toHaveAttribute('data-approval', approvalId);
  await expect(current).toHaveAttribute('data-enabled', 'true');
  await expect(current.locator('[data-col=half-spread]')).toHaveText('500 bps');
  await expect(current.locator('[data-col=step]')).toHaveText('50 bps');
  await expect(current.locator('[data-col=levels]')).toHaveText('3');
  await expect(current.locator('[data-col=qty]')).toHaveText('10');
  await expect(current.locator('[data-col=mid]')).toHaveText(`Configured ${SEED_MID}`);
  await expect(current.locator('[data-col=source]')).toHaveText('Operator config');
  run.write({ ...run.read(), seedApproval: approvalId });
});

test(`${J} #4 opens seeded liquidity: seeded orders flagged and the seeded share, "unknown" when nothing is open`, async ({ page }) => {
  test.setTimeout(240_000);
  await founderSignIn(page, 'a');
  // The approved configuration (#5) places three levels a side on the house account; each is flagged as seeded.
  let seen = { house: 0, customer: 0 };
  await expect.poll(async () => (seen = await houseSeeds(page)).house, { timeout: 150_000 }).toBe(6);
  expect(seen.customer).toBe(0);

  // The seed market's open quantity is all seeded, so its share is 100%; it is quantity from the same flag.
  await page.goto(`${ADMIN}/trade-ops/markets`);
  await expect(page.locator(`[data-col=seeded][data-market-symbol="${SEED_MARKET}"]`)).toHaveText('100%');
  // A market with nothing open reads "unknown", never 0%.
  const empty = page.locator('[data-col=seeded][data-open-orders="0"]').first();
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('unknown');
});

// The world the next journey file finds: the seed market switched off by the same two-person write, which cancels the
// seed's orders and leaves its book as empty as it was.
test.afterAll(async ({ browser }) => {
  if (!run.read().seedApproval || run.read().seedOff) return;
  test.setTimeout(300_000);
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, 'a');
  await writeSeeding(page, browser, { enabled: false });
  await expect.poll(async () => (await houseSeeds(page)).house, { timeout: 150_000 }).toBe(0);
  run.write({ ...run.read(), seedOff: true });
  await page.context().close();
});

test(`${J} #6 opens the published trading rulebook: versioned rulebook text customers can read`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/rulebook`);
  const room = page.locator('[data-room=rulebook]');
  await expect(room).toBeVisible();
  const version = `TEST-${RUN}`;
  const sections = ['participation', 'matching', 'cancellation', 'settlement', 'liquidation', 'fees', 'market data'];
  const form = room.getByRole('form', { name: 'Publish a rulebook version' });
  await form.getByLabel('Version').fill(version);
  for (const s of sections.slice(0, 6)) await form.getByLabel(`Section: ${s}`).fill(`TEST ${s} rules for ${version}.`);
  // A version missing a section is refused by name.
  await form.getByRole('button', { name: 'Propose version' }).click();
  await expect(room.getByRole('alert')).toContainText('matching.rulebook_section_unset');
  await form.getByLabel('Section: market data').fill(`TEST market data rules for ${version}.`);
  await form.getByRole('button', { name: 'Propose version' }).click();
  const request = room.locator('[data-filed]');
  const approvalId = (await filed(request, 'Approval id').textContent()).trim();
  const payloadHash = (await filed(request, 'Payload hash').textContent()).trim();
  await approveAsB(browser, approvalId, payloadHash);
  await room.getByRole('button', { name: 'Publish approved version' }).click();
  await page.reload();
  await expect(room.locator('[data-current-version]')).toHaveText(version);
  await expect(room.locator(`[data-history] [data-version="${version}"]`)).toBeVisible();

  // A customer reads the same text on the public page, with its version and effective time.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto('/rulebook');
  await expect(customer.locator('[data-rulebook-version]')).toHaveText(version);
  for (const s of sections) await expect(customer.locator(`[data-section="${s}"]`)).toContainText(`TEST ${s} rules for ${version}.`);
  await expect(customer.locator('[data-effective-at]')).toBeVisible();
  await customer.context().close();
});

test(`${J} #7 opens the venue unit economics report: revenue and cost lines from real postings or named blockers`, async ({ page }) => {
  test.setTimeout(240_000);
  const { customer } = run.read();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops`);
  await page.getByRole('link', { name: 'Open venue unit economics' }).click();
  await expect(page).toHaveURL(/\/more-ops\/venue-economics/);
  const report = page.getByTestId('venue-report');
  await expect(report).toBeVisible();

  // One customer buy through the best ask pays a fee; the ledger's fee accounts for this month grow by exactly that fee.
  const collected = async (asset) => {
    const cell = page.locator(`[data-testid=fees-table] tr[data-asset="${asset}"] [data-col=collected]`);
    return (await cell.count()) === 0 ? 0n : toUnits((await cell.textContent()).trim());
  };
  const { ask } = await bestPrices(SYMBOL);
  const one = toUnits('1');
  const through = fromUnits(((toUnits(ask) * 105n) / 100n / one) * one);
  const before = { USDT: await collected('USDT'), BTC: await collected('BTC') };
  const order = await place(customer, { type: 'limit', side: 'buy', amount: '0.001', price: through, clientOrderId: `${J}-7-${RUN}` });
  let fills = [];
  await expect.poll(async () => (fills = await customerFills(customer, order.id)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const fees = {};
  for (const f of fills) fees[f.fee.currency] = (fees[f.fee.currency] ?? 0n) + toUnits(f.fee.cost);
  for (const [asset, fee] of Object.entries(fees)) {
    expect(fee).toBeGreaterThan(0n);
    await expect
      .poll(
        async () => {
          await page.reload();
          return (await collected(asset)) - (before[asset] ?? 0n);
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(fee);
  }

  // Every other line is a figure or a named blocker, never a blank and never a zero standing in for a missing read.
  const revenue = page.locator('[data-testid=revenue-table], [data-testid=revenue-empty], [data-testid=revenue-unavailable]');
  await expect(revenue).toHaveCount(1);
  if ((await page.getByTestId('revenue-unavailable').count()) > 0)
    await expect(page.getByTestId('revenue-unavailable')).toContainText(/Code: [a-z_.]+/i);
  for (const category of ['liquidity', 'insurance_default_capital', 'custody', 'data', 'support', 'compliance', 'infrastructure']) {
    await expect(page.getByTestId(`cost-${category}`)).toContainText(/Not entered|\d/);
  }
  const net = page.locator('[data-testid=net-table], [data-testid=net-unavailable]');
  await expect(net).toHaveCount(1);
  if ((await page.getByTestId('net-unavailable').count()) > 0) {
    await expect(page.getByTestId('net-unavailable')).toContainText(/costs_incomplete|revenue_unavailable|revenue_asset_unknown/);
  }
});

test(`${J} #8 opens the launch liquidity plan record and the maker incentive programme: per-market plans, tiers, obligations and clawback records`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/launch-liquidity`);
  const plans = page.locator('[data-room=launch-liquidity]');
  await expect(plans).toBeVisible();
  // One record per market: its plan (makers, capital, spread, depth, uptime, inventory band, exit criteria and state), or
  // "No plan recorded" for a market that has none; never an invented plan.
  const markets = plans.locator('[data-plan-market]');
  expect(await markets.count()).toBeGreaterThan(0);
  for (const m of await markets.all()) {
    const state = await m.getAttribute('data-plan-state');
    expect(['none', 'draft', 'approved', 'active', 'exited']).toContain(state);
    if (state === 'none') await expect(m).toContainText('No plan recorded');
    else
      for (const col of ['makers', 'capital', 'max-spread', 'min-depth', 'min-uptime', 'inventory-band', 'exit-criteria'])
        await expect(m.locator(`[data-col=${col}]`)).not.toBeEmpty();
  }

  await page.goto(`${ADMIN}/trade-ops/maker-programme`);
  const programme = page.locator('[data-room=maker-programme]');
  await expect(programme).toBeVisible();
  // Tiers and obligations as the programme terms state them, or the typed blocker naming the unset term.
  const terms = programme.locator('[data-terms]');
  const termsState = await terms.getAttribute('data-state');
  if (termsState === 'unset') await expect(terms).toContainText('trade.maker_programme_term_unset');
  else {
    await expect(terms.locator('[data-tier]').first()).toBeVisible();
    for (const col of ['max-spread', 'min-depth', 'min-uptime', 'cancel-ratio-ceiling', 'clawback-window'])
      await expect(terms.locator(`[data-obligation=${col}]`)).not.toBeEmpty();
  }
  // Clawback records: each with its period, account, amount and state, or an empty list that says so.
  const clawbacks = programme.getByRole('region', { name: 'Clawback records' });
  await expect(clawbacks).toBeVisible();
  if ((await clawbacks.locator('tr[data-clawback]').count()) === 0) await expect(clawbacks).toContainText('No clawback recorded');
});
