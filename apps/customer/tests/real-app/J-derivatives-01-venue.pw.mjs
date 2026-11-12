// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits, fromUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  shownBalance,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-01's steps on the user's own venue account (B1, project-state #1789), in the running app against the
// stack's TEST venue simulator (BTC-PERP, isolated margin only). One test per step, titled "J-derivatives-01 #<n>" as
// today's files title them; a step in two files must pass in both. #1 makes the verified account and its TEST 1000 USDC
// (the journey's start). #2 (the gated list) and #3 (deferred to launch prep) are not here; #4 reads the strip's
// contract size, mark and funding from the venue's own market read. #10 closes the position and reads our builder fee on
// svc-ledger's own operator door; #11 reads what #10 closed. Every figure is TEST. The door is on for this file only.
const J = 'J-derivatives-01';
const DESK = '/trade/futures';
const SYMBOL = 'BTC-PERP';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST open of #6 and #8: a market long of TEST 0.1 BTC, at most TEST 60100 (the TEST ladder's asks start at 60010). */
const OPEN = { size: '0.1', worst: '60100' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return s;
}
const desk = async (page) => {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  return { ...s, wallet, owner: wallet.address };
};
const line = (sheet, name) => sheet.locator(`[data-line="${name}"]`);
const since = () => new Date(Date.now() - 3_600_000).toISOString();

/** The ticket filled for a market long and Review pressed; returns the review sheet. */
async function reviewLong(page, { size = OPEN.size, worst = OPEN.worst } = {}) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill(worst);
  await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('USDC');
  await ticket.getByRole('button', { name: 'Review long' }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible();
  return sheet;
}

test(`${J} #1 opens /trade/futures: the full desk with the contracts the venue lists, each with its venue named; a venue that is down is named and its controls refuse`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const account = await signUp(page, 'vfut');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const { owner } = await desk(page);
  // The journey's start: TEST 1000 USDC in the venue account (and a little TEST BTC, for #6's margin-asset refusal).
  expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await testDeposit(owner, 'BTC', '0.01', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);

  const { displayName } = await venueInfo();
  const markets = (await testVenue('/markets', {})).body.value.filter((m) => m.kind === 'perpetual');
  // The TEST venue lists BTC-PERP, the TEST gold perpetual XAU-PERP (J-derivatives-21) and the TEST stock perpetuals
  // XSTK-PERP and XSTD-PERP (J-derivatives-27); the desk lists every one, each with its venue named.
  expect(markets.map((m) => m.symbol)).toEqual([SYMBOL, 'XAU-PERP', 'XSTK-PERP', 'XSTD-PERP']);
  const list = page.getByTestId('venue-contract-list');
  await expect(list.getByRole('button')).toHaveCount(markets.length);
  for (const m of markets) await expect(list.getByRole('button', { name: `${m.symbol} · ${displayName}` })).toBeVisible();
  await expect(list.getByTestId('venue-test').first()).toHaveText('TEST');
  for (const part of ['venue-contract-strip', 'venue-wallet', 'venue-balances', 'venue-margin', 'venue-ticket', 'venue-blotter'])
    await expect(page.getByTestId(part)).toBeVisible();

  // Where the venue lists no contract for this account: "No futures contract is listed", with the reason naming the venue.
  try {
    expect((await testVenue('/test/switches', { unlistPerpetuals: true })).status).toBe(200);
    const none = page.getByTestId('venue-no-contract');
    await expect(none).toContainText('No futures contract is listed', { timeout: 20_000 });
    await expect(none).toContainText(`${displayName} lists no perpetual contract for this account.`);
    await expect(list.getByRole('button', { name: `${SYMBOL} · ${displayName}` })).toHaveCount(0);
  } finally {
    await testVenue('/test/switches', { unlistPerpetuals: false });
  }
  await expect(list.getByRole('button', { name: `${SYMBOL} · ${displayName}` })).toBeVisible({ timeout: 20_000 });

  // The venue goes down: the desk names it, and a control answers with the venue's typed refusal; nothing is sent.
  try {
    expect((await testVenue('/test/switches', { venueDown: true })).status).toBe(200);
    await expect(page.getByTestId('venue-read-problem').first()).toContainText(`${displayName} is down`, { timeout: 20_000 });
    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill(OPEN.size);
    await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill(OPEN.worst);
    await ticket.getByRole('button', { name: 'Review long' }).click();
    await expect(ticket.getByRole('alert')).toContainText('is down (TEST switch)');
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
  } finally {
    await testVenue('/test/switches', { venueDown: false });
  }
  expect((await venueRecord(owner, '/open-orders')).value).toEqual([]);
});

test(`${J} #4 picks the contract and reads its strip: family, settle asset, contract size, mark price and funding, each as the venue publishes it`, async ({
  page,
}) => {
  await desk(page);
  const list = page.getByTestId('venue-contract-list');
  const strip = page.getByTestId('venue-contract-strip');
  const { displayName } = await venueInfo();
  const venueMarket = async (symbol) => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === symbol);
  // Picking another contract redraws the strip for it; a figure the venue does not publish says so, never a zero.
  await list.getByRole('button', { name: `XAU-PERP · ${displayName}` }).click();
  await expect(strip.getByRole('heading')).toContainText('XAU-PERP');
  const gold = await venueMarket('XAU-PERP');
  expect(gold.funding).toEqual({ known: false });
  await expect(strip.getByTestId('venue-funding')).toHaveText('not published by this venue');
  await expect(strip.getByTestId('venue-contract-size')).toHaveText(`${gold.contractSize.value} XAU per contract`);

  // The person picks BTC-PERP: the strip is the venue's own figures for it.
  const pick = list.getByRole('button', { name: `${SYMBOL} · ${displayName}` });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await expect(strip.getByRole('heading')).toContainText(SYMBOL);
  await expect(strip.getByTestId('venue-test')).toHaveText('TEST');
  const m = await venueMarket(SYMBOL);
  expect(m.kind).toBe('perpetual');
  await expect(strip.getByTestId('venue-family')).toHaveText('Perpetual');
  await expect(strip.getByTestId('venue-settle-asset')).toHaveText(m.quoteAsset);
  expect(m.contractSize.known).toBe(true);
  await expect(strip.getByTestId('venue-contract-size')).toHaveText(`${m.contractSize.value} BTC per contract`);
  // The mark is the venue's now, digit for digit; read the venue and the strip together until one poll agrees, since
  // another file's fill on the shared TEST book may move it between two reads.
  expect(m.mark.known).toBe(true);
  await expect(async () => {
    const now = await venueMarket(SYMBOL);
    const shown = await strip.getByTestId('venue-mark').innerText();
    expect(sameDecimal(shown, now.mark.value), `strip ${shown}, venue ${now.mark.value}`).toBe(true);
  }).toPass({ timeout: 20_000 });
  // Funding: the venue's published rate, shown as a percent with its interval, and its next settlement time; read with
  // the strip in one poll, so an hour turning between two reads can't part them.
  expect(m.funding.known).toBe(true);
  const funding = strip.getByTestId('venue-funding');
  await expect(async () => {
    const { rate, intervalSeconds, nextFundingAt } = (await venueMarket(SYMBOL)).funding.value;
    expect(await funding.getAttribute('data-rate')).toBe(rate);
    const shown = (await strip.getByTestId('venue-funding-rate').innerText()).match(/^(-?[\d.]+)% every (\d+)h$/);
    expect(shown, 'the rate reads "<percent>% every <hours>h"').not.toBeNull();
    expect(sameDecimal(shown[1], fromUnits(toUnits(rate) * 100n)), `${shown[1]}% is ${rate} as a percent`).toBe(true);
    expect(Number(shown[2]) * 3600).toBe(intervalSeconds);
    expect(await strip.getByTestId('venue-funding-next').getAttribute('dateTime')).toBe(nextFundingAt);
    expect(new Date(nextFundingAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  }).toPass({ timeout: 20_000 });
});

test(`${J} #5 chooses the margin mode: the modes the venue offers for the contract, the others listed as not offered by this venue; nothing changes`, async ({
  page,
}) => {
  const { owner, wallet } = await desk(page);
  const before = await venueRecord(owner, '/balances');
  const margin = page.getByTestId('venue-margin');
  const market = (await testVenue('/markets', {})).body.value.find((m) => m.symbol === SYMBOL);
  expect(market.marginModes).toEqual(['isolated']);
  await expect(margin.locator('[data-mode="isolated"] input')).toBeEnabled();
  await expect(margin.locator('[data-mode="cross"]')).toContainText('Cross · not offered by this venue');
  await expect(margin.locator('[data-mode="cross"] input')).toBeDisabled();
  await margin.locator('[data-mode="isolated"] input').check();
  // Choosing changes nothing on the venue: no signature, and the balances are the same.
  expect(wallet.requests).toHaveLength(0);
  expect((await venueRecord(owner, '/balances')).value).toEqual(before.value);

  // The leverage for the contract is a signed setting on the venue (an order uses it): 10x isolated, signed here.
  await expect(margin.getByTestId('venue-leverage-current')).toHaveText('None set on the venue: sign a setting before your first order.');
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill('10');
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.');
  await expect(margin.getByTestId('venue-leverage-current')).toHaveText('Set on the venue: 10x, Isolated', { timeout: 15_000 });
  const lev = await venueRecord(owner, '/leverage', { symbol: SYMBOL });
  expect(lev.value).toEqual({ symbol: SYMBOL, leverageBps: 100000, marginMode: 'isolated' });
  expect((await venueRecord(owner, '/balances')).value).toEqual(before.value);
});

test(`${J} #6 types a TEST size and leverage and presses Review: initial margin, the venue's fee, our builder fee, liquidation price and the total to commit, from the venue's figures; a margin-currency mismatch is refused with both assets named`, async ({
  page,
}) => {
  const { owner } = await desk(page);
  // A margin asset that is not the contract's settle asset is refused, both assets named, before anything is sent.
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('textbox', { name: 'Size (BTC)' }).fill(OPEN.size);
  await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)' }).fill(OPEN.worst);
  await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('BTC');
  await ticket.getByRole('button', { name: 'Review long' }).click();
  await expect(ticket.getByRole('alert')).toHaveText(
    'Margin on BTC-PERP is posted in USDC; BTC cannot be used as its margin. Nothing was sent.',
  );

  const sheet = await reviewLong(page);
  const clientId = (await line(sheet, 'client-id').innerText()).trim();
  const p = (
    await venueRecord(owner, '/preview', {
      intent: {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'buy',
        type: 'market',
        amount: OPEN.size,
        price: OPEN.worst,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: clientId,
        builderFee: { builder: '0x7e57000000000000000000000000000000000b1d', feeBps: '0.5' },
      },
    })
  ).value;
  const text = async (name) => (await line(sheet, name).innerText()).replace(/,/g, '').trim();
  expect(sameDecimal(await text('initial-margin'), p.perpetual.initialMargin.value)).toBe(true);
  expect(await text('venue-fee')).toBe(`${p.venueFee.value.amount} ${p.venueFee.value.asset}`);
  expect(await text('builder-fee')).toBe(`${p.builderFee.value.amount} ${p.builderFee.value.asset}`);
  expect(await text('liquidation')).toBe(p.perpetual.liquidationPrice.known ? p.perpetual.liquidationPrice.value : 'not known');
  const total = toUnits(p.perpetual.initialMargin.value) + toUnits(p.venueFee.value.amount) + toUnits(p.builderFee.value.amount);
  const [shownTotal, settle] = (await text('total')).split(' ');
  expect(sameDecimal(shownTotal, fromUnits(total)) && settle === 'USDC').toBe(true);
  await expect(line(sheet, 'leverage')).toHaveText('10x, Isolated');
  await expect(sheet.getByTestId('venue-test').first()).toHaveText('TEST');

  // Our builder fee is approved here, once, so the open in #8 asks for one signature.
  await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' }).click();
  await continueInWallet(page);
  await expect(line(sheet, 'builder-approval')).toHaveText('Signed, up to 0.5 bps', { timeout: 15_000 });
  expect((await venueRecord(owner, '/positions')).value).toEqual([]);
});

test(`${J} #7 looks at the order types: market and limit as offered; resting types that are not live are listed with the honest refusal and no network write`, async ({
  page,
}) => {
  const { owner } = await desk(page);
  const market = (await testVenue('/markets', {})).body.value.find((m) => m.symbol === SYMBOL);
  expect(market.orderTypes).toEqual(['limit', 'market']);
  const types = page.getByTestId('venue-order-types');
  await expect(types.getByRole('button', { name: 'Market', exact: true })).toBeEnabled();
  await expect(types.getByRole('button', { name: 'Limit', exact: true })).toBeEnabled();
  const writes = [];
  page.on('request', (r) => r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/') && writes.push(r.url()));
  for (const name of ['Stop', 'Take profit', 'Trailing stop']) {
    const button = types.getByRole('button', { name: `${name}: not offered by this venue`, exact: true });
    await expect(button).toBeDisabled();
    await button.click({ force: true });
  }
  await page.waitForTimeout(1_000);
  expect(writes).toEqual([]);
  expect((await venueRecord(owner, '/open-orders')).value).toEqual([]);
});

test(`${J} #8 confirms Open long and signs: the venue opens one position; a double press asks for one signature and sends one order`, async ({
  page,
}) => {
  const { owner, wallet } = await desk(page);
  const sheet = await reviewLong(page);
  await expect(line(sheet, 'builder-approval')).toHaveText('Signed, up to 0.5 bps');
  const submits = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/submit') && submits.push(r.url()));
  // Two presses in the same moment.
  await sheet.getByRole('button', { name: 'Open long' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(wallet.requests).toHaveLength(1);
  expect(submits).toHaveLength(1);
  const positions = (await venueRecord(owner, '/positions')).value;
  expect(positions).toHaveLength(1);
  expect(positions[0]).toMatchObject({ symbol: SYMBOL, side: 'long', marginMode: 'isolated', leverageBps: 100000 });
  expect(sameDecimal(positions[0].size, OPEN.size)).toBe(true);
});

test(`${J} #9 opens the positions room: entry, mark, unrealised result, margin, leverage and liquidation price as exact decimals as the venue reports them, with an as-of time`, async ({
  page,
}) => {
  const { owner } = await desk(page);
  const room = page.getByTestId('venue-positions');
  const row = room.locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const [p] = (await venueRecord(owner, '/positions')).value;
  await expect(row.locator('[data-cell="size"]')).toHaveText(p.size);
  await expect(row.locator('[data-cell="entry"]')).toHaveText(p.entryPrice);
  await expect(row.locator('[data-cell="mark"]')).toHaveText(p.markPrice);
  await expect(row.locator('[data-cell="unrealised"]')).toHaveText(p.unrealisedPnl);
  await expect(row.locator('[data-cell="margin"]')).toHaveText(p.margin);
  await expect(row.locator('[data-cell="leverage"]')).toHaveText('10x Isolated');
  await expect(row.locator('[data-cell="liquidation"]')).toHaveText(p.liquidationPrice.known ? p.liquidationPrice.value : 'not known');
  await expect(room.getByTestId('venue-as-of')).toContainText('As of');
  await expect(room.getByTestId('venue-test').first()).toHaveText('TEST');
});

/** One read of svc-ledger's own operator door, as the stack's TEST founder a with admin:treasury reads it (as J-derivatives-17). */
let staffDoor;
async function ledgerRead(path) {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, token: await sessions.a.treasuryToken() };
  })();
  const { ctx, token } = await staffDoor;
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** The person's fills on SYMBOL, as the venue records them. */
const symbolFills = async (owner) => (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === SYMBOL);

/**
 * Closes the position: 40 percent pressed twice in the same moment (one close id, one signature, one order), then the
 * rest. Answers the first close's submit (the bytes the desk sent and the door's answer) and the venue's closing fills.
 */
async function closeAll(page, { owner, wallet }, afterFirst = async () => {}) {
  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const close = row.getByTestId('venue-close');
  const submits = [];
  page.on('response', (res) => {
    const req = res.request();
    if (req.method() === 'POST' && req.url().endsWith('/api/v1/venue/submit'))
      submits.push(res.json().then((answer) => ({ body: req.postDataJSON(), answer })));
  });
  const signed = wallet.requests.length;
  await close.getByRole('textbox').fill('40');
  await close.getByRole('button', { name: 'Close 40%' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await expect(close.getByTestId('venue-close-outcome')).toContainText('Close of 0.04 BTC: Filled on the venue.', { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(wallet.requests.length - signed).toBe(1);
  expect(submits).toHaveLength(1);
  const first = await submits[0];
  await expect.poll(async () => (await venueRecord(owner, '/positions')).value[0]?.size, { timeout: 15_000 }).toBe('0.06');
  await afterFirst(first);
  await close.getByRole('textbox').fill('100');
  await close.getByRole('button', { name: 'Close 100%' }).click();
  await continueInWallet(page);
  await expect(close).toHaveCount(0, { timeout: 15_000 });
  expect((await venueRecord(owner, '/positions')).value).toEqual([]);
  const closing = (await symbolFills(owner)).filter((f) => f.realisedPnl !== null);
  expect(fromUnits(closing.reduce((t, f) => t + toUnits(f.amount), 0n))).toBe(OPEN.size);
  await expect.poll(async () => toUnits((await shownBalance(page, 'USDC')).used), { timeout: 15_000 }).toBe(0n);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, '0')).toBe(true);
  return { first, closing };
}

test(`${J} #10 closes 40 percent, then the rest: the venue's split results sum to the full close; a repeated close id is sent and answered once; our ledger posts only our builder fee`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const opened = await desk(page);
  const { owner, account } = opened;
  const person = await api(account);
  const ledgerBefore = await person.balances();
  const { id: venueId } = await venueInfo();

  // The first close's signed submit sent again, as a lost answer's retry would send it: the door answers the first close's
  // own answer, marked as the stored one, and the venue closes nothing more.
  const { closing } = await closeAll(page, opened, async (sent) => {
    expect(sent.answer.outcome, JSON.stringify(sent.answer).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
    expect(sent.answer.replayed).toBe(false);
    const fillsBefore = (await symbolFills(owner)).length;
    const replay = await person.post('/api/v1/venue/submit', sent.body);
    expect(replay.status, JSON.stringify(replay.body).slice(0, 400)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.outcome).toEqual(sent.answer.outcome);
    await page.waitForTimeout(2_000);
    expect((await venueRecord(owner, '/positions')).value[0]?.size).toBe('0.06');
    expect((await venueRecord(owner, '/open-orders')).value).toEqual([]);
    expect(await symbolFills(owner)).toHaveLength(fillsBefore);
  });

  // Two closes, each its own order with its own close id: 40 percent, then the rest, together the whole position. The
  // desk shows each closing fill with the venue's own result, and the closed position's result as their sum.
  const byClose = Map.groupBy(closing, (f) => f.venueClientOrderId);
  expect(byClose.size).toBe(2);
  const sizes = [...byClose.values()].map((list) => fromUnits(list.reduce((t, f) => t + toUnits(f.amount), 0n)));
  expect(sizes.sort()).toEqual(['0.04', '0.06']);
  const realised = closing.reduce((t, f) => t + toUnits(f.realisedPnl), 0n);
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'History' }).click();
  for (const f of closing) {
    const shown = page.getByTestId('venue-fills').locator(`tr[data-fill="${f.fillId}"]`);
    await expect(shown).toBeVisible({ timeout: 15_000 });
    expect(sameDecimal(await shown.locator('[data-cell="realised"]').innerText(), f.realisedPnl)).toBe(true);
  }
  const closed = page.getByTestId('venue-history').locator(`tr[data-closed="${SYMBOL}"]`);
  expect(sameDecimal(await closed.locator('[data-cell="realised"]').innerText(), fromUnits(realised))).toBe(true);

  // Our ledger posts only our builder fee: for every fill of this position that carries it (both closes do) one transaction
  // under the fill's own key, our fee exactly as the venue charged it, in two postings; a fill without it posts nothing;
  // the person's own balances on our ledger never move.
  for (const f of closing) expect(toUnits(f.builderFee), `our builder fee on close fill ${f.fillId}`).toBeGreaterThan(0n);
  for (const f of await symbolFills(owner)) {
    const businessKey = `builder-fee:${venueId}:${owner.toLowerCase()}:${f.fillId}`;
    const trace = () => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(businessKey)}`);
    if (toUnits(f.builderFee) === 0n) {
      expect(await trace()).toEqual({ found: false, businessKey });
      continue;
    }
    await expect.poll(async () => (await trace()).found, { timeout: 30_000, message: `${businessKey} posted` }).toBe(true);
    const tx = await trace();
    expect(tx).toMatchObject({ businessKey, module: 'trade', reason: 'trade.builder_fee.earned' });
    expect(tx.postings).toHaveLength(2);
    for (const p of tx.postings) {
      expect(p.assetId).toBe(f.feeAsset);
      expect(sameDecimal(p.amount, f.builderFee)).toBe(true);
    }
  }
  expect(await person.balances()).toEqual(ledgerBefore);
});

test(`${J} #11 opens History: the closed position with its realised result, the venue's fee and our builder fee, from the venue`, async ({
  page,
}) => {
  const opened = await desk(page);
  const { owner } = opened;
  // #10 closed the position; when it did not get that far, this step closes it itself first.
  if ((await venueRecord(owner, '/positions')).value.length > 0) await closeAll(page, opened);
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'History' }).click();
  const fills = (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === SYMBOL);
  const realised = fromUnits(fills.filter((f) => f.realisedPnl !== null).reduce((t, f) => t + toUnits(f.realisedPnl), 0n));
  const venueFees = fromUnits(fills.reduce((t, f) => t + toUnits(f.venueFee), 0n));
  const builderFees = fromUnits(fills.reduce((t, f) => t + toUnits(f.builderFee), 0n));
  const closed = page.getByTestId('venue-history').locator(`tr[data-closed="${SYMBOL}"]`);
  await expect(closed).toBeVisible({ timeout: 15_000 });
  expect(sameDecimal(await closed.locator('[data-cell="realised"]').innerText(), realised)).toBe(true);
  expect(sameDecimal(await closed.locator('[data-cell="venue-fees"]').innerText(), venueFees)).toBe(true);
  expect(sameDecimal(await closed.locator('[data-cell="builder-fees"]').innerText(), builderFees)).toBe(true);
  expect(toUnits(builderFees) > 0n).toBe(true);
  for (const f of fills) await expect(page.getByTestId('venue-fills').locator(`tr[data-fill="${f.fillId}"]`)).toBeVisible();
});
