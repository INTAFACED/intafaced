// World: book, gates
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { awayBid, fundedTrader } from './desk.mjs';
import { ORIGIN, api, journeyState } from './stack.mjs';

// J-cex-spot-17, in the running app (docs/roadmap/journeys.json): two finance operators publish and version fees, VIP
// tiers and convert limits on the founder console. One test per step, titled "J-cex-spot-17 #<n>", run in order, each
// checking what the step's words in project-state modules/cex-spot/acceptance/journeys.md say the operator sees.
//
// The operators are the stack's two LOCAL TEST founders (A and B) on the trade operator desk (/trade-ops). The fee room
// is found the way an operator finds it, by its name in the desk's room switcher. svc-trade's own operator read
// (`admin.fees.get`: the current version and every stored version) is the truth each screen is compared with.
//
// Rates never change for any other journey: every version this file writes carries the current version's rates
// unchanged. #4's TEST tier programme is put back to the schedule it found before the step ends.
const J = 'J-cex-spot-17';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** How long a check waits for a console room or control that may not be built yet: an unbuilt room fails fast. */
const ROOM_WAIT = 15_000;

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (s[k] === undefined) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** The stack's two TEST operators through svc-trade's own doors, signed in once for the file. */
let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/** svc-trade's operator fee read: `{ version, history: [{ version, schedule, effectiveAt, operatorId, approverId, reason }] }`. */
async function feesRead() {
  const { ctx, sessions } = await ops();
  const res = await ctx.edge.query('trade', 'admin.fees.get', undefined, await sessions.a.tradeOpsToken());
  const view = res.json?.result?.data;
  if (typeof view?.version !== 'string' || !Array.isArray(view.history))
    throw new Error(`trade admin.fees.get refused (${res.status}): ${res.text?.slice(0, 300)}`);
  return view;
}

/** The stored version row `version` of a read. */
const versionRow = (view, version) => view.history.find((h) => h.version === version);

/** The schedule of the version svc-trade holds now. */
async function currentSchedule() {
  const view = await feesRead();
  const row = versionRow(view, view.version);
  if (!row) throw new Error(`${J}: admin.fees.get names version ${view.version} but stores no row for it`);
  return row.schedule;
}

/** `bps` as an exact percent: "8" → "0.08%", "10" → "0.10%", "125" → "1.25%". */
const pct = (bps) => {
  const n = Number(bps);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}%`;
};

/** A version as an operator reads it: "v3" or "Version 3". */
const versionName = (v) => new RegExp(`\\b(?:v|version\\s*)${v}\\b`, 'i');

/** An instant to the minute, as a screen may write it: "2026-11-06T10:01" or "2026-11-06 10:01". */
const minuteOf = (iso) => {
  const s = new Date(iso).toISOString();
  return new RegExp(`${s.slice(0, 10)}[T ]${s.slice(11, 16)}`);
};

/** The regular-tier row of the schedule's default pair group: the rates every ordinary order is charged. */
function defaultRow(schedule) {
  const group = schedule.defaultPairGroup;
  const row = (schedule.rows ?? []).find((r) => r.pairGroup === group && r.tierId === 'regular');
  if (!row) throw new Error(`${J}: the current schedule has no regular row for its default group ${group}`);
  return row;
}

/** A typed refusal code, as the console names one: `fee.taker_blank`, `fee_schedule.rate_missing`. */
const TYPED_CODE = /\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/;

/** Founder `key` signed in to the console on a browser context of their own. */
async function consoleAs(browser, key) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const who = await founderSignIn(page, key);
  return { page, who, context };
}

/** The fee room, reached the way an operator reaches it: the desk's room switcher, then the room's name. */
async function feesRoom(page) {
  await page.goto(`${ADMIN}/trade-ops`);
  const nav = page.getByRole('navigation', { name: 'Trade operator rooms' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: /^Fees\b/ }).click({ timeout: ROOM_WAIT });
  await expect(page.getByRole('heading', { level: 1, name: /Fees/ })).toBeVisible({ timeout: ROOM_WAIT });
}

/** The fee versions of one pair group, as the room lists them. */
async function versionsOf(page, group) {
  await page.getByLabel('Pair group').selectOption(group, { timeout: ROOM_WAIT });
  return page.getByRole('table', { name: /Fee versions/ });
}

/** Every write the page sends while `act` runs (a server action is a POST to the console). */
async function writesDuring(page, act) {
  const sent = [];
  const watch = (req) => req.method() !== 'GET' && req.method() !== 'HEAD' && sent.push(`${req.method()} ${req.url()}`);
  page.on('request', watch);
  try {
    await act();
    // A refusal in the browser answers at once; anything sent would have left within this.
    await page.waitForTimeout(2_000);
  } finally {
    page.off('request', watch);
  }
  return sent;
}

/** Write `schedule` as the next version through svc-trade's two-person door, effective in ten seconds. */
async function writeVersion(schedule, reason) {
  const { ctx, sessions } = await ops();
  return setFeeSchedule(ctx, schedule, { effectiveAt: Date.now() + 10_000, reason: `LOCAL TEST ${J}: ${reason}`, sessions });
}

test(`${J} #1 opens fee versions by pair group: current and previous versions with effective times, exact rates`, async ({ browser }) => {
  test.setTimeout(180_000);
  run.reset({});
  // The console "has the current published fee version". A previous one is made by writing the current schedule again,
  // unchanged, as a new TEST version: no rate moves for any order.
  let view = await feesRead();
  if (view.history.length < 2) {
    const current = versionRow(view, view.version);
    if (!current) throw new Error(`${J}: admin.fees.get names version ${view.version} but stores no row for it`);
    await writeVersion(current.schedule, 'a previous version to read (rates unchanged)');
    await expect.poll(async () => (await feesRead()).history.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    view = await feesRead();
  }
  const ordered = [...view.history].sort((x, y) => Number(y.version) - Number(x.version));
  const [current, previous] = ordered;
  const group = current.schedule.defaultPairGroup;

  const { page, context } = await consoleAs(browser, 'a');
  await feesRoom(page);
  const table = await versionsOf(page, group);
  await expect(table).toBeVisible({ timeout: ROOM_WAIT });
  for (const [row, label] of [
    [current, /current/i],
    [previous, /previous|superseded|replaced/i],
  ]) {
    const line = table.getByRole('row').filter({ hasText: versionName(row.version) });
    await expect(line, `version ${row.version} is listed for ${group}`).toHaveCount(1);
    await expect(line).toContainText(label);
    // Its effective time, to the minute.
    await expect(line).toContainText(minuteOf(row.effectiveAt));
    // Its exact rates for the group's regular tier: "0.08%", never "0.1%" or a rounded figure.
    const rates = defaultRow(row.schedule);
    await expect(line).toContainText(pct(rates.makerBps));
    await expect(line).toContainText(pct(rates.takerBps));
  }
  run.write({ group, version: current.version });
  await context.close();
});

test(`${J} #2 proposes a new version with a blank taker fee: refused with a typed code; nothing sent`, async ({ browser }) => {
  const { group, version } = state('group', 'version');
  const before = await feesRead();
  const rates = defaultRow(versionRow(before, before.version).schedule);

  const { page, context } = await consoleAs(browser, 'a');
  await feesRoom(page);
  await page.getByRole('button', { name: /^Propose a new version/ }).click({ timeout: ROOM_WAIT });
  const form = page.getByRole('form', { name: /new fee version/i });
  await expect(form).toBeVisible({ timeout: ROOM_WAIT });
  await form.getByLabel('Pair group').selectOption(group);
  await form.getByLabel(/^Maker fee/).fill(pct(rates.makerBps).replace('%', ''));
  await form.getByLabel(/^Taker fee/).fill('');

  const sent = await writesDuring(page, () => form.getByRole('button', { name: /^Propose/ }).click());
  // Refused, in words, with its typed code.
  const refusal = form.getByRole('alert');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText(/taker/i);
  await expect(refusal).toContainText(TYPED_CODE);
  // Nothing sent: no write left the console, and svc-trade holds the same version it held.
  expect(sent, 'the refused proposal sent nothing').toEqual([]);
  const after = await feesRead();
  expect(after.version).toBe(before.version);
  expect(after.history.length).toBe(before.history.length);
  expect(after.version).toBe(version);
  await context.close();
});

test(`${J} #3 proposes a complete version; a second operator approves: written with an effective time; an open order keeps its placement version`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { group, version } = state('group', 'version');
  const before = await feesRead();
  const placed = versionRow(before, before.version);
  const rates = defaultRow(placed.schedule);

  // A's room first: an unbuilt room fails here, before a customer is made.
  const a = await consoleAs(browser, 'a');
  await feesRoom(a.page);
  await a.page.getByRole('button', { name: /^Propose a new version/ }).click({ timeout: ROOM_WAIT });
  const form = a.page.getByRole('form', { name: /new fee version/i });
  await expect(form).toBeVisible({ timeout: ROOM_WAIT });

  // A customer's order rests under the version in force now (far below the book, so nothing fills it).
  const customer = await browser.newContext({ baseURL: ORIGIN });
  const who = await fundedTrader(await customer.newPage(), 'jcs17', '100');
  await customer.close();
  const price = await awayBid(90);
  const me = await api(who);
  const order = await me.post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: '0.0001',
    price,
    clientOrderId: `jcs17-open-${Date.now().toString(36)}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  const orderId = order.body.id;
  expect(orderId).toBeTruthy();

  // A proposes the complete version: the same rates, a stated effective time two minutes ahead, a reason.
  const effectiveAt = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000);
  await form.getByLabel('Pair group').selectOption(group);
  await form.getByLabel(/^Maker fee/).fill(pct(rates.makerBps).replace('%', ''));
  await form.getByLabel(/^Taker fee/).fill(pct(rates.takerBps).replace('%', ''));
  await form.getByLabel(/^Effective/).fill(effectiveAt.toISOString().slice(0, 16));
  await form.getByLabel(/^Reason/).fill(`LOCAL TEST ${J} #3: a complete version, rates unchanged`);
  await form.getByRole('button', { name: /^Propose/ }).click();
  await expect(a.page.getByRole('status').filter({ hasText: /waiting for a second (operator|founder)/i })).toBeVisible();
  // Proposed is not written.
  expect((await feesRead()).version).toBe(before.version);

  // B, on their own console, approves the same proposal.
  const b = await consoleAs(browser, 'b');
  await feesRoom(b.page);
  const pending = b.page.getByRole('region', { name: /Proposed fee version/i });
  await expect(pending).toContainText(minuteOf(effectiveAt.toISOString()), { timeout: ROOM_WAIT });
  await pending.getByRole('button', { name: /^Approve/ }).click();

  // Written: svc-trade holds the next version, with that effective time, proposed by A and approved by B.
  await expect.poll(async () => (await feesRead()).history.length, { timeout: 30_000 }).toBe(before.history.length + 1);
  const after = await feesRead();
  const written = [...after.history].sort((x, y) => Number(y.version) - Number(x.version))[0];
  expect(Date.parse(written.effectiveAt)).toBe(effectiveAt.getTime());
  expect(written.operatorId).toBe(a.who.userId);
  expect(written.approverId).toBe(b.who.userId);
  // ...and A's room lists it with its effective time.
  await a.page.reload();
  const table = await versionsOf(a.page, group);
  const line = table.getByRole('row').filter({ hasText: versionName(written.version) });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText(minuteOf(written.effectiveAt));

  // The open order keeps the version it was placed under, as the operator reads it.
  await a.page.goto(`${ADMIN}/trade-ops/orders/${encodeURIComponent(orderId)}`);
  const feeVersion = a.page.getByText(/^Fee version/).locator('..');
  await expect(feeVersion).toContainText(versionName(placed.version), { timeout: ROOM_WAIT });
  await expect(feeVersion).not.toContainText(versionName(written.version));
  run.write({ version: written.version, orderId, previous: version });
  await a.context.close();
  await b.context.close();
});

test(`${J} #4 edits VIP thresholds and the snapshot time: the same proposal and approval path; the snapshot row shows figures`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  state('group');
  // A's room first: an unbuilt room fails here, before any TEST tier programme is written.
  const a = await consoleAs(browser, 'a');
  await feesRoom(a.page);
  const vip = a.page.getByRole('region', { name: /VIP tiers/i });
  await expect(vip).toBeVisible({ timeout: ROOM_WAIT });

  const found = await currentSchedule();
  try {
    // A TEST tier programme to edit, written through the door: the regular rows for a TEST tier, a TEST threshold.
    const base = (found.rows ?? []).filter((r) => r.tierId === 'regular');
    const programme = {
      ...found,
      rows: [...(found.rows ?? []), ...base.map((r) => ({ ...r, tierId: 'test-vip-17' }))],
      tierProgram: {
        thresholds: [{ tierId: 'test-vip-17', minVolume30d: '1000' }],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: '00:00',
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
      },
    };
    await writeVersion(programme, '#4 a TEST tier programme to edit');
    await expect.poll(async () => (await currentSchedule()).tierProgram?.snapshotTimeUtc, { timeout: 30_000 }).toBe('00:00');
    const proposedFrom = (await feesRead()).version;

    // A edits the threshold and the snapshot time and proposes.
    await a.page.reload();
    await vip.getByRole('button', { name: /^Propose a change/ }).click();
    await vip.getByLabel(/test-vip-17.*threshold|threshold.*test-vip-17/i).fill('2500');
    await vip.getByLabel(/^Snapshot time/).fill('01:30');
    await vip.getByLabel(/^Reason/).fill(`LOCAL TEST ${J} #4: TEST threshold and snapshot time`);
    await vip.getByRole('button', { name: /^Propose/ }).click();
    await expect(a.page.getByRole('status').filter({ hasText: /waiting for a second (operator|founder)/i })).toBeVisible();
    expect((await feesRead()).version).toBe(proposedFrom);

    // B approves on their own console, the same path as a fee version.
    const b = await consoleAs(browser, 'b');
    await feesRoom(b.page);
    const pending = b.page.getByRole('region', { name: /Proposed (VIP|fee version)/i });
    await expect(pending).toContainText('2500');
    await pending.getByRole('button', { name: /^Approve/ }).click();
    await expect.poll(async () => (await currentSchedule()).tierProgram?.snapshotTimeUtc, { timeout: 30_000 }).toBe('01:30');
    const program = (await currentSchedule()).tierProgram;
    expect(program.thresholds.find((t) => t.tierId === 'test-vip-17')?.minVolume30d).toBe('2500');
    await b.context.close();

    // The snapshot row shows figures: the snapshot time and each tier's threshold, as numbers, never a dash.
    await a.page.reload();
    const snapshot = vip.getByRole('row').filter({ hasText: /snapshot/i });
    await expect(snapshot).toContainText('01:30');
    await expect(vip.getByRole('row').filter({ hasText: 'test-vip-17' })).toContainText(/2,?500/);
    await expect(snapshot).toContainText(/\d/);
    await expect(snapshot).not.toContainText(/^\s*[—-]\s*$/);
  } finally {
    // Put the schedule this step found back, so no other journey meets the TEST tier programme.
    const now = await currentSchedule();
    if (JSON.stringify(now) !== JSON.stringify(found)) await writeVersion(found, '#4 the schedule put back');
    await a.context.close();
  }
});

test(`${J} #5 reads maker rebate tiers: a read-only list with the owner values`, async ({ browser }) => {
  state('group');
  const schedule = await currentSchedule();
  const rebates = (schedule.rows ?? []).filter((r) => r.makerRebateBps !== undefined && r.makerRebateBps !== null);

  const { page, context } = await consoleAs(browser, 'a');
  await feesRoom(page);
  const list = page.getByRole('region', { name: /Maker rebate tiers/i });
  await expect(list).toBeVisible({ timeout: ROOM_WAIT });
  // Read-only: nothing on it can be typed into or saved.
  await expect(list.getByRole('textbox')).toHaveCount(0);
  await expect(list.getByRole('spinbutton')).toHaveCount(0);
  await expect(list.getByRole('combobox')).toHaveCount(0);
  await expect(list.getByRole('button', { name: /save|propose|edit|change/i })).toHaveCount(0);
  // The owner values as stored: each rebate tier with its exact rate, or "not set" where the owner set none.
  if (rebates.length === 0) await expect(list).toContainText(/not set/i);
  for (const r of rebates) {
    const line = list.getByRole('row').filter({ hasText: r.pairGroup }).filter({ hasText: r.tierId });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(pct(r.makerRebateBps));
  }
  await context.close();
});

test(`${J} #6 publishes a fee-change notice: the customer notice and its effective time`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { version, group } = state('version', 'group');
  const written = versionRow(await feesRead(), version);
  if (!written) throw new Error(`${J}: version ${version} from #3 is not stored`);
  const title = `LOCAL TEST ${J} fee change v${version} ${Date.now().toString(36)}`;

  // A drafts the notice from the version it announces; B approves; A publishes.
  const a = await consoleAs(browser, 'a');
  await feesRoom(a.page);
  const line = (await versionsOf(a.page, group)).getByRole('row').filter({ hasText: versionName(version) });
  await line.getByRole('button', { name: /fee-change notice/i }).click({ timeout: ROOM_WAIT });
  const draft = a.page.getByRole('form', { name: /fee-change notice/i });
  await draft.getByLabel('Title').fill(title);
  await draft.getByLabel('Message').fill(`LOCAL TEST: the fee schedule moves to version ${version}.`);
  // The notice takes its effective time from the version, never a typed one.
  await expect(draft).toContainText(minuteOf(written.effectiveAt));
  await draft.getByRole('button', { name: /^Save draft|^Propose/ }).click();
  const b = await consoleAs(browser, 'b');
  await feesRoom(b.page);
  await b.page
    .getByRole('region', { name: /fee-change notice/i })
    .filter({ hasText: title })
    .getByRole('button', { name: /^Approve/ })
    .click();
  await b.context.close();
  await a.page.reload();
  await a.page
    .getByRole('region', { name: /fee-change notice/i })
    .filter({ hasText: title })
    .getByRole('button', { name: /^Publish/ })
    .click();

  // The customer reads it on the public notice board: a fee change, with the version's effective time.
  const customer = await browser.newContext({ baseURL: ORIGIN });
  const page = await customer.newPage();
  await page.goto('/notice');
  const card = page.locator('article[data-kind="fee_change"]').filter({ hasText: title });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  const effective = card.getByTestId('notice-effective');
  await expect(effective).toBeVisible();
  expect(Date.parse(await effective.getAttribute('datetime'))).toBe(Date.parse(written.effectiveAt));
  await customer.close();
  await a.context.close();
});

test(`${J} #7 reads convert maintenance and limits: the state and per-asset maximums, "not set" where blank`, async ({ browser }) => {
  state('group');
  // What the service says, read as a customer would: the convert state and each coin's per-conversion maximum.
  const customer = await browser.newContext({ baseURL: ORIGIN });
  const who = await fundedTrader(await customer.newPage(), 'jcs17c', '10');
  await customer.close();
  const pairs = await (await api(who)).get('/api/trade/trpc/convert.pairs');
  expect(pairs.status, JSON.stringify(pairs.body).slice(0, 300)).toBe(200);
  const { assets, paused } = pairs.body.result.data;
  expect(assets.length).toBeGreaterThan(0);

  const { page, context } = await consoleAs(browser, 'a');
  await feesRoom(page);
  const convert = page.getByRole('region', { name: /^Convert/i });
  await expect(convert).toBeVisible({ timeout: ROOM_WAIT });
  // The state: maintenance (paused) or open, as svc-trade holds it.
  await expect(convert.getByTestId('convert-state')).toHaveText(paused ? /paused|maintenance/i : /open|on/i);
  // Each asset's maximum per conversion, exact, or "not set" where the owner left it blank.
  for (const a of assets) {
    const line = convert.getByRole('row').filter({ has: page.getByRole('cell', { name: a.asset, exact: true }) });
    await expect(line, `${a.asset} has a row`).toHaveCount(1);
    if (a.maxPerConvert === null) await expect(line).toContainText(/not set/i);
    else {
      await expect(line).toContainText(new RegExp(a.maxPerConvert.amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',?')));
      await expect(line).toContainText(a.maxPerConvert.asset);
    }
  }
  await context.close();
});

test(`${J} #8 reads sell quotes and fiat buy fees: a finance read of quotes and fees with exact amounts`, async ({ browser }) => {
  state('group');
  // A customer asks for a sell quote (BTC for USDT). A quote holds nothing.
  const customer = await browser.newContext({ baseURL: ORIGIN });
  const who = await fundedTrader(await customer.newPage(), 'jcs17q', '10');
  await customer.close();
  const quote = await (await api(who)).post('/api/v1/convert/quote', { from: 'BTC', to: 'USDT', amount: '0.0001' });
  expect(quote.status, JSON.stringify(quote.body).slice(0, 300)).toBe(200);
  const amounts = Object.entries(quote.body).filter(([k, v]) => /amount|price|fee/i.test(k) && typeof v === 'string' && /^\d/.test(v));
  expect(amounts.length, `the quote carries amounts: ${JSON.stringify(quote.body).slice(0, 300)}`).toBeGreaterThan(0);

  const { page, context } = await consoleAs(browser, 'a');
  await feesRoom(page);
  // The finance read of sell quotes: this quote, with its exact amounts as the service gave them.
  const quotes = page.getByRole('region', { name: /Sell quotes/i });
  await expect(quotes).toBeVisible({ timeout: ROOM_WAIT });
  const line = quotes.getByRole('row').filter({ hasText: quote.body.quoteId });
  await expect(line).toHaveCount(1);
  for (const [key, value] of amounts) await expect(line, `${key} ${value}`).toContainText(value);
  // The fiat buy fees: card and bank payment, each with its exact fee, or "not set" where the owner left it blank.
  const fees = page.getByRole('region', { name: /Fiat buy fees/i });
  await expect(fees).toBeVisible();
  for (const method of [/card/i, /bank/i]) {
    const row = fees.getByRole('row').filter({ hasText: method });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s+[A-Z]{3,5}|not set/i);
  }
  await context.close();
});
