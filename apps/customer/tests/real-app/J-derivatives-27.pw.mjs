// World: gates, restart
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-27: I trade a stock perpetual around the clock, on the user's own venue account, in the running app
// against the stack's TEST venue simulator. Its TEST stock perpetual XSTK-PERP is listed by a TEST HIP-3 deployer, priced
// by the simulator's own TEST feed, and has a TEST home market whose hours the simulator's TEST control sets
// (packages/venue-sim/src/http-server.ts); it tracks no real company's share, and every figure and rule is TEST. One test
// per step, titled "J-derivatives-27 #<n>". Every figure and word the desk shows is compared with the venue's own record,
// never typed here.
// World: the door switched on for this file (restart), and #4's and #5's closed home market on the shared TEST venue (a
// runtime fault, gates). The venue's own books are not the stack's shared books.
// #4 and #5 each close the market's home market on the shared TEST venue and open it again in the same step (and again
// after the file), so no other file sees it closed. #6's ledger half (our ledger posts only our builder fee, once per
// fill) is J-derivatives-17's poster, read here as an operator reads it: the builder-fee recon for each fill, and the
// person's own ledger accounts, which the venue trade never moves.
// Left for a later piece of this journey: #7 (the market's own margin account), #8 (its open-interest cap), #9 (the
// deployer's halt) and #10 (a TEST split).
const J = 'J-derivatives-27';
const SYMBOL = 'XSTK-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST open of #2: a market long of TEST 2 XSTK at 5x, at most TEST 210 (the TEST ladder's asks start at 200.1). */
const OPEN = { size: '2', worst: '210', times: 5 };
/** The words that would claim a protection of ours (the journey's money line: the venue holds and settles). */
const PROTECTION =
  /\b(?:protect\w*|guarantee\w*|safe\w*|insur\w*|no liquidation|never liquidat\w*|we (?:pause|halt|stop|hold|freeze)\w*|covered|secured?)\b/i;
/** A venue's word as the desk shows it: the venue's text, or "not published by this venue". */
const words = (v) => (v.known ? v.value : 'not published by this venue');

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
// The shared TEST venue's home market for the stock perpetual opens again after the file, whatever #4 or #5 left.
test.afterAll(async () => {
  await testVenue('/test/session', { symbol: SYMBOL, state: 'open' }).catch(() => undefined);
});

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}
function opened() {
  const s = state();
  if (!s.opened) throw new Error(`${J} #2 opened no position, so this step has none to act on`);
  return s;
}
const desk = async (page) => {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  return { ...s, wallet, owner: wallet.address };
};
const since = () => new Date(Date.now() - 3_600_000).toISOString();
const market = async () => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === SYMBOL);
const submitsOf = (page) => {
  const submits = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/submit') && submits.push(r.url()));
  return submits;
};
const rules = (page) => page.getByTestId('venue-market-rules');
const sessionPanel = (page) => page.getByTestId('venue-session');
/** Close the TEST home market (or open it), as the simulator's TEST control does, and answer the venue's session. */
async function setSession(stateWanted) {
  const switched = await testVenue('/test/session', { symbol: SYMBOL, state: stateWanted });
  expect(switched.status, JSON.stringify(switched.body)).toBe(200);
  const m = await market();
  expect(m.session.known && m.session.value.state === stateWanted).toBe(true);
  return m.session.value;
}

/** The stack's TEST founders' sessions, for #6's two operator reads (tooling/scripts/local-test-gates.mjs). */
let staff;
const staffDoor = () =>
  (staff ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, sessions: await gates.approverSessions(ctx) };
  })());
/** svc-trade's builder-fee recon lines for a period, as the founders' trade-ops token reads them (admin.builderFees.recon). */
async function reconLines(from, to) {
  const { ctx, sessions } = await staffDoor();
  const res = await ctx.edge.query('trade', 'admin.builderFees.recon', { from, to }, await sessions.a.tradeOpsToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data.venues.flatMap((v) => v.lines);
}
/** Every ledger account of `user:<userId>`, kind and asset to balance, as svc-ledger's operator door with admin:treasury reads it. */
async function ledgerOf(userId) {
  const { ctx, sessions } = await staffDoor();
  const res = await fetch(`${ctx.url('ledger')}/operator/accounts?prefix=${encodeURIComponent(`user:${userId}`)}`, {
    headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` },
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  const page = JSON.parse(text);
  expect(page.nextCursor, 'one page holds every account of one owner').toBeNull();
  return Object.fromEntries(
    page.accounts.filter((a) => a.address === `user:${userId}`).map((a) => [`${a.kind}:${a.assetId}`, fromUnits(toUnits(a.balance))]),
  );
}

/** The ticket filled for a market long of the stock perpetual and Review pressed. */
async function reviewLong(page) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (XSTK)' }).fill(OPEN.size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill(OPEN.worst);
  await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('USDC');
  await ticket.getByRole('button', { name: 'Review long' }).click();
  return ticket;
}

test(`${J} #1 opens a stock perpetual: the venue that lists it (HIP-3 or Ostium), its price feed and mark rules, leverage cap and trading hours, read from the venue`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const account = await signUp(page, 'vstock');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const s = state();
  const wallet = await openVenueDesk(page, s.account, '/trade/futures', s.walletKey);
  // The journey's start: TEST collateral in the venue account.
  expect(await testDeposit(wallet.address, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);

  const { displayName } = await venueInfo();
  const m = await market();
  expect(m, `${SYMBOL} is not listed on the TEST venue`).toBeTruthy();
  expect(m.kind).toBe('perpetual');
  expect(m.listedBy.known && ['hip3', 'ostium'].includes(m.listedBy.value.kind)).toBe(true);
  // A stock perpetual: one with a home market whose hours it trades around.
  expect(m.session.known).toBe(true);
  // Opens it from the venue's contract list.
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${SYMBOL} · ${displayName}` })
    .click();
  const strip = page.getByTestId('venue-contract-strip');
  await expect(strip.getByRole('heading')).toContainText(SYMBOL);
  await expect(strip.getByTestId('venue-test').first()).toHaveText('TEST');
  // The leverage cap, from the venue's own market record.
  await expect(strip.getByTestId('venue-max-leverage')).toHaveText(`${m.maxLeverageBps / 10_000}x`);

  const panel = rules(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('venue-test').first()).toHaveText('TEST');
  // Who lists it: the kind of lister the venue names (HIP-3 or Ostium) and the lister's own name.
  const kindWord = { hip3: 'HIP-3', ostium: 'Ostium' }[m.listedBy.value.kind];
  await expect(panel.getByTestId('venue-listing')).toHaveAttribute('data-listing', m.listedBy.value.kind);
  await expect(panel.getByTestId('venue-listing')).toContainText(kindWord);
  await expect(panel.getByTestId('venue-listing')).toContainText(m.listedBy.value.name);
  // Its price feed and mark rules and its trading hours: the venue's own words, or "not published by this venue".
  await expect(panel.getByTestId('venue-oracle-rule')).toHaveText(words(m.oracleRule));
  await expect(panel.getByTestId('venue-mark-rule')).toHaveText(words(m.markRule));
  await expect(panel.getByTestId('venue-trading-hours')).toHaveText(words(m.tradingHours));
  expect(m.oracleRule.known && m.markRule.known && m.tradingHours.known).toBe(true);
  // The price feed it is priced from, in the venue's state.
  expect(m.feed.known).toBe(true);
  await expect(panel.getByTestId('venue-feed-state')).toHaveAttribute('data-state', m.feed.value.state);
  expect((await venueRecord(wallet.address, '/positions')).value).toEqual([]);
  expect(wallet.requests).toHaveLength(0);
});

test(`${J} #2 opens a position within the cap while the stock's home market is open: the venue position with entry, mark and liquidation price; the user signed`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, wallet } = await desk(page);
  const m = await market();
  expect(OPEN.times * 10_000 <= m.maxLeverageBps).toBe(true);
  // The home market is open, as the venue reports it and the desk shows it.
  expect(m.session.value.state).toBe('open');
  await expect(sessionPanel(page)).toHaveAttribute('data-state', 'open');
  await expect(sessionPanel(page).getByTestId('venue-home-market')).toHaveText(
    `${m.session.value.homeMarket}: open, as the venue reports it`,
  );

  // The leverage for the contract, within the cap, is a signed setting on the venue.
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill(String(OPEN.times));
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 15_000 });
  expect((await venueRecord(owner, '/leverage', { symbol: SYMBOL })).value).toEqual({
    symbol: SYMBOL,
    leverageBps: OPEN.times * 10_000,
    marginMode: 'isolated',
  });

  await reviewLong(page);
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible();
  // Our builder fee is approved once on a new account, before the open.
  const approval = sheet.locator('[data-line="builder-approval"]');
  if (!/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' }).click();
    await continueInWallet(page);
    await expect(approval).toHaveText(/Signed, up to/, { timeout: 15_000 });
  }
  const signedBefore = wallet.requests.length;
  const submits = submitsOf(page);
  // Two presses in the same moment: one signature, one order sent.
  await sheet.getByRole('button', { name: 'Open long' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  // The user signed the open, once.
  expect(wallet.requests.length - signedBefore).toBe(1);
  expect(submits).toHaveLength(1);

  const positions = (await venueRecord(owner, '/positions')).value;
  expect(positions).toHaveLength(1);
  const [p] = positions;
  expect(p).toMatchObject({ symbol: SYMBOL, side: 'long', marginMode: 'isolated', leverageBps: OPEN.times * 10_000 });
  expect(sameDecimal(p.size, OPEN.size)).toBe(true);
  // The size the venue filled is the size opened.
  const fills = (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === SYMBOL);
  expect(fills.length > 0).toBe(true);
  const filled = fills.reduce((t, f) => t + toUnits(f.amount), 0n);
  expect(fromUnits(filled)).toBe(fromUnits(toUnits(OPEN.size)));
  await sheet.getByRole('button', { name: 'Back', exact: true }).click();

  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('[data-cell="entry"]')).toHaveText(p.entryPrice);
  await expect(row.locator('[data-cell="mark"]')).toHaveText(p.markPrice);
  expect(p.liquidationPrice.known).toBe(true);
  await expect(row.locator('[data-cell="liquidation"]')).toHaveText(p.liquidationPrice.value);
  run.write({ opened: { entry: p.entryPrice, mark: p.markPrice } });
});

test(`${J} #3 tries an open above the venue's leverage cap: refused with the cap named`, async ({ page }) => {
  opened();
  const { owner, wallet } = await desk(page);
  const m = await market();
  const cap = m.maxLeverageBps / 10_000;
  const before = {
    balances: (await venueRecord(owner, '/balances')).value,
    positions: (await venueRecord(owner, '/positions')).value,
    leverage: (await venueRecord(owner, '/leverage', { symbol: SYMBOL })).value,
    orders: (await venueRecord(owner, '/open-orders')).value,
  };
  const submits = submitsOf(page);
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill(String(cap * 2));
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  // The venue's own refusal, naming its cap, before the wallet is asked.
  const outcome = margin.getByTestId('venue-outcome');
  await expect(outcome).toContainText('The venue refused it:', { timeout: 15_000 });
  await expect(outcome).toContainText(`${SYMBOL} allows at most ${cap}x`);
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toHaveCount(0);
  // The open itself: on this venue an order carries no leverage of its own (its leverage is the account's signed
  // setting), so the long the person now reviews is at the leverage the venue holds, within the cap, never at the
  // refused one. Nothing is confirmed.
  await reviewLong(page);
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const leverageLine = sheet.locator('[data-line="leverage"]');
  await expect(leverageLine).toContainText(`${before.leverage.leverageBps / 10_000}x`);
  await expect(leverageLine).not.toContainText(`${cap * 2}x`);
  expect(before.leverage.leverageBps <= m.maxLeverageBps).toBe(true);
  await page.waitForTimeout(1_000);
  // Nothing moved: no signature, no submit, and the venue's leverage, position, orders and balances are as they were.
  expect(wallet.requests).toHaveLength(0);
  expect(submits).toHaveLength(0);
  expect((await venueRecord(owner, '/leverage', { symbol: SYMBOL })).value).toEqual(before.leverage);
  expect((await venueRecord(owner, '/positions')).value).toEqual(before.positions);
  expect((await venueRecord(owner, '/open-orders')).value).toEqual(before.orders);
  expect((await venueRecord(owner, '/balances')).value).toEqual(before.balances);
});

test(`${J} #4 watches the market after the stock's home market closes: the venue's off-hours mode, band, leverage and reopen time as the venue publishes them; where the venue gives no rule, "not published by this venue"`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  opened();
  const { owner } = await desk(page);
  const panel = sessionPanel(page);
  await expect(panel).toHaveAttribute('data-state', 'open');
  const markBefore = (await venueRecord(owner, '/positions')).value[0].markPrice;
  try {
    const session = await setSession('off_hours');
    const { displayName } = await venueInfo();

    // Closed, as the venue reports it, with its off-hours mode, band, leverage and reopen time, each in its words or
    // "not published by this venue".
    await expect(panel).toHaveAttribute('data-state', 'off_hours', { timeout: 20_000 });
    await expect(panel.getByTestId('venue-home-market')).toHaveText(`${session.homeMarket}: closed, as the venue reports it`);
    await expect(panel.getByTestId('venue-off-hours-mode')).toHaveText(words(session.offHoursMode));
    await expect(panel.getByTestId('venue-off-hours-band')).toHaveText(words(session.offHoursBand));
    await expect(panel.getByTestId('venue-off-hours-leverage')).toHaveText(
      session.offHoursMaxLeverageBps === null ? 'not published by this venue' : `At most ${session.offHoursMaxLeverageBps / 10_000}x`,
    );
    if (session.reopensAt === null) await expect(panel.getByTestId('venue-reopens')).toHaveText('not published by this venue');
    else await expect(panel.getByTestId('venue-reopens').locator('time')).toHaveAttribute('datetime', session.reopensAt);
    await expect(panel.getByTestId('venue-off-hours-rule')).toHaveText(words(session.offHoursRule));
    await expect(panel.getByTestId('venue-off-hours')).toHaveText(
      `${displayName} reports ${session.homeMarket} closed: ${SYMBOL} is in the venue’s off-hours mode. The venue’s own rule: ${words(session.offHoursRule)}`,
    );
    // The TEST venue publishes each of them.
    expect(session.offHoursMode.known && session.offHoursBand.known && session.offHoursRule.known).toBe(true);
    expect(session.offHoursMaxLeverageBps).not.toBeNull();
    expect(session.reopensAt).not.toBeNull();

    // The venue's off-hours mode holds the mark: a TEST price update is refused, and the desk's mark is the venue's.
    const moved = await testVenue('/test/set-mark', { symbol: SYMBOL, price: '230' });
    expect(moved.status).toBe(422);
    const [p] = (await venueRecord(owner, '/positions')).value;
    expect(p.markPrice).toBe(markBefore);
    await expect(page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"] [data-cell="mark"]`)).toHaveText(p.markPrice);

    // No protection of ours anywhere on the desk.
    const shown = await page.getByTestId('if-futures').innerText();
    expect(shown.replace(words(session.offHoursRule), '').replace(words(session.offHoursMode), '')).not.toMatch(PROTECTION);
  } finally {
    await setSession('open');
  }
  await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 20_000 });
  await expect(panel.getByTestId('venue-reopens')).toHaveText('Open now');
});

test(`${J} #5 tries an open the venue refuses off hours: refused with the venue's reason named`, async ({ page }) => {
  test.setTimeout(180_000);
  opened();
  const { owner, wallet } = await desk(page);
  const before = {
    balances: (await venueRecord(owner, '/balances')).value,
    positions: (await venueRecord(owner, '/positions')).value,
    orders: (await venueRecord(owner, '/open-orders')).value,
  };
  try {
    const session = await setSession('off_hours');
    expect(session.offHoursRule.known).toBe(true);
    const reason = session.offHoursRule.value;
    await expect(sessionPanel(page)).toHaveAttribute('data-state', 'off_hours', { timeout: 20_000 });

    // A market long off hours: the venue refuses it in its own words before the wallet is asked; nothing is sent.
    const submits = submitsOf(page);
    const ticket = await reviewLong(page);
    await expect(ticket.getByRole('alert')).toContainText(`The venue refused it: ${reason}`, { timeout: 15_000 });
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(wallet.requests).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect((await venueRecord(owner, '/open-orders')).value).toEqual(before.orders);
    expect((await venueRecord(owner, '/positions')).value).toEqual(before.positions);
    expect((await venueRecord(owner, '/balances')).value).toEqual(before.balances);
  } finally {
    await setSession('open');
  }
});

test(`${J} #6 closes the position: the venue's realised result; the ledger posts only our builder fee`, async ({ page }) => {
  test.setTimeout(240_000);
  opened();
  const from = since();
  const { owner, wallet, account } = await desk(page);
  const { userId } = await api(account);
  const before = await ledgerOf(userId);
  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const close = row.getByTestId('venue-close');
  const submits = submitsOf(page);
  await close.getByRole('textbox').fill('100');
  // Two presses in the same moment: one close id, one signature, one order.
  await close.getByRole('button', { name: 'Close 100%' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await expect(close).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(wallet.requests).toHaveLength(1);
  expect(submits).toHaveLength(1);
  expect((await venueRecord(owner, '/positions')).value).toEqual([]);

  const fills = (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === SYMBOL);
  const closing = fills.filter((f) => f.realisedPnl !== null);
  expect(fromUnits(closing.reduce((t, f) => t + toUnits(f.amount), 0n))).toBe(fromUnits(toUnits(OPEN.size)));
  const realised = fromUnits(closing.reduce((t, f) => t + toUnits(f.realisedPnl), 0n));
  const builderFees = fromUnits(fills.reduce((t, f) => t + toUnits(f.builderFee), 0n));
  // The venue's fills carry our builder fee, as the venue charged it.
  for (const f of fills) expect(toUnits(f.builderFee) > 0n, `fill ${f.fillId} carries no builder fee`).toBe(true);

  await page.getByTestId('venue-blotter').getByRole('button', { name: 'History' }).click();
  const closed = page.getByTestId('venue-history').locator(`tr[data-closed="${SYMBOL}"]`);
  await expect(closed).toBeVisible({ timeout: 15_000 });
  expect(sameDecimal(await closed.locator('[data-cell="realised"]').innerText(), realised)).toBe(true);
  expect(sameDecimal(await closed.locator('[data-cell="builder-fees"]').innerText(), builderFees)).toBe(true);

  // Our ledger posts our builder fee once per fill, at the venue's amount (the poster's own cadence), and nothing of
  // the person's: the venue holds the collateral and the position, so their ledger accounts read as before the close.
  const to = new Date(Date.now() + 10 * 60_000).toISOString();
  const ours = (lines) => fills.map((f) => lines.filter((l) => l.fillId === f.fillId));
  await expect
    .poll(async () => ours(await reconLines(from, to)).map((ls) => ls.map((l) => l.status).join(',')), { timeout: 60_000 })
    .toEqual(fills.map(() => 'matched'));
  const lines = ours(await reconLines(from, to));
  fills.forEach((f, i) => {
    expect(lines[i], `fill ${f.fillId}: one recon line`).toHaveLength(1);
    expect(sameDecimal(lines[i][0].ledgerAmount, f.builderFee), `fill ${f.fillId}: the ledger's fee is the venue's`).toBe(true);
  });
  expect(await ledgerOf(userId)).toEqual(before);
  run.write({ closed: { fillIds: fills.map((f) => f.fillId), builderFees } });
});
