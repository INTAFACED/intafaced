// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import { doorCalls, ledgerUntouched, ledgerView } from './venue-door.mjs';
import { TEST_VENUE, TEST_VENUE_B, continueInWallet, otherTraderKey, testVenueAt, venueForThisFile, venueRecord } from './venue.mjs';

// J-derivatives-05, "I run my positions room", on the person's own venue accounts (the launch money model: each venue
// holds the positions and their margin, the ledger posts nothing), in the running app against the stack's two TEST venue
// simulators (LOCAL_STACK_USER_VENUE=two, as J-derivatives-28). One test per step, titled "J-derivatives-05 #<n>", run in
// order on one TEST account. The two venues differ where #3 and #7 need them to: the first, as the venue it stands for,
// holds one net position per contract and moves no position between accounts; the second offers hedge mode and moves a
// position (tooling/scripts/local-test-venue.mjs).
//
// The Starts line, made at the start of #1 straight on the TEST venues with the person's own key: positions in two
// products on two venues (a BTC-PERP perpetual and an XSTK-PERP stock perpetual on the first, a BTC-PERP short on the
// second). Every figure the page shows is checked against the TEST venue's own record, read straight from the venue,
// never through our door; the ledger is read before and after to show it posts nothing. Every figure is TEST.
const J = 'J-derivatives-05';
const ROOM = '/trade/positions';
const BTC = 'BTC-PERP';
const STOCK = 'XSTK-PERP';
const FUNDS = '5000';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test, 'two');

// ── the two TEST venues, read and signed on directly ──

const bases = { a: TEST_VENUE, b: TEST_VENUE_B };
async function at(base, path, body) {
  const { status, body: out } = await testVenueAt(base, path, body);
  expect(status, `${path}: ${JSON.stringify(out).slice(0, 300)}`).toBe(200);
  return out;
}
async function venuesNow() {
  const out = {};
  for (const [k, base] of Object.entries(bases)) {
    const v = await at(base, '/venue');
    expect(v.label).toBe('TEST');
    out[k] = {
      id: v.venue.id,
      name: v.venue.displayName,
      base,
      positionModes: v.venue.positionModes,
      positionMoves: v.venue.positionMoves === true,
    };
  }
  return out;
}
const accountOn = (venue, owner, subAccount = null) => ({ venueId: venue.id, owner, subAccount });
/** The venue's own record for one account (`/positions`, `/balances`, `/fills`, `/position-mode`, ...), read straight from it. */
const record = async (venue, owner, path, extra = {}, subAccount = null) =>
  (await venueRecord(owner, path, extra, venue.base, subAccount)).value;
/** The venue's own answer to an action it won't take: sent straight to its prepare, which refuses in its words. Nothing is signed. */
async function venueRefuses(venue, owner, intent) {
  const { status, body } = await testVenueAt(venue.base, '/prepare', {
    account: accountOn(venue, owner),
    signer: { role: 'owner', address: owner },
    intent,
  });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(422);
  return body.refusal;
}
const positionsOn = (venue, owner, subAccount = null) => record(venue, owner, '/positions', {}, subAccount);
const usdcOn = async (venue, owner, subAccount = null) =>
  (await record(venue, owner, '/balances', {}, subAccount)).find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };

/** One action signed by `key` as the owner and sent to the TEST venue itself (setup, never a step's own action). */
async function signedOn(venue, key, intent, subAccount = null) {
  const owner = key.address.toLowerCase();
  const prepared = await at(venue.base, '/prepare', {
    account: accountOn(venue, owner, subAccount),
    signer: { role: 'owner', address: owner },
    intent,
  });
  const t = prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await at(venue.base, '/submit', { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } });
  expect(sent, JSON.stringify(sent).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent;
}
const leverage = (symbol, times) => ({ kind: 'update_leverage', symbol, leverageBps: times * 10_000, marginMode: 'isolated' });
const take = (symbol, side, amount, price, key) => ({
  kind: 'place_order',
  symbol,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: key,
  builderFee: null,
});
const fund = (venue, owner, amount, subAccount = null) =>
  at(venue.base, '/test/deposit', {
    account: accountOn(venue, owner, subAccount),
    asset: 'USDC',
    amount,
    depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
  });

// ── the person and the page ──

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  const key = privateKeyToAccount(s.walletKey);
  return { ...s, key, owner: key.address.toLowerCase() };
}
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** Signs in, installs the TEST wallet with this run's key on the first venue's chain, opens `path` and connects. */
async function openRoom(page, s, path = ROOM) {
  const { chainId } = await at(TEST_VENUE, '/venue');
  const wallet = await installTestWallet(page, { chainId, privateKey: s.walletKey });
  await signIn(page, s.account);
  await page.goto(path);
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(s.owner);
  await expect(page.getByTestId('positions-all')).toBeVisible({ timeout: 30_000 });
  return wallet;
}

const cellText = async (row, name) => (await row.locator(`[data-cell="${name}"]`).innerText()).trim();
const same = (a, b) => toUnits(String(a).trim()) === toUnits(String(b).trim());
const sum = (values) => fromUnits(values.reduce((t, v) => t + toUnits(v), 0n));
const SCALE = 10n ** 18n;
const mulUnits = (a, b) => (toUnits(a) * toUnits(b)) / SCALE;

/** The positions table's rows on the page (the totals row aside), each with its venue, market and cells. */
async function shownRows(table) {
  const out = [];
  for (const row of await table.locator('tbody tr:not([data-row="total"])').all()) {
    const cells = {};
    for (const name of ['venue', 'product', 'market', 'side', 'size', 'entry', 'mark', 'notional', 'margin', 'unrealised', 'leverage'])
      cells[name] = await cellText(row, name);
    out.push({ venueId: await row.getAttribute('data-venue'), symbol: await row.getAttribute('data-symbol'), ...cells });
  }
  return out;
}

/** Each shown row equals the venue's own position, figure for figure; returns the venue rows. */
async function rowsMatchVenues(rows, v, owner) {
  const expected = [];
  for (const venue of [v.a, v.b]) for (const p of await positionsOn(venue, owner)) expected.push({ venue, p });
  expect(rows.map((r) => `${r.venueId}:${r.symbol}`).sort()).toEqual(expected.map((e) => `${e.venue.id}:${e.p.symbol}`).sort());
  for (const { venue, p } of expected) {
    const r = rows.find((x) => x.venueId === venue.id && x.symbol === p.symbol);
    expect(r.venue).toBe(venue.name);
    expect(r.side).toBe(p.side === 'long' ? 'Long' : 'Short');
    for (const [cell, figure] of [
      ['size', p.size],
      ['entry', p.entryPrice],
      ['mark', p.markPrice],
      ['margin', p.margin],
      ['unrealised', p.unrealisedPnl],
    ])
      expect(same(r[cell], figure), `${venue.id} ${p.symbol} ${cell}: ${r[cell]} vs ${figure}`).toBe(true);
    expect(same(r.notional, fromUnits(mulUnits(p.size, p.markPrice)))).toBe(true);
  }
  return expected;
}

/** The totals row equals the sum of the rows above it, column by column. */
async function totalsAddUp(table, rows) {
  const total = table.locator('tbody tr[data-row="total"]');
  await expect(total).toContainText(`Total (${rows.length} positions)`);
  for (const name of ['notional', 'margin', 'unrealised'])
    expect(same(await cellText(total, name), sum(rows.map((r) => r[name]))), `total ${name}`).toBe(true);
}

/** TEST setup, not a step (the Starts line): a verified account, its wallet, TEST USDC on both venues and three positions. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jd5');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const v = await venuesNow();
    expect(v.a.id).not.toBe(v.b.id);
    const tag = randomBytes(4).toString('hex');
    for (const venue of [v.a, v.b]) await fund(venue, owner, FUNDS);
    // A long of 0.03 BTC-PERP and a long of 2 XSTK-PERP (the stock perpetual, at 2x, inside any off-hours band) on the
    // first venue; a short of 0.02 BTC-PERP on the second. Each takes the TEST makers' ladder there.
    await signedOn(v.a, key, leverage(BTC, 10));
    await signedOn(v.a, key, leverage(STOCK, 2));
    await signedOn(v.b, key, leverage(BTC, 10));
    await signedOn(v.a, key, take(BTC, 'buy', '0.03', '60100', `order:jd5:${tag}:a-btc`));
    await signedOn(v.a, key, take(STOCK, 'buy', '2', '201', `order:jd5:${tag}:a-stock`));
    await signedOn(v.b, key, take(BTC, 'sell', '0.02', '59900', `order:jd5:${tag}:b-btc`));
    expect((await positionsOn(v.a, owner)).map((p) => p.symbol).sort()).toEqual([BTC, STOCK]);
    expect((await positionsOn(v.b, owner)).map((p) => `${p.symbol}:${p.side}`)).toEqual([`${BTC}:short`]);
    run.reset({ account, walletKey, tag, startedAt: new Date(Date.now() - 60_000).toISOString(), ledger: await ledgerView(account) });
  } finally {
    await page.close();
  }
}

test(`${J} #1 opens /trade/positions: positions on every connected venue with product tags and the venue named; totals equal the sum of rows`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const v = await venuesNow();
  await openRoom(page, s);
  const table = page.getByTestId('positions-all');
  await expect(table.locator('tbody tr:not([data-row="total"])')).toHaveCount(3, { timeout: 30_000 });
  // Every row is the venue's own position, the venue named; the page and the venues are read until they agree (a mark
  // may move between two reads).
  let rows = [];
  await expect(async () => {
    rows = await shownRows(table);
    await rowsMatchVenues(rows, v, s.owner);
  }).toPass({ timeout: 30_000 });
  // Product tags from each market's own listing (read apart from the positions, "Reading the venue's listing…" until
  // then): a perpetual and a stock perpetual.
  const tag = (venue, symbol) => table.locator(`tr[data-venue="${venue.id}"][data-symbol="${symbol}"] [data-cell="product"]`);
  await expect(tag(v.a, BTC)).toHaveText('Perpetual');
  await expect(tag(v.a, STOCK)).toHaveText('Stock perpetual');
  await expect(tag(v.b, BTC)).toHaveText('Perpetual');
  expect(new Set(rows.map((r) => r.venue))).toEqual(new Set([v.a.name, v.b.name]));
  await expect(async () => {
    await totalsAddUp(table, await shownRows(table));
  }).toPass({ timeout: 20_000 });
  await ledgerUntouched(s);
});

test(`${J} #2 opens a position's details: entry, break-even adjusted by fees to the last digit, mark, margin ratio and the P&L formula used`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await venuesNow();
  await openRoom(page, s);
  const table = page.getByTestId('positions-all');
  for (const [venue, symbol] of [
    [v.a, BTC],
    [v.b, BTC],
  ]) {
    await table
      .locator(`tr[data-venue="${venue.id}"][data-symbol="${symbol}"]`)
      .getByRole('button', { name: 'Details', exact: true })
      .click();
    const detail = page.getByTestId('position-detail');
    await expect(detail).toContainText(`${symbol} on ${venue.name}`);
    const line = (name) => detail.locator(`[data-line="${name}"]`);
    const value = async (name) => (await detail.locator(`[data-value="${name}"]`).innerText()).trim();
    await expect(async () => {
      const [p] = (await positionsOn(venue, s.owner)).filter((x) => x.symbol === symbol);
      // The opening fees, from the venue's own fills on this market since the position opened: its fee and our builder fee.
      const fills = (await record(venue, s.owner, '/fills', { since: s.startedAt })).filter((f) => f.symbol === symbol);
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.every((f) => f.realisedPnl === null)).toBe(true);
      const fees = fills.reduce((t, f) => t + toUnits(f.venueFee) + toUnits(f.builderFee), 0n);
      expect(fees).toBeGreaterThan(0n);
      const perUnit = (fees * SCALE + toUnits(p.size) / 2n) / toUnits(p.size);
      const be = fromUnits(p.side === 'long' ? toUnits(p.entryPrice) + perUnit : toUnits(p.entryPrice) - perUnit);
      expect(same((await line('entry').innerText()).trim(), p.entryPrice)).toBe(true);
      // Break-even to the last digit: the exact decimal, never rounded to the tick.
      expect(await value('break-even')).toBe(be);
      expect(await line('break-even-rule').innerText()).toContain(
        `Entry ${p.side === 'long' ? '+' : '−'} opening fees ${fromUnits(fees)} ÷ size`,
      );
      expect(same((await line('mark').innerText()).trim(), p.markPrice)).toBe(true);
      // The margin ratio: the venue's maintenance margin over margin plus unrealised P&L, in percent to two places.
      expect(p.maintenanceMargin.known).toBe(true);
      const equity = toUnits(p.margin) + toUnits(p.unrealisedPnl);
      const ratio = (toUnits(p.maintenanceMargin.value) * 100n * SCALE) / equity;
      const pct = `${ratio / SCALE}.${String((ratio % SCALE) / 10n ** 16n).padStart(2, '0')}`;
      expect(await value('margin-ratio')).toBe(`${pct}%`);
      expect(await line('margin-ratio-rule').innerText()).toContain(`Maintenance margin ${p.maintenanceMargin.value}`);
      // The P&L formula used, with this position's own numbers, and the venue's unrealised P&L as its result.
      expect(same(await value('pnl'), p.unrealisedPnl)).toBe(true);
      const formula = (await line('pnl-formula').innerText()).trim();
      expect(formula).toBe(
        p.side === 'long'
          ? `(mark ${p.markPrice} − entry ${p.entryPrice}) × size ${p.size} = ${p.unrealisedPnl}`
          : `(entry ${p.entryPrice} − mark ${p.markPrice}) × size ${p.size} = ${p.unrealisedPnl}`,
      );
    }).toPass({ timeout: 30_000 });
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(detail).toHaveCount(0);
  }
  await ledgerUntouched(s);
});

test(`${J} #3 chooses hedge or one-way mode: offered only where the venue offers it; otherwise listed with the reason; a switch the venue refuses with an open position shows the venue's reason`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await venuesNow();
  const wallet = await openRoom(page, s);
  const door = doorCalls(page);
  const modes = page.getByTestId('positions-modes');
  const modeOn = (venue, symbol) => record(venue, s.owner, '/position-mode', { symbol });
  const hedge = (symbol, name) => ({ kind: 'set_position_mode', symbol, mode: 'hedge', changeKey: `position-mode:jd5:${s.tag}:${name}` });
  // What each venue itself declares: the first one-way only, the second one-way and hedge.
  expect(v.a.positionModes).toEqual(['one_way']);
  expect(v.b.positionModes).toEqual(['one_way', 'hedge']);

  // The first venue: one-way in use, as its own record of the account says; hedge listed with the reason, and no switch
  // offered. The venue itself refuses the switch, so "not offered" is its answer, not ours.
  const listA = modes.locator(`dl[data-venue="${v.a.id}"]`);
  expect(await modeOn(v.a, BTC)).toBe('one_way');
  await expect(listA.locator('[data-mode="one_way"]')).toHaveText(`In use on ${v.a.name}`);
  await expect(listA.locator('[data-mode="hedge"]')).toHaveAttribute('data-offered', 'false');
  await expect(listA.locator('[data-mode="hedge"]')).toHaveText(
    `Not offered by ${v.a.name}: it holds one net position per contract, so a long and a short on the same contract can’t be held side by side.`,
  );
  await expect(modes.locator(`[data-testid="positions-mode-switch"][data-venue="${v.a.id}"]`)).toHaveCount(0);
  expect(await venueRefuses(v.a, s.owner, hedge(BTC, 'a-btc'))).toMatchObject({
    code: 'not_offered',
    detail: `${v.a.name} offers no hedge mode`,
  });

  // The second venue offers both, so the switch is offered there, and only there.
  const listB = modes.locator(`dl[data-venue="${v.b.id}"]`);
  await expect(listB.locator('[data-mode="one_way"]')).toHaveText(`Offered by ${v.b.name}`);
  await expect(listB.locator('[data-mode="hedge"]')).toHaveText(`Offered by ${v.b.name}`);
  await expect(modes.getByTestId('positions-mode-switch')).toHaveCount(1, { timeout: 30_000 });
  const sw = modes.locator(`[data-testid="positions-mode-switch"][data-venue="${v.b.id}"]`);
  const pick = sw.getByRole('combobox', { name: 'Perpetual', exact: true });
  const shown = sw.locator('[data-value="mode-now"]');
  const outcome = sw.getByTestId('venue-outcome');
  const choose = (symbol, mode) => sw.getByRole('button', { name: `Switch ${symbol} to ${mode}`, exact: true });

  // A perpetual with no position there: the person chooses hedge, signs once, and the venue's own record and the page
  // both say hedge; then one-way again, the same way. The mode shown is the venue's record each time.
  const open = await positionsOn(v.b, s.owner);
  expect(open.map((p) => p.symbol)).toEqual([BTC]);
  const FLAT = (await pick.locator('option').allInnerTexts()).map((x) => x.trim()).find((symbol) => symbol !== BTC);
  expect(FLAT, 'the second venue lists a perpetual the person holds no position on').toBeTruthy();
  await pick.selectOption(FLAT);
  expect(await modeOn(v.b, FLAT)).toBe('one_way');
  await expect(shown).toHaveText('One-way', { timeout: 20_000 });
  await expect(choose(FLAT, 'One-way')).toBeDisabled();
  for (const [label, mode] of [
    ['Hedge', 'hedge'],
    ['One-way', 'one_way'],
  ]) {
    const asked = signatures(wallet);
    await choose(FLAT, label).click();
    await continueInWallet(page);
    await expect(outcome).toHaveText('The venue accepted it.', { timeout: 20_000 });
    expect(signatures(wallet)).toBe(asked + 1);
    expect(await modeOn(v.b, FLAT)).toBe(mode);
    await expect(shown).toHaveText(label, { timeout: 20_000 });
    await expect(choose(FLAT, label)).toBeDisabled();
  }
  const sent = door.of('prepare').map((c) => ({ venueId: c.body.venueId, ...c.body.intent }));
  expect(sent.map(({ changeKey, ...rest }) => rest)).toEqual([
    { venueId: v.b.id, kind: 'set_position_mode', symbol: FLAT, mode: 'hedge' },
    { venueId: v.b.id, kind: 'set_position_mode', symbol: FLAT, mode: 'one_way' },
  ]);
  expect(new Set(sent.map((x) => x.changeKey)).size).toBe(2);

  // The perpetual with the open short: the venue refuses the switch, and the page shows the venue's reason word for
  // word (read here from the venue itself). The wallet is never asked, and the mode and the position stay as they were.
  const short = open[0];
  const reason = await venueRefuses(v.b, s.owner, hedge(BTC, 'b-btc'));
  expect(reason.code).toBe('venue_rejected');
  expect(reason.detail).toContain(`can't change while a position is open on it: this account holds short ${short.size} ${BTC}`);
  await pick.selectOption(BTC);
  await expect(shown).toHaveText('One-way', { timeout: 20_000 });
  const asked = signatures(wallet);
  await choose(BTC, 'Hedge').click();
  await expect(outcome).toHaveText(`The venue refused it: ${reason.detail}`, { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked);
  expect(await modeOn(v.b, BTC)).toBe('one_way');
  await expect(shown).toHaveText('One-way');
  const [still] = await positionsOn(v.b, s.owner);
  expect({ symbol: still.symbol, side: still.side, size: still.size, margin: still.margin }).toEqual({
    symbol: BTC,
    side: 'short',
    size: short.size,
    margin: short.margin,
  });
  await ledgerUntouched(s);
});

test(`${J} #4 changes leverage: allowed up to the published cap shown; the margin difference stated before confirming`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await venuesNow();
  const wallet = await openRoom(page, s);
  const door = doorCalls(page);
  const market = (await at(v.a.base, '/markets', { account: null })).value.find((m) => m.symbol === BTC);
  const cap = market.maxLeverageBps / 10_000;
  expect(cap).toBeGreaterThan(5);
  await page
    .getByTestId('positions-all')
    .locator(`tr[data-venue="${v.a.id}"][data-symbol="${BTC}"]`)
    .getByRole('button', { name: 'Change leverage', exact: true })
    .click();
  const sheet = page.getByTestId('position-leverage');
  await expect(sheet.locator('[data-line="cap"]')).toHaveText(`Up to ${cap}x: the cap ${v.a.name} publishes for ${BTC}.`);
  const input = sheet.getByRole('textbox', { name: 'New leverage (x)', exact: true });
  const [before] = (await positionsOn(v.a, s.owner)).filter((p) => p.symbol === BTC);
  const freeBefore = (await usdcOn(v.a, s.owner)).free;
  expect(before.leverageBps).toBe(100_000);

  // Above the cap: refused in words before anything is read or signed.
  await input.fill(String(cap + 5));
  await sheet.getByRole('button', { name: 'Review the change', exact: true }).click();
  await expect(sheet.getByTestId('position-leverage-problem')).toHaveText(
    `${cap + 5}x is above the ${cap}x cap ${v.a.name} publishes for ${BTC}.`,
  );
  await expect(sheet.getByTestId('position-leverage-review')).toHaveCount(0);

  // 5x: the venue's own margin difference, stated before confirming; nothing has changed on the venue.
  await input.fill('5');
  await sheet.getByRole('button', { name: 'Review the change', exact: true }).click();
  const review = sheet.getByTestId('position-leverage-review');
  await expect(review).toBeVisible({ timeout: 20_000 });
  const venueSays = (
    await at(v.a.base, '/leverage-change', { account: accountOn(v.a, s.owner), symbol: BTC, leverageBps: 50_000, marginMode: 'isolated' })
  ).value;
  expect(same(venueSays.marginNow, before.margin)).toBe(true);
  expect(toUnits(venueSays.difference)).toBeGreaterThan(0n);
  expect(same((await review.locator('[data-line="margin-now"]').innerText()).trim(), venueSays.marginNow)).toBe(true);
  expect(same((await review.locator('[data-line="margin-after"]').innerText()).trim(), venueSays.marginAfter)).toBe(true);
  await expect(review.locator('[data-line="difference"]')).toHaveText(`Posted from your free balance: ${venueSays.difference}`);
  await expect(review).toContainText('Nothing has changed: the venue changes the leverage only when you confirm and sign.');
  expect(door.of('prepare')).toHaveLength(0);
  expect((await positionsOn(v.a, s.owner)).find((p) => p.symbol === BTC)).toEqual(before);

  // Confirmed and signed once: the venue takes 5x and posts exactly the stated difference from free.
  const asked = signatures(wallet);
  await review.getByRole('button', { name: 'Confirm 5x', exact: true }).click();
  await continueInWallet(page);
  await expect(sheet).toContainText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('prepare').map((c) => c.body.intent)).toEqual([
    { kind: 'update_leverage', symbol: BTC, leverageBps: 50_000, marginMode: 'isolated' },
  ]);
  const [after] = (await positionsOn(v.a, s.owner)).filter((p) => p.symbol === BTC);
  expect(after.leverageBps).toBe(50_000);
  expect(same(after.margin, venueSays.marginAfter)).toBe(true);
  expect(same((await usdcOn(v.a, s.owner)).free, fromUnits(toUnits(freeBefore) - toUnits(venueSays.difference)))).toBe(true);
  await expect(
    page.getByTestId('positions-all').locator(`tr[data-venue="${v.a.id}"][data-symbol="${BTC}"] [data-cell="leverage"]`),
  ).toHaveText('5x isolated', { timeout: 20_000 });
  await ledgerUntouched(s);
});

test(`${J} #5 closes all positions: a reviewed list, then each position closed once`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await venuesNow();
  const wallet = await openRoom(page, s);
  const door = doorCalls(page);
  const open = [];
  for (const venue of [v.a, v.b]) for (const p of await positionsOn(venue, s.owner)) open.push({ venue, p });
  expect(open).toHaveLength(3);
  await expect(page.getByTestId('positions-all').locator('tbody tr:not([data-row="total"])')).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Close all positions', exact: true }).click();
  const review = page.getByTestId('positions-close-all-review');
  // The reviewed list: every open position on every venue, nothing sent yet.
  for (const { venue, p } of open)
    await expect(review.locator(`li[data-venue="${venue.id}"][data-symbol="${p.symbol}"]`)).toContainText(
      `${p.side === 'long' ? 'Long' : 'Short'} ${p.size} ${p.symbol} on ${venue.name}`,
    );
  await expect(review.locator('li')).toHaveCount(3);
  // Every order on a venue carries our builder fee: a venue whose account hasn't approved it is named in the review, and
  // its one-time approval is signed first (the Starts line traded straight on the venues, so none has).
  const builder = (await (await api(s.account)).get('/api/v1/venue/status')).body.builder;
  const unapproved = [];
  if (builder)
    for (const venue of [v.a, v.b])
      if (toUnits(await record(venue, s.owner, '/builder-fee-approval', { builder: builder.address })) < toUnits(builder.feeBps))
        unapproved.push(venue);
  for (const venue of unapproved)
    await expect(review.locator(`[data-approve-venue="${venue.id}"]`)).toContainText(
      `${venue.name}: your account there hasn’t approved our builder fee of ${builder.feeBps} bps`,
    );
  await expect(review.locator('[data-approve-venue]')).toHaveCount(unapproved.length);
  expect(door.of('prepare')).toHaveLength(0);
  const asked = signatures(wallet);
  const prompts = 3 + unapproved.length;
  await review.getByRole('button', { name: 'Confirm and close 3', exact: true }).click();
  for (let i = 0; i < prompts; i += 1) await continueInWallet(page);
  await expect(review.locator('li', { hasText: 'Filled on the venue.' })).toHaveCount(3, { timeout: 30_000 });
  expect(signatures(wallet)).toBe(asked + prompts);
  for (const venue of unapproved)
    expect(toUnits(await record(venue, s.owner, '/builder-fee-approval', { builder: builder.address }))).toBe(toUnits(builder.feeBps));
  // Each closed once: one reduce-only order per position, on its own venue, for its whole size.
  const sent = door
    .of('prepare')
    .filter((c) => c.body.intent.kind === 'place_order')
    .map((c) => ({ venueId: c.body.venueId, intent: c.body.intent }));
  expect(sent).toHaveLength(3);
  for (const { venue, p } of open) {
    const mine = sent.filter((x) => x.venueId === venue.id && x.intent.symbol === p.symbol);
    expect(mine).toHaveLength(1);
    expect(mine[0].intent).toMatchObject({
      kind: 'place_order',
      reduceOnly: true,
      side: p.side === 'long' ? 'sell' : 'buy',
      amount: p.size,
    });
  }
  expect(new Set(sent.map((x) => x.intent.clientOrderKey)).size).toBe(3);
  for (const venue of [v.a, v.b]) expect(await positionsOn(venue, s.owner)).toEqual([]);
  // A second press is the same closes: the door's stored answers, no new signature and no new order on either venue.
  const fillsBefore = {};
  for (const venue of [v.a, v.b]) fillsBefore[venue.id] = (await record(venue, s.owner, '/fills', { since: s.startedAt })).length;
  await review.getByRole('button', { name: 'Confirm and close 3', exact: true }).click();
  await expect(review.locator('li', { hasText: 'This is the same action as before' })).toHaveCount(3, { timeout: 30_000 });
  expect(signatures(wallet)).toBe(asked + prompts);
  for (const venue of [v.a, v.b])
    expect((await record(venue, s.owner, '/fills', { since: s.startedAt })).length).toBe(fillsBefore[venue.id]);
  await expect(page.getByTestId('positions-all')).toContainText('No open positions on any connected venue.', { timeout: 20_000 });
  await ledgerUntouched(s);
});

test(`${J} #6 opens sub-account positions as the main wallet: each venue sub-account's positions with totals; a sibling's id is refused`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const v = await venuesNow();
  const wallet = await openRoom(page, s);
  const subs = page.locator(`[data-testid="positions-subs"][data-venue="${v.a.id}"]`);
  await expect(subs).toBeVisible();
  // The person opens a sub-account on the first venue from the room, signed on the main account.
  const name = `TEST jd5 ${s.tag}`;
  await subs.getByRole('textbox', { name: 'Sub-account name', exact: true }).fill(name);
  const asked = signatures(wallet);
  await subs.getByRole('button', { name: 'Open a sub-account', exact: true }).click();
  await continueInWallet(page);
  await expect(subs).toContainText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const listed = await record(v.a, s.owner, '/sub-accounts');
  const sub = listed.find((x) => x.name === name);
  expect(sub, JSON.stringify(listed)).toBeTruthy();
  // TEST setup on that sub-account, straight on the venue as its owner: USDC, and two positions.
  await fund(v.a, s.owner, '1000', sub.subAccount);
  await signedOn(v.a, s.key, leverage(BTC, 10), sub.subAccount);
  await signedOn(v.a, s.key, leverage(STOCK, 2), sub.subAccount);
  await signedOn(v.a, s.key, take(BTC, 'buy', '0.01', '60100', `order:jd5:${s.tag}:sub-btc`), sub.subAccount);
  await signedOn(v.a, s.key, take(STOCK, 'buy', '1', '201', `order:jd5:${s.tag}:sub-stock`), sub.subAccount);
  run.write({ ...run.read(), subAccount: sub.subAccount });

  const card = subs.locator(`[data-testid="positions-sub"][data-sub-account="${sub.subAccount}"]`);
  await expect(card).toContainText(`Sub-account ${name}`);
  await expect(card.locator('tbody tr:not([data-row="total"])')).toHaveCount(2, { timeout: 30_000 });
  await expect(async () => {
    const venueRows = await positionsOn(v.a, s.owner, sub.subAccount);
    const rows = await shownRows(card);
    expect(rows.map((r) => r.market).sort()).toEqual(venueRows.map((p) => p.symbol).sort());
    for (const p of venueRows) {
      const r = rows.find((x) => x.market === p.symbol);
      expect(r.venue).toBe(v.a.name);
      for (const [cell, figure] of [
        ['size', p.size],
        ['entry', p.entryPrice],
        ['mark', p.markPrice],
        ['margin', p.margin],
        ['unrealised', p.unrealisedPnl],
      ])
        expect(same(r[cell], figure), `${p.symbol} ${cell}`).toBe(true);
    }
    await totalsAddUp(card, rows);
    expect(
      same((await card.locator('[data-value="sub-free"]').innerText()).trim(), (await usdcOn(v.a, s.owner, sub.subAccount)).free),
    ).toBe(true);
  }).toPass({ timeout: 30_000 });
  // The second venue: no sub-accounts there, said so.
  await expect(page.locator(`[data-testid="positions-subs"][data-venue="${v.b.id}"]`)).toContainText(`No sub-accounts on ${v.b.name}.`);

  // A sibling: another TEST wallet's own sub-account on the same venue. Its id in the address is refused, never read.
  const other = otherTraderKey(`jd5-sibling-${s.tag}`);
  const otherOwner = other.address.toLowerCase();
  await signedOn(v.a, other, { kind: 'create_sub_account', name: 'TEST sibling', subAccountKey: `own:sub-account:${otherOwner}:sibling` });
  const sibling = (await record(v.a, otherOwner, '/sub-accounts'))[0].subAccount;
  await page.goto(`${ROOM}?subAccount=${sibling}`);
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  const addressed = page.getByTestId('positions-addressed');
  await expect(addressed.locator('[data-refusal="trade.venue_sub_account_not_own"]')).toContainText(
    `Refused: ${sibling} is not one of the sub-accounts ${v.a.name} lists under this wallet's main account`,
    { timeout: 20_000 },
  );
  await expect(addressed.locator('li')).toHaveCount(0);
  // The door itself refuses the read, for every account read.
  const client = await api(s.account);
  for (const path of ['positions', 'balances']) {
    const res = await client.get(`/api/v1/venue/${path}?owner=${s.owner}&subAccount=${sibling}&venueId=${v.a.id}`);
    expect(res.status, path).toBe(403);
    expect(res.body.intafacedCode).toBe('trade.venue_sub_account_not_own');
  }
  await ledgerUntouched(s);
});

test(`${J} #7 moves a position between main and sub-account: moved where the venue moves positions, both accounts showing the change; refused in words where it can't; moving margin is a signed venue transfer shown on both accounts`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  if (!s.subAccount)
    throw new Error(`${J} #6 opened no sub-account on the first venue, so this step has no accounts to move between there`);
  const v = await venuesNow();
  // What each venue itself declares: the first moves no position between accounts, the second does.
  expect(v.a.positionMoves).toBe(false);
  expect(v.b.positionMoves).toBe(true);
  // TEST setup, not the step: a position on the second venue's main account, taken straight on the venue as its owner.
  await signedOn(v.b, s.key, leverage(BTC, 10));
  await signedOn(v.b, s.key, take(BTC, 'buy', '0.02', '60100', `order:jd5:${s.tag}:b-move`));
  const wallet = await openRoom(page, s);
  const door = doorCalls(page);
  const table = page.getByTestId('positions-all');
  const subsOf = (venue) => page.locator(`[data-testid="positions-subs"][data-venue="${venue.id}"]`);
  const cardOf = (venue, id) => subsOf(venue).locator(`[data-testid="positions-sub"][data-sub-account="${id}"]`);
  const figures = (p) => ({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    entryPrice: p.entryPrice,
    margin: p.margin,
    leverageBps: p.leverageBps,
    marginMode: p.marginMode,
  });
  const usdcBoth = async (venue, id) => ({ main: await usdcOn(venue, s.owner), sub: await usdcOn(venue, s.owner, id) });
  const less = (a, b) => fromUnits(toUnits(a) - toUnits(b));
  const more = (a, b) => fromUnits(toUnits(a) + toUnits(b));

  // ── The second venue moves positions. The person opens a sub-account there from the room, signed on the main account.
  const subsB = subsOf(v.b);
  const name = `TEST jd5 move ${s.tag}`;
  await subsB.getByRole('textbox', { name: 'Sub-account name', exact: true }).fill(name);
  let asked = signatures(wallet);
  await subsB.getByRole('button', { name: 'Open a sub-account', exact: true }).click();
  await continueInWallet(page);
  await expect(subsB.locator(':scope > [data-testid="venue-outcome"]')).toHaveText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const listed = await record(v.b, s.owner, '/sub-accounts');
  const subB = listed.find((x) => x.name === name)?.subAccount;
  expect(subB, JSON.stringify(listed)).toBeTruthy();

  // Before: the venue's main account holds the position and the sub-account none, and the room shows the same.
  const [held] = await positionsOn(v.b, s.owner);
  expect(held.symbol).toBe(BTC);
  expect(await positionsOn(v.b, s.owner, subB)).toEqual([]);
  const mainRow = table.locator(`tr[data-venue="${v.b.id}"][data-symbol="${BTC}"]`);
  await expect(mainRow).toHaveCount(1, { timeout: 30_000 });
  expect(same(await cellText(mainRow, 'size'), held.size)).toBe(true);
  expect(same(await cellText(mainRow, 'margin'), held.margin)).toBe(true);
  const cardB = cardOf(v.b, subB);
  await expect(cardB).toContainText('No open positions on this sub-account.', { timeout: 30_000 });
  const moveB = subsB.getByTestId('positions-move-position');
  await expect(moveB).toContainText(
    `${v.b.name} moves a whole position, with the margin it holds, between your accounts as one signed venue action.`,
  );
  await expect(moveB.getByRole('combobox', { name: 'Move the position', exact: true })).toHaveValue('into_sub_account');
  await expect(moveB.getByRole('combobox', { name: 'Position', exact: true })).toHaveValue(BTC);
  const usdcBefore = await usdcBoth(v.b, subB);

  // The move: one signed venue action, sent once.
  asked = signatures(wallet);
  await moveB.getByRole('button', { name: 'Move position', exact: true }).click();
  await continueInWallet(page);
  await expect(moveB.getByTestId('venue-outcome')).toHaveText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const moves = door.of('prepare').filter((c) => c.body.intent.kind === 'move_position');
  expect(moves).toHaveLength(1);
  expect(moves[0].body.venueId).toBe(v.b.id);
  expect(moves[0].body.intent).toMatchObject({ kind: 'move_position', subAccount: subB, direction: 'into_sub_account', symbol: BTC });
  expect(moves[0].body.intent.moveKey).toMatch(/^position-move:/);

  // The venue's own record: the main account holds it no more; the sub-account holds the same position, figure for
  // figure, with the margin it held. That margin left the main account's locked balance and is locked on the
  // sub-account, once; no free balance moved.
  expect(await positionsOn(v.b, s.owner)).toEqual([]);
  const [moved] = await positionsOn(v.b, s.owner, subB);
  expect(figures(moved)).toEqual(figures(held));
  const usdcAfter = await usdcBoth(v.b, subB);
  expect(same(usdcAfter.main.locked, less(usdcBefore.main.locked, held.margin))).toBe(true);
  expect(same(usdcAfter.sub.locked, more(usdcBefore.sub.locked, held.margin))).toBe(true);
  expect(same(usdcAfter.main.free, usdcBefore.main.free)).toBe(true);
  expect(same(usdcAfter.sub.free, usdcBefore.sub.free)).toBe(true);
  // Both accounts show the change: the main account's row is gone, and the sub-account's card holds the position, each
  // figure the venue's own.
  await expect(mainRow).toHaveCount(0, { timeout: 30_000 });
  await expect(cardB.locator('tbody tr:not([data-row="total"])')).toHaveCount(1, { timeout: 30_000 });
  await expect(async () => {
    const [p] = await positionsOn(v.b, s.owner, subB);
    const rows = await shownRows(cardB);
    expect(rows).toHaveLength(1);
    expect(rows[0].market).toBe(BTC);
    expect(rows[0].venue).toBe(v.b.name);
    expect(rows[0].side).toBe('Long');
    for (const [cell, figure] of [
      ['size', p.size],
      ['entry', p.entryPrice],
      ['mark', p.markPrice],
      ['margin', p.margin],
      ['unrealised', p.unrealisedPnl],
    ])
      expect(same(rows[0][cell], figure), `${cell}: ${rows[0][cell]} vs ${figure}`).toBe(true);
    await totalsAddUp(cardB, rows);
  }).toPass({ timeout: 30_000 });
  // Nothing is left to move from the main account, so the room offers no second move of it.
  await expect(moveB.locator('[data-line="nothing-to-move"]')).toHaveText('No open position on that account to move.');

  // ── The first venue moves no position: the move is refused in words, nothing is signed or sent, and the venue's own
  // answer to the same move is that it makes none. Its sub-account (from #6) keeps both its positions.
  const subsA = subsOf(v.a);
  const moveA = subsA.getByTestId('positions-move-position');
  const heldA = (await positionsOn(v.a, s.owner, s.subAccount)).map(figures);
  expect(heldA.map((p) => p.symbol).sort()).toEqual([BTC, STOCK]);
  await expect(moveA).toContainText(`${v.a.name} doesn’t move an open position between accounts. Its margin moves above.`);
  await moveA.getByRole('combobox', { name: 'Move the position', exact: true }).selectOption('out_of_sub_account');
  await moveA.getByRole('combobox', { name: 'Position', exact: true }).selectOption(BTC);
  asked = signatures(wallet);
  const prepared = door.of('prepare').length;
  await moveA.getByRole('button', { name: 'Move position', exact: true }).click();
  await expect(moveA.getByTestId('positions-move-position-refused')).toHaveText(
    `Refused: ${v.a.name} doesn’t move an open position between accounts. Close it on one account and open it on the other, or move its margin above.`,
  );
  expect(signatures(wallet)).toBe(asked);
  expect(door.of('prepare')).toHaveLength(prepared);
  expect(
    await venueRefuses(v.a, s.owner, {
      kind: 'move_position',
      subAccount: s.subAccount,
      direction: 'out_of_sub_account',
      symbol: BTC,
      moveKey: `position-move:jd5:${s.tag}:a-btc`,
    }),
  ).toMatchObject({ code: 'not_offered', detail: `${v.a.name} moves no open position between accounts` });
  expect((await positionsOn(v.a, s.owner, s.subAccount)).map(figures)).toEqual(heldA);
  expect(await positionsOn(v.a, s.owner)).toEqual([]);

  // ── Moving margin there is a signed venue transfer, shown on both accounts.
  const marginA = subsA.getByTestId('positions-move-margin');
  const outcomeA = subsA.locator(':scope > [data-testid="venue-outcome"]');
  const amount = marginA.getByRole('textbox', { name: 'USDC to move', exact: true });
  const mainFree = subsA.locator('[data-value="main-free"]');
  const subFree = cardOf(v.a, s.subAccount).locator('[data-value="sub-free"]');
  const freeBefore = await usdcBoth(v.a, s.subAccount);
  const shownIsVenues = async () => {
    const now = await usdcBoth(v.a, s.subAccount);
    expect(same((await mainFree.innerText()).trim(), now.main.free), 'main account free').toBe(true);
    expect(same((await subFree.innerText()).trim(), now.sub.free), 'sub-account free').toBe(true);
    return now;
  };
  await expect(shownIsVenues).toPass({ timeout: 30_000 });
  // More than the main account holds free: signed, and the venue refuses it in its words; nothing moves on either account.
  await amount.fill(more(freeBefore.main.free, '1'));
  asked = signatures(wallet);
  await marginA.getByRole('button', { name: 'Move margin', exact: true }).click();
  await continueInWallet(page);
  await expect(outcomeA).toHaveText(
    'The venue refused it: free USDC on the main account does not cover the move (what is locked or held as margin stays)',
    { timeout: 20_000 },
  );
  expect(signatures(wallet)).toBe(asked + 1);
  expect(await usdcBoth(v.a, s.subAccount)).toEqual(freeBefore);
  // 250 TEST USDC into the sub-account: one signed venue transfer. Exactly that leaves the main account's free balance
  // and arrives on the sub-account's, in the venue's own record, and the room shows both.
  await amount.fill('250');
  asked = signatures(wallet);
  await marginA.getByRole('button', { name: 'Move margin', exact: true }).click();
  await continueInWallet(page);
  await expect(outcomeA).toHaveText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  const transfers = door.of('prepare').filter((c) => c.body.intent.kind === 'sub_account_transfer' && c.body.intent.amount === '250');
  expect(transfers).toHaveLength(1);
  expect(transfers[0].body.venueId).toBe(v.a.id);
  expect(transfers[0].body.intent).toMatchObject({ subAccount: s.subAccount, direction: 'into_sub_account', asset: 'USDC' });
  expect(transfers[0].body.intent.moveKey).toMatch(/^own:move:/);
  await expect(async () => {
    const now = await shownIsVenues();
    expect(same(now.main.free, less(freeBefore.main.free, '250')), `main free ${now.main.free}`).toBe(true);
    expect(same(now.sub.free, more(freeBefore.sub.free, '250')), `sub free ${now.sub.free}`).toBe(true);
    expect(same(now.main.locked, freeBefore.main.locked)).toBe(true);
    expect(same(now.sub.locked, freeBefore.sub.locked)).toBe(true);
  }).toPass({ timeout: 30_000 });
  expect((await positionsOn(v.a, s.owner, s.subAccount)).map(figures)).toEqual(heldA);
  await ledgerUntouched(s);
});
