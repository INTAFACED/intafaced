// World: book, gates
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, bestPrices, fromUnits, fund, otherTrader, times, toUnits } from './stack.mjs';
import { fundedTrader, openOrders } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { withPartner } from './partner.mjs';

// J-cex-spot-17, in the running app (docs/roadmap/journeys.json): finance publishes and versions fees, VIP tiers and
// convert limits in the founder console's Fees and convert room (/trade-ops/fees). One test per step, titled
// "J-cex-spot-17 #<n>". Founder A proposes, founder B approves in Freezes & approvals, A writes. Every schedule here is a
// TEST version, never an owner value: the default pair group keeps the stack's regular rates (maker 0.08%, taker 0.10%),
// so every other journey on the stack trades at the rates it always did, and each step puts that schedule back when done.
// TEST groups hold IFC/USDT, a market only fee journeys move between groups.
const J = 'J-cex-spot-17';

/** TEST rates through the real write path, not owner decisions (the same TEST schedule J-cex-spot-10 publishes). */
const REGULAR = { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null };
const VIP = { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null };
const ZERO = { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null };
const SCHEDULE = {
  defaultPairGroup: 'all-others',
  pairGroups: { 'ETH/USDC': 'test-zero-fee' },
  rows: [REGULAR, VIP, ZERO],
  perpetual: { makerBps: '2', takerBps: '5' },
};
/** IFC/USDT in a TEST group at maker `makerBps`, taker 0.10%. */
const GROUP = 'test-fee-change';
const changeTo = (makerBps) => ({
  ...SCHEDULE,
  pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': GROUP },
  rows: [...SCHEDULE.rows, { pairGroup: GROUP, tierId: 'regular', zeroFee: false, makerBps, takerBps: '10', minFee: null }],
});
/** IFC/USDT in a TEST group whose maker pays nothing and earns 0.05% back out of the taker's 0.10%. */
const REBATE_ROW = {
  pairGroup: 'test-rebate',
  tierId: 'regular',
  zeroFee: false,
  makerBps: '0',
  takerBps: '10',
  makerRebateBps: '5',
  minFee: null,
};
const REBATES = { ...SCHEDULE, pairGroups: { ...SCHEDULE.pairGroups, 'IFC/USDT': 'test-rebate' }, rows: [...SCHEDULE.rows, REBATE_ROW] };
/** SCHEDULE with a TEST tier programme: TEST VIP from 1,000 of 30-day volume, its daily snapshot at `snapshotTimeUtc`. */
const tiersAt = (snapshotTimeUtc) => ({
  ...SCHEDULE,
  rows: [...SCHEDULE.rows, { ...ZERO, tierId: 'test-vip-1' }],
  tierProgram: {
    thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
    volumeQuotes: ['USDT', 'USDC'],
    snapshotTimeUtc,
    downgradeGraceDays: null,
    subAccounts: null,
    botsAndCopy: null,
  },
});

test.describe.configure({ mode: 'default' });

/** The stack's two TEST operators, signed in once for the file, for the setup writes the steps start from. */
let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

const published = async () => {
  const res = await fetch(`${EDGE}/api/v1/fees/published`);
  return { status: res.status, body: await res.json() };
};

/** The operator read of every stored version, as the room is served it. */
async function storedVersions() {
  const { ctx, sessions } = await ops();
  const res = await ctx.edge.query('trade', 'admin.fees.get', undefined, await sessions.a.tradeOpsToken());
  const data = res.json?.result?.data;
  if (!data) throw new Error(`admin.fees.get refused (${res.status}): ${res.text.slice(0, 300)}`);
  return data;
}

/**
 * Write `schedule` as the next version through the two-person door, effective in ten seconds or just after `after`, and
 * wait until the public read serves it (unless `wait` is false: a version that starts later).
 */
async function publish(schedule, reason, { after = null, leadMs = 10_000, wait = true } = {}) {
  const { ctx, sessions } = await ops();
  const effectiveAt = Math.max(Date.now() + leadMs, after ? Date.parse(after) + 5_000 : 0);
  const row = await setFeeSchedule(ctx, schedule, { effectiveAt, reason: `LOCAL TEST ${J}: ${reason}`, sessions });
  // Follows the version this call wrote, and waits until its own effective time has passed: one written to start after a
  // version still scheduled (`after`) is not served before then.
  const lead = Math.max(0, Date.parse(row.effectiveAt) - Date.now());
  if (wait) await expect.poll(async () => (await published()).body.version, { timeout: lead + 30_000 }).toBe(`v${row.version}`);
  return row;
}

/** The latest stored version's effective time: a new version may not start before it. */
async function latestEffective() {
  const { history } = await storedVersions();
  return history.length ? history[history.length - 1].effectiveAt : null;
}

/** Put the stack's own TEST schedule back, after any version still waiting to take effect. */
async function restore(why) {
  await publish(SCHEDULE, why, { after: await latestEffective() });
}

/** A time as the room writes it: "2026-11-06 10:31:05 UTC". */
const shown = (iso) => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
/** A time as the room's field takes it: "2026-11-06T10:31:05Z". */
const typed = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
/** A rate as the room writes it: 8 → "0.08% (8 bps)". */
const rate = (bps) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}% (${bps} bps)`;

/** Founder `key` in their own browser, on the Fees and convert room. */
async function room(browser, key) {
  const page = await (await browser.newContext()).newPage();
  const founder = await founderSignIn(page, key);
  await page.goto(`${ADMIN}/trade-ops/fees`);
  await expect(page.locator('[data-room=fees]')).toBeVisible();
  return { page, founder, close: () => page.context().close() };
}

const versionRow = (page, group, version, tier = 'regular') =>
  page.locator(`[data-fees=versions] [data-pair-group="${group}"] tr[data-version="v${version}"][data-tier="${tier}"]`);

/** Founder B approves exactly `payloadHash` in Freezes & approvals. */
async function approveAsB(b, approvalId, payloadHash) {
  await b.goto(`${ADMIN}/trade-ops/approvals`);
  // The queue's pending list loads after the page and lands above the form, moving "Approve request" down. A press
  // taken before it lands and a release after it misses the button, so no dialog opens (main run 42455893390): act
  // once the list is in, which also means the page is hydrated.
  await expect(b.getByRole('grid', { name: 'Approvals waiting for this operator' })).toBeVisible();
  await b.getByLabel('Approval id', { exact: true }).fill(approvalId);
  await b.getByLabel('Payload hash you reviewed').fill(payloadHash);
  await b.getByRole('button', { name: 'Approve request' }).click();
  const dialog = b.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.locator('[data-outcome=ok]')).toBeVisible();
}

/** The value next to `label` in a filed request's key/value list. */
const valueOf = (scope, label) => scope.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');

/**
 * A proposal in the room, as founder A files it, B approves it and A writes it. `edit` fills the form. Returns the
 * version the room says it wrote.
 */
async function proposeApproveWrite({ a, b, edit, reason }) {
  const form = a.locator('[data-fees=propose]');
  await edit(form);
  await form.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(reason);
  await form.getByRole('button', { name: 'Ask a second founder to approve' }).click();
  const filed = a.locator('[data-fees=proposed]');
  await expect(filed).toContainText('Request filed');
  const approvalId = (await valueOf(filed, 'Approval id (apply with this once approved)').innerText()).trim();
  const payloadHash = (await valueOf(filed, 'Payload hash (the approver confirms this)').innerText()).trim();
  expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);

  await approveAsB(b, approvalId, payloadHash);

  await form.getByLabel('Approved request id').fill(approvalId);
  await form.getByRole('button', { name: 'Apply the approved version' }).click();
  const dialog = a.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Write version' }).click();
  const written = a.locator('[data-fees=written]');
  await expect(written).toBeVisible({ timeout: 15_000 });
  const version = (await written.getAttribute('data-version')) ?? '';
  expect(version).toMatch(/^\d+$/);
  return { version, effectiveAt: await written.getAttribute('data-effective-at'), text: await written.innerText() };
}

// ── helpers for an order that rests across a version change (as J-cex-spot-10 #10 places and fills one) ──

/** The account's own fills of order `id`, once the service has settled at least one. */
async function fillsOf(client, symbol, id) {
  let fills = [];
  await expect
    .poll(
      async () => {
        const { status, body } = await client.get(`/api/v1/account/trades?symbol=${encodeURIComponent(symbol)}&limit=100`);
        expect(status).toBe(200);
        fills = (Array.isArray(body) ? body : (body.trades ?? [])).filter((f) => f.order === id);
        return fills.length;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return fills;
}

/**
 * A post-only IFC/USDT buy 3% under the best bid, below the house ladder, so it rests until sold into. `who` is first
 * funded with the order's own cost at that price plus 5% (whole USDT, rounded up), so the hold never depends on a guessed balance.
 */
async function restingIfcBuy(who, client, amount, clientOrderId) {
  const { bid } = await bestPrices('IFC/USDT');
  const price = fromUnits(((toUnits(bid) * 97n) / 100n / 10n ** 14n) * 10n ** 14n);
  const cost = times(price, amount);
  // Whole USDT, rounded up: the cost plus 5%, so any fill price at or under the limit stays covered.
  const one = toUnits('1');
  fund(who.email, 'USDT', fromUnits(((cost * 105n) / 100n / one + 1n) * one));
  const placed = await client.post('/api/v1/orders', {
    symbol: 'IFC/USDT',
    side: 'buy',
    type: 'limit',
    amount,
    price,
    timeInForce: 'PO',
    clientOrderId,
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBeLessThan(300);
  return { id: placed.body.id, price, amount };
}

/**
 * Another TEST trader sells into `who`'s resting IFC/USDT buy with an IOC, through any house bids at or above its price,
 * until nothing of `who`'s rests. An IOC that stops short while the buy rests at its price is a matching fault.
 */
async function sellInto(who, { id, price }, clientOrderId) {
  const until = Date.now() + 30_000;
  for (let round = 1; ; round += 1) {
    const resting = (await openOrders(who, 'IFC/USDT')).find((o) => o.id === id);
    if (!resting || Date.now() >= until) break;
    const { body } = await bestPrices('IFC/USDT');
    const ahead = body.bids.filter(([p]) => toUnits(p) >= toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    const size = fromUnits(ahead + toUnits(resting.remaining));
    const seller = otherTrader();
    fund(seller.email, 'IFC', size);
    const sell = await (
      await api(seller)
    ).post('/api/v1/orders', {
      symbol: 'IFC/USDT',
      side: 'sell',
      type: 'limit',
      amount: size,
      price,
      timeInForce: 'IOC',
      clientOrderId: round === 1 ? clientOrderId : `${clientOrderId}-${round}`,
    });
    expect(sell.status, JSON.stringify(sell.body).slice(0, 300)).toBeLessThan(300);
    const still = (await openOrders(who, 'IFC/USDT')).find((o) => o.id === id);
    const whole = toUnits(sell.body.filled) === toUnits(size);
    expect(!still || whole, `IOC round ${round} left ${id} resting: ${JSON.stringify(sell.body).slice(0, 300)}`).toBe(true);
  }
  await expect.poll(async () => (await openOrders(who, 'IFC/USDT')).length, { timeout: 30_000 }).toBe(0);
}

// ── the steps ──

test(`${J} #1 opens fee versions by pair group: current and previous versions with effective times, exact rates`, async ({ browser }) => {
  test.setTimeout(180_000);
  // Two TEST versions, one after the other: IFC/USDT's group at maker 0.05%, then at 0.04%.
  const previous = await publish(changeTo('5'), 'IFC/USDT maker 0.05%, the previous version', { after: await latestEffective() });
  const current = await publish(changeTo('4'), 'IFC/USDT maker 0.04%, the current version', { after: previous.effectiveAt });
  const a = await room(browser, 'a');
  try {
    const versions = a.page.locator('[data-fees=versions]');
    await expect(versions.locator(`[data-pair-group="${GROUP}"]`)).toContainText('IFC/USDT');

    // The test group: the current version and the one before it, each with its effective time and exact rates.
    const now = versionRow(a.page, GROUP, current.version);
    await expect(now).toHaveAttribute('data-state', 'current');
    await expect(now.locator('td')).toHaveText(['Current', shown(current.effectiveAt), 'regular', rate(4), rate(10), 'not set', 'none']);
    const before = versionRow(a.page, GROUP, previous.version);
    await expect(before).toHaveAttribute('data-state', 'previous');
    await expect(before.locator('td')).toHaveText([
      'Previous',
      shown(previous.effectiveAt),
      'regular',
      rate(5),
      rate(10),
      'not set',
      'none',
    ]);

    // Every other market's group in the same version, its regular and TEST VIP rows at their exact rates.
    await expect(versionRow(a.page, 'all-others', current.version).locator('td')).toHaveText([
      'Current',
      shown(current.effectiveAt),
      'regular',
      rate(8),
      rate(10),
      'not set',
      'none',
    ]);
    await expect(versionRow(a.page, 'all-others', current.version, 'test-vip-1').locator('td').nth(3)).toHaveText(rate(6));
    // What the room calls current is what customers are charged now.
    expect((await published()).body.version).toBe(`v${current.version}`);
  } finally {
    await a.close();
  }
});

test(`${J} #2 proposes a new version with a blank taker fee: refused with a typed code, and nothing is sent`, async ({ browser }) => {
  test.setTimeout(120_000);
  const before = await storedVersions();
  const a = await room(browser, 'a');
  try {
    const form = a.page.locator('[data-fees=propose]');
    await expect(form).toContainText(`Starts from v${before.version}`);
    // Every request the console sends from here on: a refused proposal must send none.
    const sent = [];
    a.page.on('request', (req) => {
      if (req.method() !== 'GET') sent.push(`${req.method()} ${new URL(req.url()).pathname}`);
    });
    await form.getByLabel(`Taker bps, ${GROUP} / regular`).fill('');
    await form.getByLabel('Takes effect at (UTC)').fill(typed(Date.now() + 3_600_000));
    await form.getByLabel('Reason (12 to 500 characters, kept in the audit)').fill(`LOCAL TEST ${J}: a version with no taker fee`);
    await form.getByRole('button', { name: 'Ask a second founder to approve' }).click();

    const refusal = a.page.locator('[data-fees=refused]');
    await expect(refusal).toContainText('trade.fee_schedule_blank');
    await expect(refusal).toContainText(`The taker fee of ${GROUP} / regular is blank`);
    await expect(refusal).toContainText('Nothing was sent.');
    await expect(a.page.locator('[data-fees=proposed]')).toHaveCount(0);
    // Long enough for a request the click started to have been sent.
    await a.page.waitForTimeout(1_500);
    expect(sent).toEqual([]);
    // And the service holds no new version.
    expect((await storedVersions()).version).toBe(before.version);
  } finally {
    await a.close();
  }
});

test(`${J} #3 proposes a complete version, a second operator approves: written with an effective time, and an open order keeps its placement version`, async ({
  page,
  browser,
}) => {
  // A resting order, a four-eyes write two minutes ahead, a wait until it takes effect, and a fill after it.
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const placedUnder = await publish(changeTo('4'), 'IFC/USDT maker 0.04%, before the change', { after: await latestEffective() });
  const who = await fundedTrader(page, 'js17', '100');
  const client = await api(who);
  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    // A customer's order placed now, under the version in force (maker 0.04%), resting across the change.
    const order = await restingIfcBuy(who, client, '200', `js17-before-${tag}`);
    expect((await openOrders(who, 'IFC/USDT')).map((o) => o.id)).toContain(order.id);

    // A proposes IFC/USDT's group at maker 0.02% from a stated time; B approves; A writes it.
    const effectiveMs = Math.ceil((Date.now() + 120_000) / 1_000) * 1_000;
    await a.page.reload();
    const written = await proposeApproveWrite({
      a: a.page,
      b: b.page,
      reason: `LOCAL TEST ${J}: IFC/USDT maker 0.02% from a stated time`,
      edit: async (form) => {
        await expect(form).toContainText(`Starts from v${placedUnder.version}`);
        await form.getByLabel(`Maker bps, ${GROUP} / regular`).fill('2');
        await form.getByLabel('Takes effect at (UTC)').fill(typed(effectiveMs));
      },
    });
    expect(written.effectiveAt).toBe(new Date(effectiveMs).toISOString());
    expect(written.text).toContain(`Written: v${written.version}, takes effect ${shown(effectiveMs)}.`);
    expect(Date.now()).toBeLessThan(effectiveMs);

    // The room lists it as scheduled, with its time and rates, beside the version in force.
    await a.page.reload();
    const next = versionRow(a.page, GROUP, written.version);
    await expect(next).toHaveAttribute('data-state', 'scheduled');
    await expect(next.locator('td')).toHaveText(['Scheduled', shown(effectiveMs), 'regular', rate(2), rate(10), 'not set', 'none']);
    await expect(versionRow(a.page, GROUP, placedUnder.version)).toHaveAttribute('data-state', 'current');
    // Writing a schedule moved nothing: the order still rests, unfilled.
    expect((await openOrders(who, 'IFC/USDT')).map((o) => o.id)).toContain(order.id);

    // It takes effect at the stated time, and the room then calls it current.
    await expect
      .poll(async () => (await published()).body.version, { timeout: effectiveMs - Date.now() + 30_000 })
      .toBe(`v${written.version}`);
    expect(Date.now()).toBeGreaterThanOrEqual(effectiveMs);
    await a.page.reload();
    await expect(versionRow(a.page, GROUP, written.version)).toHaveAttribute('data-state', 'current');
    await expect(versionRow(a.page, GROUP, placedUnder.version)).toHaveAttribute('data-state', 'previous');

    // The order placed before then fills after it, and pays the maker rate of the version it was placed under.
    await sellInto(who, order, `${J}-3-${order.id}`);
    const fills = await fillsOf(client, 'IFC/USDT', order.id);
    for (const fill of fills) {
      expect(fill.takerOrMaker).toBe('maker');
      expect(fill.fee).toMatchObject({ currency: 'IFC', rate: '0.0004' });
    }
    // A new order is checked at the new version's rate.
    const check = await client.post('/api/v1/orders/preview', {
      symbol: 'IFC/USDT',
      side: 'buy',
      type: 'limit',
      amount: order.amount,
      price: order.price,
      timeInForce: 'PO',
    });
    expect(check.status, JSON.stringify(check.body).slice(0, 300)).toBe(200);
    expect(check.body).toMatchObject({ feeRole: 'maker', feeBps: 2, feeScheduleVersion: `v${written.version}` });
  } finally {
    await a.close();
    await b.close();
    await restore('IFC/USDT back in the default pair group');
  }
});

test(`${J} #4 edits VIP thresholds and the snapshot time: the same proposal and approval path, and the snapshot row shows its figures`, async ({
  browser,
}) => {
  // A programme version, a four-eyes edit, and a wait of up to four minutes for the snapshot it names.
  test.setTimeout(420_000);
  const far = new Date(Date.now() + 6 * 3_600_000).toISOString().slice(11, 16);
  const base = await publish(tiersAt(far), 'TEST tier programme to edit', { after: await latestEffective() });
  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    const form = a.page.locator('[data-fees=propose]');
    await expect(form).toContainText(`Starts from v${base.version}`);
    await expect(form.getByLabel('Threshold (30-day volume), test-vip-1')).toHaveValue('1000');
    await expect(form.getByLabel('Snapshot time (UTC, HH:MM)')).toHaveValue(far);

    // The new version takes effect in 90 s; its snapshot runs at the first whole minute a minute after that.
    const effectiveMs = Math.ceil((Date.now() + 90_000) / 1_000) * 1_000;
    const snapshotAt = new Date(Math.ceil((effectiveMs + 60_000) / 60_000) * 60_000);
    const hhmm = snapshotAt.toISOString().slice(11, 16);
    const written = await proposeApproveWrite({
      a: a.page,
      b: b.page,
      reason: `LOCAL TEST ${J}: TEST VIP from 500, snapshot at ${hhmm}`,
      edit: async (f) => {
        await f.getByLabel('Threshold (30-day volume), test-vip-1').fill('500');
        await f.getByLabel('Snapshot time (UTC, HH:MM)').fill(hhmm);
        await f.getByLabel('Takes effect at (UTC)').fill(typed(effectiveMs));
      },
    });
    // Stored as proposed, through the same two-person write as the rates.
    const stored = (await storedVersions()).history.find((row) => row.version === written.version);
    expect(stored.schedule.tierProgram).toMatchObject({
      thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }],
      snapshotTimeUtc: hhmm,
    });
    expect(stored.approverId).toBe(b.founder.userId);
    await a.page.reload();
    await expect(a.page.locator(`[data-fees=programme][data-version="v${written.version}"]`)).toContainText(
      `test-vip-1 from 500 · snapshot ${hhmm} UTC`,
    );

    // The snapshot runs at its minute under the new version, and its row shows the figures it used.
    const row = a.page.locator(`[data-fees=snapshots] tr[data-snapshot="${snapshotAt.toISOString()}"]`);
    await expect
      .poll(
        async () => {
          await a.page.reload();
          return row.count();
        },
        { timeout: snapshotAt.getTime() - Date.now() + 120_000, intervals: [10_000] },
      )
      .toBe(1);
    await expect(row.locator('th')).toHaveText(shown(snapshotAt.toISOString()));
    const cells = row.locator('td');
    await expect(cells.nth(0)).toHaveText(`v${written.version}`);
    await expect(cells.nth(1)).toHaveText(/^\d+$/);
    await expect(cells.nth(2)).toHaveText(/^\d+$/);
    await expect(cells.nth(3)).toHaveText(/^\d+(\.\d+)?$/);
    expect(Number(await cells.nth(2).innerText())).toBeLessThanOrEqual(Number(await cells.nth(1).innerText()));
  } finally {
    await a.close();
    await b.close();
    await restore('tier programme off');
  }
});

test(`${J} #5 reads maker rebate tiers: a read-only list with the owner values`, async ({ browser }) => {
  test.setTimeout(150_000);
  const version = await publish(REBATES, 'TEST maker rebate on IFC/USDT', { after: await latestEffective() });
  const a = await room(browser, 'a');
  try {
    const list = a.page.locator('[data-fees=rebates]');
    await expect(list.getByRole('heading', { name: 'Maker rebate tiers' })).toBeVisible();
    await expect(list).toContainText(`From the version in force: v${version.version}`);
    await expect(list.locator('tr[data-pair-group="test-rebate"][data-tier="regular"] td')).toHaveText([
      'test-rebate',
      'regular',
      rate(0),
      rate(5),
    ]);
    await expect(list.locator('tr[data-pair-group="all-others"][data-tier="regular"] td')).toHaveText([
      'all-others',
      'regular',
      rate(8),
      'not set',
    ]);
    // Read only: nothing in the list can be typed into or pressed.
    await expect(list.locator('input, textarea, select, button')).toHaveCount(0);
  } finally {
    await a.close();
    await restore('maker rebate off');
  }
});

test(`${J} #6 publishes a fee-change notice: the customer notice and its effective time`, async ({ page, browser }) => {
  // A version three minutes ahead, a four-eyes notice for it, and the wait for it to take effect before the restore.
  test.setTimeout(420_000);
  const tag = Date.now().toString(36);
  const next = await publish(changeTo('3'), 'IFC/USDT maker 0.03% from a time a notice names', {
    after: await latestEffective(),
    leadMs: 180_000,
    wait: false,
  });
  const a = await room(browser, 'a');
  const b = await room(browser, 'b');
  try {
    const panel = a.page.locator('[data-fees=notice]');
    await panel.getByLabel('Version the notice is for').selectOption(`v${next.version}`);
    await expect(panel.locator('[data-fees=notice-effective]')).toHaveText(`Takes effect ${shown(next.effectiveAt)}`);
    const title = `TEST fee change ${tag}`;
    await panel.getByLabel('Notice title').fill(title);
    await panel.getByLabel('Notice text').fill('TEST: the IFC/USDT maker fee goes from 0.10% to 0.03%.');
    await panel.getByRole('button', { name: 'Save the notice draft' }).click();
    const draft = panel.locator('[data-fees=notice-draft]');
    await expect(draft).toContainText('Draft saved');
    const noticeId = await draft.getAttribute('data-notice-id');
    expect(noticeId).toMatch(/^[0-9a-f-]{36}$/);

    await panel.getByRole('button', { name: 'Ask a second founder to approve the notice' }).click();
    const filed = panel.locator('[data-fees=notice-proposed]');
    await expect(filed).toContainText('Request filed');
    const approvalId = (await valueOf(filed, 'Approval id (publish with this once approved)').innerText()).trim();
    const payloadHash = (await valueOf(filed, 'Payload hash (the approver confirms this)').innerText()).trim();
    await approveAsB(b.page, approvalId, payloadHash);

    await panel.getByLabel('Approved notice request id').fill(approvalId);
    await panel.getByRole('button', { name: 'Publish the notice' }).click();
    await expect(panel.locator('[data-fees=notice-published]')).toHaveText(
      `Published. Customers see it on the notice board; it takes effect ${shown(next.effectiveAt)}.`,
    );

    // The customer reads it on the public board, with the time the version takes effect, before it does.
    await page.goto('/notice');
    const card = page.getByTestId(`notice-${noticeId}`);
    await expect(card).toContainText(title);
    await expect(card).toContainText('Fee change');
    const when = card.getByTestId('notice-effective');
    await expect(when).toHaveText(`Takes effect ${shown(next.effectiveAt)}`);
    await expect(when).toHaveAttribute('datetime', new Date(next.effectiveAt).toISOString());
    expect(Date.now()).toBeLessThan(Date.parse(next.effectiveAt));
  } finally {
    await a.close();
    await b.close();
    await restore('IFC/USDT back in the default pair group');
  }
});

test(`${J} #7 reads convert maintenance and limits: the state and per-asset maximums, "not set" where blank`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  // What a customer is told converts now, and each coin's limit: the room must read the same.
  const who = await fundedTrader(page, 'js17cv', '10');
  const pairs = (await (await api(who)).get('/api/trade/trpc/convert.pairs')).body.result.data;
  expect(pairs.assets.length).toBeGreaterThan(0);
  const a = await room(browser, 'a');
  try {
    const convert = a.page.locator('[data-fees=convert]');
    await expect(convert.locator('[data-convert=state]')).toHaveText(
      pairs.paused ? 'Convert is paused for maintenance: every quote refuses trade.convert_disabled.' : 'Convert is open.',
    );
    for (const { asset, maxPerConvert } of pairs.assets) {
      await expect(convert.locator(`tr[data-asset="${asset}"] td`)).toHaveText([
        asset,
        maxPerConvert ? `${maxPerConvert.amount} ${maxPerConvert.asset}` : 'not set',
      ]);
    }
    // The stack's TEST values, and the one it leaves blank.
    await expect(valueOf(convert, 'Spread on a quote')).toHaveText(rate(20));
    await expect(valueOf(convert, 'A quote holds for')).toHaveText('15000 ms');
    await expect(valueOf(convert, 'Size at the desk price, convert')).toHaveText('0.1 to 5');
    await expect(valueOf(convert, 'Size at the desk price, one-click buy')).toHaveText('not set');
  } finally {
    await a.close();
  }
});

test(`${J} #8 reads sell quotes and partner buy fees: a finance read of venue sell prices with exact amounts, and the partner's buy fees as the partner reports them, or "not known"`, async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  // A customer asks for a sell quote on Convert and a price to buy USDT with money, as the screens do.
  const who = await fundedTrader(page, 'js17q', '10');
  fund(who.email, 'BTC', '0.01');
  const client = await api(who);
  const asked = await client.get(
    `/api/trade/trpc/convert.quote?input=${encodeURIComponent(JSON.stringify({ symbol: 'BTC/USDT', side: 'sell', qty: '0.001' }))}`,
  );
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
  const quote = asked.body.result.data;
  const ways = await client.get(
    `/api/bank/trpc/addMoney.methods?input=${encodeURIComponent(JSON.stringify({ assetId: 'USDT', amount: '50', country: 'NL' }))}`,
  );
  expect(ways.status, JSON.stringify(ways.body).slice(0, 300)).toBe(200);
  const priced = ways.body.result.data.methods.filter((m) => m.quote);
  expect(priced.length, JSON.stringify(ways.body.result.data.methods).slice(0, 300)).toBeGreaterThan(0);

  // The TEST partner's ramp gives no fee (its `fee unknown` switch, this customer's only): every way it priced reads
  // "not known", never 0, and the buy the customer asks for anyway is refused bank.onramp_fee_not_known and kept refused.
  const way = priced[0].method;
  const unknown = await withPartner(who, { rampFee: 'unknown' }, async () => {
    const none = await client.get(
      `/api/bank/trpc/addMoney.methods?input=${encodeURIComponent(JSON.stringify({ assetId: 'USDT', amount: '20', country: 'NL' }))}`,
    );
    expect(none.status, JSON.stringify(none.body).slice(0, 300)).toBe(200);
    for (const m of none.body.result.data.methods.filter((x) => priced.some((p) => p.method === x.method))) {
      expect(m, JSON.stringify(m)).toMatchObject({ quote: null, blocker: 'bank.onramp_fee_not_known' });
    }
    const started = await client.post('/api/bank/trpc/addMoney.start', {
      requestId: randomUUID(), // a new ask, as the screen makes one
      assetId: 'USDT',
      amount: '20',
      method: way,
      country: 'NL',
    });
    expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
    return started.body.result.data;
  });
  expect(unknown, JSON.stringify(unknown)).toMatchObject({ status: 'refused', refusalCode: 'bank.onramp_fee_not_known', onramp: null });

  const a = await room(browser, 'a');
  try {
    // Each sell quote as it was given: what the customer sells and gets, the book price, and the spread kept, exactly.
    const sells = a.page.locator('[data-fees=quotes]');
    const row = sells.locator(`tr[data-quote="${quote.quoteId}"] td`);
    await expect(row.nth(0)).toHaveText(client.userId);
    await expect(row.nth(1)).toHaveText(`${quote.inAmount} ${quote.inAsset}`);
    await expect(row.nth(2)).toHaveText(`${quote.outAmount} ${quote.outAsset}`);
    await expect(row.nth(3)).toHaveText(quote.avgPrice);
    const spread = toUnits(quote.bookNotional) - toUnits(quote.userNotional);
    const spreadText = await row.nth(4).innerText();
    expect(spreadText).toMatch(new RegExp(` USDT \\(${quote.convertSpreadBps} bps\\)$`));
    expect(toUnits(spreadText.split(' ')[0])).toBe(spread);

    // Each fiat buy price with its fee, exactly as the bank gave it to the customer.
    const fiat = a.page.locator('[data-fees=fiat-buy]');
    for (const { quote: q } of priced) {
      await expect(fiat.locator(`tr[data-onramp-quote="${q.quoteId}"] td`)).toHaveText([
        client.userId,
        `${q.amount} ${q.assetId}`,
        q.method,
        `${q.payAmount} ${q.payCurrency}`,
        `${q.fee} ${q.payCurrency}`,
        q.rate,
      ]);
    }
    // The buy the partner gave no fee for: the customer and what they asked to buy, and its pay amount, fee and rate
    // "not known", never 0 and never a price; it is not among the priced fees.
    const notKnown = a.page.locator('[data-fees=fiat-buy-not-known]');
    await expect(notKnown.locator(`tr[data-onramp-request="${unknown.requestId}"] td`)).toHaveText([
      client.userId,
      `20 USDT`,
      way,
      'NL',
      'not known',
      'not known',
      'not known',
    ]);
    // The stack's partner is the TEST partner bank, and the list says so.
    await expect(notKnown).toContainText('TEST: the TEST partner bank stands in for a payment partner here.');
    await expect(fiat.locator(`tr[data-onramp-request="${unknown.requestId}"]`)).toHaveCount(0);
    // A read only: no control on any list.
    await expect(sells.locator('input, button, select')).toHaveCount(0);
    await expect(fiat.locator('input, button, select')).toHaveCount(0);
    await expect(notKnown.locator('input, button, select')).toHaveCount(0);
  } finally {
    await a.close();
  }
});
