// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-portfolio-04 #2 on the person's own venue account (docs/roadmap/journeys.json; project-state operation-zero/modules/
// portfolio/acceptance/journeys.md), in the running app against the stack's TEST venue simulator: "Moves 1 TEST BTC from
// the main venue account to a venue sub-account, signing the venue transfer" / "The lot keeps its acquired date and basis
// and shows in the sub-account's list". The other steps are J-portfolio-04.pw.mjs's. Every figure is TEST, and every
// expected figure is a hand count from the venue's own fills, never from the lot book. The door is on for this file only.
const J = 'J-portfolio-04';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
const SUB_NAME = 'TEST cold';
/** Two TEST buys of 0.6 BTC at two TEST prices, each from a sell the other TEST trader rests just above the venue's bids. */
const BUYS = [
  { amount: '0.6', price: '59991' },
  { amount: '0.6', price: '59995' },
];
const MOVE = '1';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');
const SCALE = 10n ** 18n;

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units) {
  const abs = units < 0n ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  return `${units < 0n ? '−' : ''}$${(rounded / 10n ** BigInt(places)).toLocaleString('en-US')}.${frac}`;
}

/**
 * Each BTC lot a venue buy opened, by hand from the venue's own fill: the coins received (less a fee taken in BTC) at
 * what was paid for them (price times amount, rounded up as the venue settles it, plus a fee taken in USDC). Oldest first.
 */
function lotsByHand(fills) {
  return fills
    .filter((f) => f.symbol === SYMBOL && f.side === 'buy')
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt) || a.fillId.localeCompare(b.fillId))
    .map((f) => {
      const fee = toUnits(f.venueFee) + toUnits(f.builderFee);
      const product = toUnits(f.price) * toUnits(f.amount);
      const notional = (product + SCALE - 1n) / SCALE;
      return {
        fillId: f.fillId,
        filledAt: f.filledAt,
        qty: toUnits(f.amount) - (f.feeAsset === 'BTC' ? fee : 0n),
        cost: notional + (f.feeAsset === 'USDC' ? fee : 0n),
      };
    });
}

/** FIFO by hand, as the lot engine carries a move: the oldest lot first, each part at its share of that lot's cost. */
function carriedByHand(lots, amount) {
  const parts = [];
  let left = amount;
  for (const lot of lots) {
    if (left === 0n) break;
    const take = left < lot.qty ? left : lot.qty;
    parts.push({ fillId: lot.fillId, filledAt: lot.filledAt, qty: take, cost: take === lot.qty ? lot.cost : (lot.cost * take) / lot.qty });
    left -= take;
  }
  return parts;
}

/** A lot's acquired time as the lots list writes a date and time on this device (Pnl.tsx `stamp`). */
const writtenTime = (page, iso) =>
  page.evaluate((at) => {
    const text = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(Date.parse(at))
      .replace(',', '');
    return `${text.slice(0, text.lastIndexOf(' '))}, ${text.slice(text.lastIndexOf(' ') + 1)}`;
  }, iso);

/** The venue's own record of one account (the main account, or a sub-account of it). */
async function venueOf(owner, subAccount, path, extra = {}) {
  const { id } = await venueInfo();
  const { status, body } = await testVenue(path, { account: { venueId: id, owner, subAccount }, ...extra });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.value;
}
const btcOf = async (owner, subAccount) =>
  toUnits((await venueOf(owner, subAccount, '/balances')).find((b) => b.asset === 'BTC')?.total ?? '0');

/**
 * TEST setup, not a journey step: a verified account, this run's TEST wallet key, and TEST USDC in its venue account by
 * the TEST venue's deposit control (keyed by a chain-transfer-shaped reference, so a replay credits nothing).
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'pf4v');
    await verify(page, account);
    const walletKey = testWalletKey();
    run.reset({ account, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    const ref = `84532:0x${randomBytes(32).toString('hex')}:0`;
    expect(await testDeposit(owner, 'USDC', '80000', ref)).toBe(true);
    const venue = await venueBalance(owner, 'USDC');
    expect(sameDecimal(venue.free, '80000')).toBe(true);
  } finally {
    await page.close();
  }
});

test(`${J} #2 moves 1 TEST BTC from the main venue account to a venue sub-account, signing the venue transfer: each lot keeps its acquired date and basis and shows in the sub-account's list`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const owner = wallet.address.toLowerCase();
  const { id: venueId } = await venueInfo();

  // TEST setup on the desk: two signed TEST buys at two prices, each against a TEST sell the other trader rests first.
  const seller = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(seller).address),
    asset: 'BTC',
    amount: '10',
    depositRef: `seed:${seller}:BTC`,
  });
  for (const [i, buy] of BUYS.entries()) {
    const rested = await otherTraderRun(seller, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'sell',
      type: 'limit',
      amount: buy.amount,
      price: buy.price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${seller}:pf4-ask-${i}`,
      builderFee: null,
    });
    expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Buy', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('textbox', { name: 'Price' }).fill(buy.price);
    await ticket.getByRole('textbox', { name: 'Amount (BTC)' }).fill(buy.amount);
    await ticket.getByRole('button', { name: 'Review buy' }).click();
    const sheet = page.getByTestId('venue-review');
    await sheet.getByRole('button', { name: 'Confirm and sign' }).click();
    await continueInWallet(page);
    await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.');
    await sheet.getByRole('button', { name: 'Back' }).click();
  }
  const fills = await venueOf(owner, null, '/fills', { since: new Date(0).toISOString() });
  const lots = lotsByHand(fills);
  expect(lots).toHaveLength(2);
  const expected = carriedByHand(lots, toUnits(MOVE));
  const mainBefore = await btcOf(owner, null);
  expect(mainBefore).toBe(lots.reduce((sum, lot) => sum + lot.qty, 0n));

  // Profit and loss before the move: the venue account's lots, each with its acquired time and cost.
  const client = await api(s.account);
  const MAIN = `venue:${venueId}:${owner}`;
  await page.goto('/money/pnl?asset=BTC');
  const lotsRegion = page.getByRole('region', { name: 'Lots' });
  await expect(lotsRegion.locator(`tbody tr td[data-venue="${MAIN}"]`)).toHaveCount(2, { timeout: 30_000 });
  const before = [];
  for (const lot of lots) {
    const row = lotsRegion.locator('tbody tr', { has: page.locator(`td[data-venue="${MAIN}"]`) }).nth(before.length);
    await expect(row.locator('[data-col="cost"]')).toHaveText(usd(lot.cost));
    await expect(row.locator('th')).toHaveText(await writtenTime(page, lot.filledAt));
    before.push({ id: await row.getAttribute('data-lot'), acquired: await row.locator('th').innerText() });
  }

  // Open the sub-account on the desk, signed in the wallet on the main account.
  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  // The wallet this page connected stays connected across the page's own navigation; connect it again only if it is not.
  const address = page.getByTestId('venue-wallet-address');
  const connect = page.getByRole('button', { name: 'Connect TEST Wallet' });
  await expect(address.or(connect)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) await connect.click();
  await expect(address).toHaveText(wallet.address);
  const panel = page.getByTestId('venue-sub-accounts');
  await panel.getByLabel('Name for a new sub-account').fill(SUB_NAME);
  await panel.getByRole('button', { name: 'Open sub-account' }).click();
  await continueInWallet(page);
  await expect(panel.getByTestId('venue-outcome')).toContainText('The venue accepted it.');
  const subs = await venueOf(owner, null, '/sub-accounts');
  const sub = subs.find((x) => x.name === SUB_NAME);
  expect(sub, JSON.stringify(subs)).toBeTruthy();
  const subAccount = sub.subAccount;

  // Move 1 TEST BTC into it: the wallet signs the venue transfer, once.
  const signedBefore = wallet.requests.length;
  await panel.getByLabel('Sub-account', { exact: true }).selectOption(subAccount);
  await panel.getByLabel('Coin to move', { exact: true }).selectOption('BTC');
  await panel.getByLabel('Amount to move', { exact: true }).fill(MOVE);
  await panel.getByRole('button', { name: 'Move to sub-account' }).click();
  await continueInWallet(page);
  await expect(panel.getByTestId('venue-outcome')).toContainText('The venue accepted it.');
  // What the wallet signed is the venue transfer itself, on the main account: 1 BTC into this sub-account.
  expect(wallet.requests.length - signedBefore).toBe(1);
  const signedMove = JSON.parse(wallet.requests.at(-1).params[1]).message;
  expect(signedMove).toMatchObject({ owner, subAccount: '', signer: owner, signerRole: 'owner', kind: 'sub_account_transfer' });
  expect(JSON.parse(signedMove.payload)).toMatchObject({
    kind: 'sub_account_transfer',
    subAccount,
    direction: 'into_sub_account',
    asset: 'BTC',
    amount: MOVE,
  });
  // The venue's own record: 1 BTC left the main account and reached the sub-account; nothing left the venue.
  expect(await btcOf(owner, subAccount)).toBe(toUnits(MOVE));
  expect(await btcOf(owner, null)).toBe(mainBefore - toUnits(MOVE));
  await expect(panel.locator(`[data-sub-account="${subAccount}"] tr[data-asset="BTC"] [data-cell="total"]`)).toHaveText(MOVE);

  // Profit and loss: the sub-account's list shows each lot that moved, with the acquired date and basis it had.
  const SUB = `venue:${venueId}:${owner}:${subAccount}`;
  await page.goto('/money/pnl?asset=BTC');
  await lotsRegion.getByLabel('Account for lots').selectOption(SUB);
  await expect.poll(() => new URL(page.url()).searchParams.get('account')).toBe(SUB);
  const rows = lotsRegion.locator('tbody tr');
  await expect(rows).toHaveCount(expected.length, { timeout: 30_000 });
  for (const [i, part] of expected.entries()) {
    const row = rows.nth(i);
    const from = before[lots.findIndex((lot) => lot.fillId === part.fillId)];
    await expect(row.locator('th')).toHaveText(from.acquired);
    await expect(row).toHaveAttribute('data-source', 'trade');
    await expect(row.locator('[data-col="account"]')).toHaveAttribute('data-venue', SUB);
    await expect(row.locator('[data-col="account"]')).toContainText('Your venue sub-account');
    await expect(row.locator('[data-col="account"] [data-label="carried"]')).toContainText('Moved between your accounts');
    await expect(row.locator('[data-col="qty"]')).toHaveText(fromUnits(part.qty));
    await expect(row.locator('[data-col="cost"]')).toHaveText(usd(part.cost));
    await expect(row.locator('[data-col="cost-left"]')).toHaveText(usd(part.cost));
  }
  await expect(lotsRegion).toContainText('Moving coins between your venue account and your own venue sub-account is not a sale.');

  // The service's own figures say the same, to the unit: each carried lot names the lot it left and keeps its time, and
  // the main account keeps exactly what did not move, at the rest of its cost. A move is not a sale.
  const { status, body } = await client.get('/api/tax/trpc/lotBook');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  const book = body.result.data;
  expect(book.method).toBe('FIFO');
  const carried = book.lots.filter((lot) => lot.venueAccount === SUB && lot.assetId === 'BTC');
  expect(carried.map((lot) => [lot.carriedFrom.lotId, lot.acquiredAt, toUnits(lot.qty), toUnits(lot.costUsd)])).toEqual(
    expected.map((part) => [
      before[lots.findIndex((lot) => lot.fillId === part.fillId)].id,
      new Date(part.filledAt).toISOString(),
      part.qty,
      part.cost,
    ]),
  );
  const kept = book.lots.filter((lot) => lot.venueAccount === MAIN && lot.assetId === 'BTC');
  const keptLeft = kept.reduce((sum, lot) => sum + toUnits(lot.remaining), 0n);
  const keptCost = kept.reduce((sum, lot) => sum + toUnits(lot.remainingCostUsd), 0n);
  expect(keptLeft).toBe(mainBefore - toUnits(MOVE));
  expect(keptCost + expected.reduce((sum, part) => sum + part.cost, 0n)).toBe(lots.reduce((sum, lot) => sum + lot.cost, 0n));
  expect(book.sales.filter((sale) => sale.venueAccount === MAIN || sale.venueAccount === SUB)).toEqual([]);
  expect(book.residuals).not.toContain('tax.lot_book_unreconciled');
});
