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
// (the journey's start). #2 (the gated list), #3 (deferred to launch prep) and #4 (the strip's mark price and funding,
// which the venue's market read does not carry) are not here. Every figure is TEST. The door is on for this file only.
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
  expect(markets.map((m) => m.symbol)).toEqual([SYMBOL]);
  const list = page.getByTestId('venue-contract-list');
  await expect(list.getByRole('button', { name: `${SYMBOL} · ${displayName}` })).toBeVisible();
  await expect(list.getByTestId('venue-test').first()).toHaveText('TEST');
  for (const part of ['venue-contract-strip', 'venue-wallet', 'venue-balances', 'venue-margin', 'venue-ticket', 'venue-blotter'])
    await expect(page.getByTestId(part)).toBeVisible();

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
    const button = types.getByRole('button', { name: `${name}: not offered by this venue` });
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

test(`${J} #10 closes 40 percent, then the rest: the venue's split results sum to the full close; a repeated close id is sent and answered once; our ledger posts nothing for it`, async ({
  page,
}) => {
  const { owner, wallet, account } = await desk(page);
  const ledgerBefore = await (await api(account)).balances();
  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const close = row.getByTestId('venue-close');
  const submits = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/venue/submit') && submits.push(r.url()));

  // 40 percent, pressed twice in the same moment: one close id, one signature, one order.
  await close.getByRole('textbox').fill('40');
  await close.getByRole('button', { name: 'Close 40%' }).evaluate((b) => {
    b.click();
    b.click();
  });
  await continueInWallet(page);
  await expect(close.getByTestId('venue-close-outcome')).toContainText('Close of 0.04 BTC: Filled on the venue.', { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(wallet.requests).toHaveLength(1);
  expect(submits).toHaveLength(1);
  await expect.poll(async () => (await venueRecord(owner, '/positions')).value[0]?.size, { timeout: 15_000 }).toBe('0.06');

  // The rest.
  await close.getByRole('textbox').fill('100');
  await close.getByRole('button', { name: 'Close 100%' }).click();
  await continueInWallet(page);
  await expect(close).toHaveCount(0, { timeout: 15_000 });
  expect((await venueRecord(owner, '/positions')).value).toEqual([]);

  // The two closes' results, as the venue reports them per fill, are the whole close: their sizes sum to the position.
  const closing = (await venueRecord(owner, '/fills', { since: since() })).value.filter(
    (f) => f.symbol === SYMBOL && f.realisedPnl !== null,
  );
  expect(fromUnits(closing.reduce((t, f) => t + toUnits(f.amount), 0n))).toBe(OPEN.size);
  run.write({ realised: fromUnits(closing.reduce((t, f) => t + toUnits(f.realisedPnl), 0n)) });
  // The ledger posts nothing in this piece (our builder fee earned is posted with the fill record later).
  expect(await (await api(account)).balances()).toEqual(ledgerBefore);
  await expect.poll(async () => toUnits((await shownBalance(page, 'USDC')).used), { timeout: 15_000 }).toBe(0n);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, '0')).toBe(true);
});

test(`${J} #11 opens History: the closed position with its realised result, the venue's fee and our builder fee, from the venue`, async ({
  page,
}) => {
  const { owner } = await desk(page);
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'History' }).click();
  const fills = (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.symbol === SYMBOL);
  const realised = fromUnits(fills.filter((f) => f.realisedPnl !== null).reduce((t, f) => t + toUnits(f.realisedPnl), 0n));
  const venueFees = fromUnits(fills.reduce((t, f) => t + toUnits(f.venueFee), 0n));
  const builderFees = fromUnits(fills.reduce((t, f) => t + toUnits(f.builderFee), 0n));
  expect(realised).toBe(state().realised);
  const closed = page.getByTestId('venue-history').locator(`tr[data-closed="${SYMBOL}"]`);
  await expect(closed).toBeVisible({ timeout: 15_000 });
  expect(sameDecimal(await closed.locator('[data-cell="realised"]').innerText(), realised)).toBe(true);
  expect(sameDecimal(await closed.locator('[data-cell="venue-fees"]').innerText(), venueFees)).toBe(true);
  expect(sameDecimal(await closed.locator('[data-cell="builder-fees"]').innerText(), builderFees)).toBe(true);
  expect(toUnits(builderFees) > 0n).toBe(true);
  for (const f of fills) await expect(page.getByTestId('venue-fills').locator(`tr[data-fill="${f.fillId}"]`)).toBeVisible();
});
