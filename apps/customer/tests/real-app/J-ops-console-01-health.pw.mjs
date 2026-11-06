import { expect, test } from './journey.mjs';
import path from 'node:path';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ROOT, tool } from './stack.mjs';
import { approverSessions, makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';

// J-ops-console-01 #3: the module health board. Every platform module (packages/config MODULE_IDS) is its own row. A module
// with a source shows its volume, failures and oldest waiting item as svc-* read them; a module without one says "No source"
// with its blocker and shows no count. When one module's service cannot be read, only that row refuses: the test stops
// svc-p2p, reads the board again, and starts it again (`start --only p2p`, as J-agents-02 does).
//
// "As read": founder A reads the same svc-* procedures the board reads (svc-p2p ops.counts and disputes.backlog, svc-bank
// ops.transferHealth over 24 hours, svc-market ops.sales over 30 days, svc-mining-pool ops.shares), before and after the
// board loads, and each read row's volume, failures and oldest waiting item must be the figure those reads give. Other
// journeys write on the same stack, so when the counts move between the two reads the board is read again (up to 5 times).

const SOURCED = ['bank', 'p2p', 'market', 'mining-pool'];

/** The board on the page, after its heading shows. */
async function shown(page) {
  const b = page.getByTestId('health-board');
  await expect(b.getByRole('heading', { level: 1, name: 'Module health' })).toBeVisible();
  return b;
}

async function board(page) {
  await page.goto(`${ADMIN}/health`, { waitUntil: 'load' });
  return shown(page);
}

/** A module without a source: it names its blocker and code and shows no count. */
async function expectUnwired(b, module) {
  const row = b.getByTestId(`health-${module}`);
  await expect(row).toHaveAttribute('data-state', 'unwired');
  await expect(row).toContainText(/No source: \S/);
  await expect(row).toContainText('Code: ops.health_source_unwired');
  await expect(row.getByTestId('volume')).toHaveCount(0);
}

/** A read row: every figure cell is filled, and no "no source" or refusal text is on it. */
async function expectRead(b, module) {
  const row = b.getByTestId(`health-${module}`);
  await expect(row).toHaveAttribute('data-state', 'read');
  for (const cell of ['volume', 'failures', 'oldest']) await expect(row.getByTestId(cell)).not.toBeEmpty();
  await expect(row).not.toContainText('No source');
  await expect(row).not.toContainText('Could not read');
}

test('J-ops-console-01 #3 the module health board shows every module, read, refused on its own row, or no source with the blocker', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { MODULE_IDS } = await import(path.join(ROOT, 'packages/config/dist/modules.js'));
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/`);
  await page.getByRole('link', { name: /^Module health/ }).click();
  await expect(page).toHaveURL(/\/health$/);
  let b = await shown(page);

  // Every module is a row, and there is no row for anything else.
  await expect(b.locator('tbody tr')).toHaveCount(MODULE_IDS.length);
  for (const module of MODULE_IDS) await expect(b.getByTestId(`health-${module}`)).toHaveCount(1);
  // Each module with a source is read, with its figures; each without one names its blocker and shows no count.
  for (const module of SOURCED) await expectRead(b, module);
  const unwired = MODULE_IDS.filter((m) => !SOURCED.includes(m));
  for (const module of unwired) await expectUnwired(b, module);

  // svc-p2p down: only the P2P row refuses, naming svc-p2p, with its code and no count; every other row keeps its state.
  tool('local-test-stack.mjs', 'stop', 'p2p');
  let failure = null;
  try {
    b = await board(page);
    const p2p = b.getByTestId('health-p2p');
    await expect(p2p).toHaveAttribute('data-state', 'refused');
    await expect(p2p).toContainText('Could not read svc-p2p');
    await expect(p2p).not.toContainText('This part was not read.');
    await expect(p2p).toContainText('ops.health_source_unavailable');
    await expect(p2p.getByTestId('volume')).toHaveCount(0);
    for (const module of SOURCED.filter((m) => m !== 'p2p')) await expectRead(b, module);
    for (const module of unwired) await expectUnwired(b, module);
    await expect(b.locator('tbody tr')).toHaveCount(MODULE_IDS.length);
  } catch (error) {
    failure = error;
  }
  // Bring svc-p2p back for the journeys after this one. A failure to restart is reported, but never in place of the
  // board's own failure above.
  try {
    tool('local-test-stack.mjs', 'start', '--only', 'p2p');
  } catch (restart) {
    failure ??= restart;
  }
  if (failure) throw failure;
  b = await board(page);
  await expectRead(b, 'p2p');
});

const DAY_MS = 86_400_000;

/** A value at a dotted path, or undefined. */
const at = (source, dotted) => dotted.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), source);

/** A whole count the way the board takes one (an int, or a string of digits); anything else is null. */
function countOf(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}
const total = (values) => (values.some((v) => v === null) ? null : values.reduce((a, b) => a + b, 0n));

/** The console's duration words (apps/admin ops-desk formatDuration). */
function duration(seconds) {
  const s = Math.max(0, Math.trunc(seconds));
  const d = Math.trunc(s / 86_400);
  const h = Math.trunc((s % 86_400) / 3_600);
  const m = Math.trunc((s % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

/** Founder A's own reads of every source the board reads, straight from the services through Edge. */
async function serviceReads() {
  const ctx = await makeContext({ log: () => {} });
  const token = (await approverSessions(ctx)).a.token;
  const read = async (module, procedure, input) => {
    const res = await ctx.edge.query(module, procedure, input, token);
    const data = res.json?.result?.data;
    if (data === undefined) throw new Error(`${module} ${procedure} refused founder A: ${res.status} ${res.text.slice(0, 300)}`);
    return data;
  };
  const now = Date.now();
  const window = { from: new Date(now - 30 * DAY_MS).toISOString(), to: new Date(now).toISOString() };
  return {
    p2p: await read('p2p', 'ops.counts', undefined),
    backlog: await read('p2p', 'disputes.backlog', undefined),
    bank: await read('bank', 'ops.transferHealth', { windowHours: 24 }),
    market: await read('market', 'ops.sales', { limit: 50, ...window }),
    mining: await read('mining', 'ops.shares', {}),
  };
}

const TRADE_STATES = ['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed'];
const BANK_AGES = ['standingOrders', 'oneOff', 'bills'].map((k) => `${k}.oldestPendingAgeSeconds`);

/** Every count the board shows from these reads (not the ages, which grow with the clock). */
function counts(r) {
  const rows = (list, key) => total((list ?? []).map((row) => countOf(row[key])));
  return {
    p2pVolume: total(TRADE_STATES.map((s) => countOf(at(r.p2p, `trades.${s}`)))),
    p2pFailures: countOf(at(r.p2p, 'trades.disputed')),
    p2pOpen: countOf(r.backlog.open),
    p2pOverdue: countOf(r.backlog.overdue),
    bankVolume: total(['standingOrders.total', 'oneOff.total', 'bills.total'].map((k) => countOf(at(r.bank, k)))),
    bankFailures: total(['standingOrders.rejected', 'bills.failed', 'bills.returned'].map((k) => countOf(at(r.bank, k)))),
    bankPending: BANK_AGES.map((k) => at(r.bank, k) === null || at(r.bank, k) === undefined),
    marketVolume: rows(r.market.rows, 'settledCount'),
    marketFailures: countOf(r.market.refusedCount),
    marketPending: countOf(r.market.pendingCount),
    miningVolume: total([rows(r.mining.windows, 'acceptedCount'), rows(r.mining.windows, 'rejectedCount')]),
    miningFailures: rows(r.mining.windows, 'rejectedCount'),
  };
}

const same = (a, b) =>
  JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ===
  JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** A figure cell: its figure in bold, or "Not given"; its note under it. */
async function cell(row, key) {
  const c = row.getByTestId(key);
  const strong = c.locator('strong');
  return { value: (await strong.count()) > 0 ? (await strong.innerText()).trim() : null, text: (await c.innerText()).trim() };
}

test('J-ops-console-01 #3 each sourced row shows volume, failures and the oldest waiting item as svc-* read them', async ({ page }) => {
  test.setTimeout(240_000);
  await founderSignIn(page, 'a');
  let before;
  let after;
  let b;
  let seconds;
  for (let attempt = 1; ; attempt++) {
    before = await serviceReads();
    const t0 = Date.now();
    b = await board(page);
    seconds = (Date.now() - t0) / 1000;
    after = await serviceReads();
    if (same(counts(before), counts(after))) break;
    if (attempt === 5) throw new Error('the services kept changing between the two reads on 5 tries, so the board could not be compared');
  }
  const want = counts(after);
  for (const [name, value] of Object.entries(want))
    if (value === null) throw new Error(`founder A's own read gave no ${name}, so the board has nothing to match`);

  // P2P: trades all time, disputed trades, and no age (svc-p2p gives none), with the open and overdue disputes named.
  const p2p = b.getByTestId('health-p2p');
  expect((await cell(p2p, 'volume')).value).toBe(want.p2pVolume.toString());
  expect((await cell(p2p, 'failures')).value).toBe(want.p2pFailures.toString());
  const p2pOldest = await cell(p2p, 'oldest');
  expect(p2pOldest.value).toBeNull();
  expect(p2pOldest.text).toContain(`${want.p2pOpen} open now, ${want.p2pOverdue} overdue`);

  // Bank: the three transfer kinds in the last 24 hours, their failures, and the oldest still pending.
  const bank = b.getByTestId('health-bank');
  expect((await cell(bank, 'volume')).value).toBe(want.bankVolume.toString());
  expect((await cell(bank, 'failures')).value).toBe(want.bankFailures.toString());
  const bankOldest = await cell(bank, 'oldest');
  const ages = (r) =>
    BANK_AGES.map((k) => at(r.bank, k))
      .filter((v) => v !== null && v !== undefined)
      .map(Number);
  if (ages(after).length === 0) {
    expect(bankOldest.value).toBeNull();
    expect(bankOldest.text).toContain('nothing created in the last 24 hours is still pending');
  } else {
    // The age grows with the clock: the board read it between the two reads, so its words are one of those in between.
    const low = Math.trunc(Math.max(...ages(before)));
    const high = Math.ceil(Math.max(...ages(after)) + seconds);
    const words = new Set();
    for (let s = low; s <= high; s++) words.add(duration(s));
    expect([...words], `the board's oldest pending transfer, against svc-bank's ${low}..${high} s`).toContain(bankOldest.value);
  }

  // Market: settled and refused purchases in the last 30 days, and no age, with the pending count named.
  const market = b.getByTestId('health-market');
  expect((await cell(market, 'volume')).value).toBe(want.marketVolume.toString());
  expect((await cell(market, 'failures')).value).toBe(want.marketFailures.toString());
  const marketOldest = await cell(market, 'oldest');
  expect(marketOldest.value).toBeNull();
  expect(marketOldest.text).toContain(`${want.marketPending} pending now`);

  // Mining pool: shares submitted and refused, every window; it gives no age.
  const mining = b.getByTestId('health-mining-pool');
  expect((await cell(mining, 'volume')).value).toBe(want.miningVolume.toString());
  expect((await cell(mining, 'failures')).value).toBe(want.miningFailures.toString());
  expect((await cell(mining, 'oldest')).value).toBeNull();
});
