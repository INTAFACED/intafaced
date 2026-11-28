// World: book, restart
import { randomBytes, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { personDoor, totp } from './person-door.mjs';
import { CHAIN_ID, connectWhenAsked, fundOnTestChain, mineTestBlock, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  otherTraderKey,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';
import { signedOnVenue, venueAt, venueNow } from './venue-door.mjs';
import { MINUTE, minuteStart, utcDay } from './clock.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-derivatives-25, in the running app (docs/roadmap/journeys.json): I trade spot and perps from one trading account with
// cross margin. One test per step, titled "J-derivatives-25 #<n>", run in order on one TEST account, on the launch money
// model: the venue holds the trading money, the stack's TEST partner bank holds the spending money
// (`testPartner.set({ custody: 'off' })`), the app shows each as its source reports it, and the ledger posts nothing.
//
// TEST setup in the journey's start (the "starts:" test): one verified TEST person with a TEST browser wallet holding
// TEST ETH for gas on the stack's TEST chain and an empty account on the TEST venue, TEST 1000 USDC in their TEST partner
// account and a TEST card in USDC. Every figure is read from its own source and compared: the venue's record
// (`/balances`, `/fills`), the partner's own book on loopback (`/test-partner`), which the TEST card spends from, and the
// TEST chain. #4 rests the TEST
// BTC-USDC ladder at a TEST price the trading account can pay for, and puts it back after the step.
//
// #9 to #12 (a gap is named, not filled: #5 to #8, switching the account to cross, its collateral and the two positions,
// are not built in this room yet, so they have no test here). #9's TEST setup, not a step: a TEST cross long of 2
// XCRS-PERP (the TEST venue's cross-only perpetual) at 100, bought from a TEST other trader's ask through our door,
// signed by the person's own key; the TEST mark and the TEST ladder (`/test/set-mark`, `/test/ladder-mid`) then move to 110,
// where the close sells into the ladder's bids. Both are put back after the step. The TEST venue pays a withdrawal from its TEST deposit address,
// so #11 funds that address with TEST USD first; the TEST partner credits the wallet's send to the person's TEST pay-in
// address after its confirmations, which #11 mines on the TEST chain.
const J = 'J-derivatives-25';
const PARTNER_USDC = '1000';
const MOVE_IN = '600';
const PARTNER_BANK = 'TEST partner bank';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const SPOT = 'BTC-USDC';
const SPOT_MID = '20000';
const XCRS = 'XCRS-PERP';
const LONG = '2';
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const { state, codeFor, signInNow, door, resetSession, bankGet, bankPost, signAndSend } = personDoor(J, run, test);

/** The partner's own figure for the person's main USDC balance, from its book on loopback (never through our doors). */
async function partnerMain(userId) {
  const rows = (await venueRecord(userId, '/balances', {}, PARTNER_RECORD, null)).value;
  return rows.find((r) => r.asset === 'USDC')?.total ?? '0';
}
/** Every move on the person's record at the TEST partner, as its own book lists it. */
const partnerMoves = async (userId) => (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;

/** The TEST chain's own figure: `token`'s balance of `address`, in its smallest unit. */
async function chainBalance(token, address) {
  const data = `0x70a08231${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
  });
  return BigInt((await res.json()).result);
}
/**
 * The TEST chain's receipt of `hash`, once mined. The chain mines a block a second, so a hash the wallet has just sent can
 * still be pending, with no receipt yet. Still unmined after 30 s fails, naming the hash.
 */
async function receipt(hash) {
  const read = async () => {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
    });
    return (await res.json()).result;
  };
  let mined = null;
  await expect.poll(async () => (mined = await read()), { message: `the TEST chain mines ${hash}`, timeout: 30_000 }).not.toBeNull();
  return mined;
}

// ---- the room ----

async function openAccount(page, { signedIn = false } = {}) {
  const { who, walletKey } = state();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  if (!signedIn) await signInNow(page, who);
  await page.goto('/trade/account');
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(wallet.address.toLowerCase());
  return wallet;
}
const trading = (page) => page.getByTestId('group-trading');
const spending = (page) => page.getByTestId('group-spending');
const tradingRow = (page, asset) => trading(page).locator(`tr[data-asset="${asset}"]`);
const mainRow = (page) => spending(page).locator('tr[data-space="main:USDC"]');
const cellAmount = async (locator) =>
  (await locator.innerText())
    .replace(/,/g, '')
    .replace(/ USDC$/, '')
    .trim();
const ledgerOf = async () => (await door()).balances();

/** Each of the trading group's rows equals the venue's own record for the account, cell by cell. */
async function tradingEqualsVenue(page, owner) {
  const record = (await venueRecord(owner, '/balances')).value;
  for (const b of record) {
    const row = tradingRow(page, b.asset);
    for (const cell of ['free', 'locked', 'total'])
      await expect
        .poll(async () => sameDecimal(await cellAmount(row.locator(`[data-cell="${cell}"]`)), b[cell]), { timeout: 20_000 })
        .toBe(true);
  }
  return record;
}

test(`${J} starts: a verified TEST person with a TEST wallet holding TEST ETH for gas and an empty account on the TEST venue, TEST 1000 USDC in their TEST partner account and a TEST card in USDC`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  const who = await signUp(page, 'jd25');
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.write({ who, walletKey });
  // TEST ETH for the wallet's own gas (and TEST USD of its own, which no group counts).
  fundOnTestChain(owner, 'venue');

  // The partner holds the person's spending money: TEST 1000 USDC, and a TEST card in USDC.
  await bankPost('testPartner.set', { custody: 'off' });
  await bankPost('currencies.add', { assetId: 'USDC' }).catch(() => undefined);
  await bankPost('testPartner.fund', { fundId: `${J}-${who.email}`.slice(0, 64), assetId: 'USDC', amount: PARTNER_USDC });
  const card = await bankPost('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
  const held = await bankGet('cards.partnerHeld', { cardId: card.id, limit: 1 });
  expect(held.heldBy).toBe('partner');
  run.write({ cardId: card.id, panTail: card.panTail, ledger: await ledgerOf(), userId: (await door()).userId });
});

test(`${J} #1 opens /trade/account: two named groups, each with an as-of time: trading (the venue account, free and locked, from the venue; empty) and spending (the partner account and card, from the partner; 1000.00 USDC); the line "Liquidation only ever uses your trading account. Your spending balances are never used."`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner, userId, ledger, panTail } = state();
  await openAccount(page);
  const venueName = (await venueInfo()).displayName;

  // Trading: the venue account as the venue's own record holds it: empty, every asset it lists at 0 (the TEST venue lists
  // USDC at 0.00), each row free, locked and total equal to the record, with the venue named and an as-of time.
  const venueRows = (await venueRecord(owner, '/balances')).value;
  expect(venueRows.filter((b) => toUnits(b.total) !== 0n)).toEqual([]);
  const venueBlock = trading(page).getByTestId('trading-venue');
  await expect(trading(page).getByRole('heading', { name: /^Trading\b/, level: 2 })).toBeVisible({ timeout: 20_000 });
  await expect(venueBlock.locator('tr[data-asset]')).toHaveCount(venueRows.length, { timeout: 20_000 });
  await tradingEqualsVenue(page, owner);
  await expect(venueBlock.getByTestId('trading-source')).toContainText(`From ${venueName} · As of `);
  await expect(venueBlock.getByTestId('trading-source').locator('[data-as-of]')).not.toHaveAttribute('data-as-of', '');

  // Spending: the partner account and the card, each as the partner reports it: TEST 1000.00 USDC, with an as-of time.
  const partnerFigure = await partnerMain(userId);
  expect(sameDecimal(partnerFigure, PARTNER_USDC)).toBe(true);
  await expect(spending(page).getByRole('heading', { name: 'Spending', level: 2, exact: true })).toBeVisible();
  await expect(spending(page).getByTestId('spending-source')).toContainText(`From ${PARTNER_BANK} · As of `);
  await expect(spending(page).getByTestId('spending-source').locator('[data-as-of]')).not.toHaveAttribute('data-as-of', '');
  await expect(mainRow(page).locator('td').first()).toHaveText('USDC account');
  await expect
    .poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), partnerFigure), { timeout: 20_000 })
    .toBe(true);
  // The card's available figure: the TEST partner card spends from the person's partner account (svc-bank
  // cards/partner-card-holds.ts, `drawn`), so its source is the partner's own book, read above.
  const cardFigure = partnerFigure;
  const cardLine = spending(page).getByTestId('spending-card');
  await expect(cardLine).toHaveCount(1);
  await expect(cardLine).toContainText(`Card ending ${panTail}: `);
  await expect(cardLine).toContainText(` USDC available, from ${PARTNER_BANK}`);
  const shown = (await cardLine.innerText()).match(/: ([\d,.]+) USDC available/)?.[1]?.replace(/,/g, '');
  expect(shown, await cardLine.innerText()).toBe('1000.00');
  expect(sameDecimal(shown, cardFigure)).toBe(true);

  // The line on liquidation, and the ledger posts nothing.
  await expect(page.getByTestId('liquidation-line')).toHaveText(
    'Liquidation only ever uses your trading account. Your spending balances are never used.',
  );
  await stepPicture();
  expect(await ledgerOf()).toEqual(ledger);
});

test(`${J} #2 moves TEST 600 USDC from spending into trading, with step-up: the partner's transfer to the wallet, then the wallet's deposit, each with its fee or "not known"; the same move again sends nothing; the ledger posts nothing`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { owner, userId, ledger } = state();
  await signInNow(page, state().who);
  // A retry of this step finds the authenticator its first try added (signInNow then took a code from it): set up once.
  if (!state().secret) {
    const { secret, step } = await addAuthenticator(page, totp);
    run.write({ secret, step });
  }
  resetSession();
  const wallet = await openAccount(page, { signedIn: true });
  const route = (await testVenue('/venue')).body.deposit;
  expect(route?.token, 'the TEST venue publishes its TEST deposit route').toBeTruthy();
  const walletBefore = await chainBalance(route.token, owner);
  const movesBefore = (await partnerMoves(userId)).length;

  const move = page.getByTestId('move-in');
  await move.getByLabel('Amount (USDC)', { exact: true }).fill(MOVE_IN);
  await move.getByRole('button', { name: 'Review move', exact: true }).click();
  const reviewed = move.getByTestId('move-review');
  await expect(reviewed.locator('[data-leg="partner"]')).toHaveText(`${PARTNER_BANK} sends 600.00 USDC to your wallet ${owner}`);
  await expect(reviewed.locator('[data-leg="deposit"]')).toHaveText(
    `Your wallet deposits 600.00 USDC to ${(await venueInfo()).displayName}`,
  );
  // With step-up: a fresh authenticator code for exactly this move.
  const confirm = page.getByTestId('step-up-confirm');
  await expect(confirm.getByLabel('Authenticator code', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await codeFor());
  const asked = wallet.requests.length;
  const sent = wallet.sends.length;
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  // The wallet proves it is the person's (one message), then signs its own deposit (one transaction).
  await continueInWallet(page);
  await continueInWallet(page);
  const result = move.getByTestId('move-result');
  await expect(result).toBeVisible({ timeout: 120_000 });
  expect(wallet.requests.length - asked, 'the wallet signs one proof that it is the person’s').toBe(1);
  expect(wallet.sends.length - sent, 'then sends its own deposit, once').toBe(1);

  const kept = (await bankGet('ownMoves.list', { limit: 10 }))[0];
  expect(kept).toMatchObject({ amount: MOVE_IN, assetId: 'USDC', wallet: owner, status: 'sent', partner: PARTNER_BANK });
  // Leg one: the partner's own move out of the main balance, once, and its transfer on the TEST chain to the wallet.
  const moves = await partnerMoves(userId);
  const mine = moves.filter((m) => m.key === `bank.transfer.own-move:${kept.id}:1`);
  expect(mine).toHaveLength(1);
  expect(sameDecimal(mine[0].amount, MOVE_IN)).toBe(true);
  expect(moves.length - movesBefore).toBe(1);
  const delivered = await receipt(kept.deliveryTx);
  expect(delivered.status).toBe('0x1');
  expect(delivered.from.toLowerCase()).not.toBe(owner);
  // Leg two: the wallet's own transfer to the venue's deposit address, mined, from the wallet.
  const deposited = await receipt(kept.depositTx);
  expect(deposited.status).toBe('0x1');
  expect(deposited.from.toLowerCase()).toBe(owner);
  expect(deposited.to.toLowerCase()).toBe(route.token.toLowerCase());
  // Through the wallet and on: it holds what it held before, the move passed through it.
  expect(await chainBalance(route.token, owner)).toBe(walletBefore);
  // Each leg with its fee or "not known", never 0 invented.
  await expect(result.locator('[data-leg="partner"] [data-fee]')).toHaveText(
    kept.partnerFee === null ? 'Fee: not known' : `Fee: ${Number(kept.partnerFee).toFixed(2)} USDC`,
  );
  await expect(result.locator('[data-leg="deposit"] [data-fee]')).toHaveText('Fee: not known');
  // Spending reads 400.00 less any fee, trading 600.00 less any fee, each from its own source.
  const fee = kept.partnerFee === null ? 0n : toUnits(kept.partnerFee);
  const spendingNow = fromUnits(toUnits(PARTNER_USDC) - toUnits(MOVE_IN) - fee);
  await expect.poll(async () => sameDecimal(await partnerMain(userId), spendingNow), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => sameDecimal((await venueBalance(owner, 'USDC')).total, MOVE_IN), { timeout: 60_000 }).toBe(true);
  // The same move again, from the room: the bank answers the first move, the wallet is not asked, and nothing more moves.
  const askedBefore = wallet.requests.length;
  const sentBefore = wallet.sends.length;
  await result.getByRole('button', { name: 'Send this move again', exact: true }).click();
  await expect(result.getByTestId('move-again-note')).toHaveText('Already sent: nothing more was sent. This is the first result.');
  await expect(result.locator('[data-leg="partner"] [data-tx]')).toHaveAttribute('data-tx', kept.deliveryTx);
  await expect(result.locator('[data-leg="deposit"] [data-tx]')).toHaveAttribute('data-tx', kept.depositTx);
  expect(wallet.requests.length).toBe(askedBefore);
  expect(wallet.sends.length).toBe(sentBefore);
  expect(await bankGet('ownMoves.list', { limit: 10 })).toEqual([kept]);
  expect((await partnerMoves(userId)).length - movesBefore).toBe(1);
  expect(sameDecimal(await partnerMain(userId), spendingNow)).toBe(true);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).total, MOVE_IN)).toBe(true);
  // The groups read their sources again after a reload.
  await page.reload();
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  await expect
    .poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), spendingNow), { timeout: 30_000 })
    .toBe(true);
  await tradingEqualsVenue(page, owner);
  // The ledger posts nothing for the moves.
  expect(await ledgerOf()).toEqual(ledger);
  run.write({ spendingNow, moveId: kept.id });
});

test(`${J} #3 tries to move more than the partner reports free: refused naming the partner's free figure; nothing sent; both groups unchanged`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, userId, ledger } = state();
  const wallet = await openAccount(page);
  const free = await partnerMain(userId);
  const venueBefore = (await venueRecord(owner, '/balances')).value;
  const movesBefore = (await partnerMoves(userId)).length;
  const listedBefore = await bankGet('ownMoves.list', { limit: 10 });
  const over = fromUnits(toUnits(free) + toUnits('0.01'));

  const move = page.getByTestId('move-in');
  await move.getByLabel('Amount (USDC)', { exact: true }).fill(over);
  await move.getByRole('button', { name: 'Review move', exact: true }).click();
  const confirm = page.getByTestId('step-up-confirm');
  await expect(confirm.getByLabel('Authenticator code', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await codeFor());
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  // The wallet proves it is the person's (the message), then the bank refuses before the partner is asked.
  await continueInWallet(page);
  const refusal = move.getByTestId('move-refusal');
  await expect(refusal.locator('[data-refusal-body]')).toHaveText(
    `${PARTNER_BANK} reports ${free} USDC free in your account, so ${over} USDC cannot move. Nothing was sent.`,
    { timeout: 30_000 },
  );
  await expect(refusal.locator('code')).toHaveText('bank.own_move_above_free');
  // Nothing sent: no partner move, no move kept, no deposit asked of the wallet; both groups as their sources still say.
  expect(wallet.sends, 'the wallet sends nothing').toHaveLength(0);
  expect((await partnerMoves(userId)).length).toBe(movesBefore);
  expect(await bankGet('ownMoves.list', { limit: 10 })).toEqual(listedBefore);
  expect(sameDecimal(await partnerMain(userId), free)).toBe(true);
  expect((await venueRecord(owner, '/balances')).value).toEqual(venueBefore);
  await expect
    .poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), free), { timeout: 20_000 })
    .toBe(true);
  await tradingEqualsVenue(page, owner);
  expect(await ledgerOf()).toEqual(ledger);
});

test(`${J} #4 buys TEST 0.01 BTC on the venue's spot market (BTC-USDC, on this file's own TEST venue) from the trading account: the fill shows in the trading group only, USDC down by the cost and fee, BTC up 0.01, from the venue; spending unchanged`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, userId, ledger } = state();
  const book = (await testVenue('/book', { symbol: SPOT, depth: 1 })).body.value;
  const mid = fromUnits((toUnits(book.bids[0].price) + toUnits(book.asks[0].price)) / 2n);
  // TEST: the BTC-USDC ladder rests around a TEST price the 600 USDC trading account can pay 0.01 BTC and its fee at.
  expect((await testVenue('/test/ladder-mid', { symbol: SPOT, price: SPOT_MID })).status).toBe(200);
  try {
    const before = Object.fromEntries((await venueRecord(owner, '/balances')).value.map((b) => [b.asset, b]));
    const spendingBefore = await partnerMain(userId);
    const since = new Date(Date.now() - 1_000).toISOString();
    const ask = (await testVenue('/book', { symbol: SPOT, depth: 1 })).body.value.asks[0];
    // The person's own key signs the buy through our venue door: a TEST market buy of 0.01 BTC, IOC, a whole USDC price (a multiple of the market's tick) inside 0.4% of the ask (the venue door's price protection is 50 bps).
    await signAndSend(
      {
        kind: 'place_order',
        symbol: SPOT,
        side: 'buy',
        type: 'market',
        amount: '0.01',
        price: fromUnits(((toUnits(ask.price) * 1004n) / 1000n / toUnits('1')) * toUnits('1')),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${owner}:${J}:spot-buy`,
      },
      `order:${owner}:${J}:spot-buy`,
    );
    const fillsOf = async () => (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === SPOT);
    await expect.poll(async () => (await fillsOf()).reduce((s, f) => s + toUnits(f.amount), 0n), { timeout: 20_000 }).toBe(toUnits('0.01'));
    const fills = await fillsOf();
    const cost = fills.reduce((s, f) => s + (toUnits(f.amount) * toUnits(f.price)) / toUnits('1'), 0n);
    // The venue's own fee and builder fee on each fill, in the asset the venue charged it in.
    const feeIn = (asset) =>
      fills.filter((f) => f.feeAsset === asset).reduce((s, f) => s + toUnits(f.venueFee) + toUnits(f.builderFee ?? '0'), 0n);
    expect(
      fills.every((f) => f.feeAsset === 'USDC' || f.feeAsset === 'BTC'),
      JSON.stringify(fills),
    ).toBe(true);
    const after = Object.fromEntries((await venueRecord(owner, '/balances')).value.map((b) => [b.asset, b]));
    // The venue's own record: USDC down by the cost and the fee, BTC up 0.01 (less a fee the venue took in BTC).
    expect(toUnits(before.USDC.total) - toUnits(after.USDC.total)).toBe(cost + feeIn('USDC'));
    expect(toUnits(after.BTC.total) - toUnits(before.BTC?.total ?? '0')).toBe(toUnits('0.01') - feeIn('BTC'));

    await openAccount(page);
    // The trading group shows exactly the venue's record, BTC included.
    await expect(tradingRow(page, 'BTC')).toBeVisible({ timeout: 20_000 });
    await tradingEqualsVenue(page, owner);
    // Spending unchanged, as the partner reports it, and no fill line anywhere in it.
    expect(sameDecimal(await partnerMain(userId), spendingBefore)).toBe(true);
    await expect.poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), spendingBefore)).toBe(true);
    await expect(spending(page).locator('tr[data-space*="BTC"]')).toHaveCount(0);
    await expect(spending(page)).not.toContainText('BTC');
    expect(await ledgerOf()).toEqual(ledger);
  } finally {
    await testVenue('/test/ladder-mid', { symbol: SPOT, price: mid });
  }
});

// ---- #9 to #12: profit, and the move back out to spending ----

const setMark = (price) => venueAt('/test/set-mark', { symbol: XCRS, price });
const summaryOf = async (owner) => (await venueRecord(owner, '/account-summary')).value;
const usdcOf = async (owner) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };
const payIns = (moves) => moves.filter((m) => m.key.startsWith('bank.pay-in:'));

test(`${J} #9 closes the long at a TEST profit: the venue credits the realised profit to the trading account once; free margin rises by what the venue reports`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner, userId, ledger } = state();
  const venue = await venueNow();
  const tag = randomBytes(4).toString('hex');
  const spendingBefore = await partnerMain(userId);
  let ladderMid = null;
  // TEST setup, not this step: a TEST other trader, cross on XCRS-PERP, resting an ask of 2 at 100; the person's cross
  // long of 2 at 100 through our door, our builder fee approved first, each signed by the person's own key.
  await setMark('100');
  try {
    const other = otherTraderKey(`${J}-${runId}-${tag}`);
    await testDeposit(other.address.toLowerCase(), 'USDC', '100000', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
    const cross = { kind: 'update_leverage', symbol: XCRS, leverageBps: 200_000, marginMode: 'cross' };
    await signedOnVenue(venue, other, cross);
    const order = (side, price, key) => ({
      kind: 'place_order',
      symbol: XCRS,
      side,
      type: 'limit',
      amount: LONG,
      price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:${tag}:${key}`,
      builderFee: null,
    });
    await signedOnVenue(venue, other, order('sell', '100', 'ask'));
    // A market listed a moment ago may not be in the door's list yet: the same action, under the same key, until it takes it.
    await expect(() => signAndSend(cross, `leverage:${owner}:${XCRS}:cross`)).toPass({ timeout: 30_000, intervals: [2_000] });
    const builder = (await (await door()).get('/api/v1/venue/status')).body.builder;
    if (builder)
      await signAndSend(
        { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
        `builder-approval:${owner}:${venue.id}:${builder.address}:${builder.feeBps}`,
      );
    const openKey = `order:${owner}:${J}:${tag}:open`;
    await signAndSend({ ...order('buy', '100', 'open'), timeInForce: 'IOC', clientOrderKey: openKey }, openKey);
    const position = (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === XCRS);
    expect(position).toMatchObject({ side: 'long', marginMode: 'cross' });
    expect(sameDecimal(position.size, LONG)).toBe(true);
    // The TEST market moves to 110: its mark, and the TEST ladder's bids and asks around it.
    const book = (await testVenue('/book', { symbol: XCRS, depth: 1 })).body.value;
    ladderMid = fromUnits((toUnits(book.bids[0].price) + toUnits(book.asks[0].price)) / 2n);
    await setMark('110');
    expect((await testVenue('/test/ladder-mid', { symbol: XCRS, price: '110' })).status).toBe(200);
    const before = await summaryOf(owner);
    const usdcBefore = await usdcOf(owner);
    const since = new Date(Date.now() - 1_000).toISOString();

    // The step: the person closes the long, signed by their own key through our door.
    const closeKey = `order:${owner}:${J}:${tag}:close`;
    await signAndSend({ ...order('sell', '109', 'close'), timeInForce: 'IOC', reduceOnly: true, clientOrderKey: closeKey }, closeKey);
    await expect.poll(async () => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === XCRS) ?? null).toBeNull();
    // The close's own fills: the ones the venue reports a realised result on (the open's has none).
    const closing = (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === XCRS && f.realisedPnl !== null);
    expect(closing.length).toBeGreaterThan(0);
    const realised = closing.reduce((sum, f) => sum + toUnits(f.realisedPnl ?? '0'), 0n);
    const fees = closing.reduce((sum, f) => sum + toUnits(f.venueFee) + toUnits(f.builderFee ?? '0'), 0n);
    // The venue's realised profit is each close fill's price above the entry of 100, times its size: a TEST profit.
    const expected = closing.reduce((sum, f) => sum + ((toUnits(f.price) - toUnits('100')) * toUnits(f.amount)) / toUnits('1'), 0n);
    expect(fromUnits(realised)).toBe(fromUnits(expected));
    expect(realised > 0n).toBe(true);
    // Credited once: the trading account's USDC rose by the profit less the close's fees, as the venue reports it, and a
    // later read holds the same.
    const usdcAfter = await usdcOf(owner);
    expect(toUnits(usdcAfter.total) - toUnits(usdcBefore.total)).toBe(realised - fees);
    const after = await summaryOf(owner);
    expect(toUnits(after.free) > toUnits(before.free), `free ${before.free} → ${after.free}`).toBe(true);

    // The room: the trading group and the free margin equal the venue's own figures; spending is unchanged.
    await openAccount(page);
    await tradingEqualsVenue(page, owner);
    const free = trading(page).getByTestId('free-margin');
    await expect(free).toHaveAttribute('data-value', after.free, { timeout: 30_000 });
    await expect(free).toContainText(`Free margin: ${after.free} USDC, from ${venue.name} · As of `);
    await expect(free.locator('[data-as-of]')).not.toHaveAttribute('data-as-of', '');
    expect(await usdcOf(owner)).toEqual(usdcAfter);
    expect(sameDecimal(await partnerMain(userId), spendingBefore)).toBe(true);
    await expect
      .poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), spendingBefore), { timeout: 20_000 })
      .toBe(true);
    await stepPicture();
    expect(await ledgerOf()).toEqual(ledger);
    run.write({ closeFills: closing.map((f) => f.fillId) });
  } finally {
    if (ladderMid) await testVenue('/test/ladder-mid', { symbol: XCRS, price: ladderMid });
    await setMark('100');
  }
});

test(`${J} #10 tries to move out more than the venue lets leave: refused naming the venue's withdrawable figure; nothing sent`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, userId, ledger } = state();
  const venueName = (await venueInfo()).displayName;
  const wallet = await openAccount(page);
  const { withdrawable } = await summaryOf(owner);
  expect(toUnits(withdrawable) > 0n, `the venue reports ${withdrawable} withdrawable`).toBe(true);
  const balancesBefore = (await venueRecord(owner, '/balances')).value;
  const spendingBefore = await partnerMain(userId);
  const movesBefore = (await partnerMoves(userId)).length;
  const out = page.getByTestId('move-out');
  await expect(out.getByTestId('move-out-withdrawable')).toHaveAttribute('data-value', withdrawable, { timeout: 30_000 });
  await expect(out.getByTestId('move-out-withdrawable')).toHaveText(
    `${venueName} lets ${withdrawable} USDC leave your trading account now, as it reports it.`,
  );

  const over = fromUnits(toUnits(withdrawable) + toUnits('0.01'));
  await out.getByLabel('Amount to move out (USDC)', { exact: true }).fill(over);
  await out.getByRole('button', { name: 'Review move out', exact: true }).click();
  const refusal = out.getByTestId('move-out-refusal');
  await expect(refusal.locator('[data-refusal-body]')).toHaveText(
    `${venueName} lets at most ${withdrawable} USDC leave your trading account now. Nothing was sent.`,
  );
  await expect(refusal.locator('code')).toHaveText('trade.move_out_above_withdrawable');
  // Nothing sent: no step-up asked, nothing signed or sent by the wallet, the venue and the partner as they were.
  await expect(page.getByTestId('step-up-confirm')).toHaveCount(0);
  expect(wallet.requests, 'the wallet is asked nothing').toHaveLength(0);
  expect(wallet.sends, 'the wallet sends nothing').toHaveLength(0);
  expect((await venueRecord(owner, '/balances')).value).toEqual(balancesBefore);
  expect((await summaryOf(owner)).withdrawable).toBe(withdrawable);
  expect((await partnerMoves(userId)).length).toBe(movesBefore);
  expect(sameDecimal(await partnerMain(userId), spendingBefore)).toBe(true);
  expect(await ledgerOf()).toEqual(ledger);
});

test(`${J} #11 moves exactly that to spending: a signed venue withdrawal to the wallet, then a signed send to the partner account, each leg shown once with its fee or "not known"; the partner account and the card show the money available to spend, from the partner`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const { owner, userId, ledger, cardId, panTail } = state();
  const venueName = (await venueInfo()).displayName;
  // TEST setup, not this step: the TEST venue pays withdrawals from its TEST deposit address, funded with TEST USD.
  const route = (await testVenue('/venue')).body.deposit;
  expect(route?.address, 'the TEST venue publishes its TEST deposit address').toBeTruthy();
  for (let i = 0; i < 4; i += 1) fundOnTestChain(route.address, 'venue');
  await signInNow(page, state().who);
  resetSession();
  const wallet = await openAccount(page, { signedIn: true });
  const { withdrawable } = await summaryOf(owner);
  const usdcBefore = await usdcOf(owner);
  const spendingBefore = await partnerMain(userId);
  const payInsBefore = payIns(await partnerMoves(userId)).length;
  const summary = await bankGet('payYourself.summary');
  expect(summary.payIn).toMatchObject({ label: 'TEST', token: expect.any(String), address: expect.any(String) });
  const walletBefore = await chainBalance(summary.payIn.token, owner);

  const out = page.getByTestId('move-out');
  await expect(out.getByTestId('move-out-withdrawable')).toHaveAttribute('data-value', withdrawable, { timeout: 30_000 });
  await out.getByLabel('Amount to move out (USDC)', { exact: true }).fill(withdrawable);
  await out.getByRole('button', { name: 'Review move out', exact: true }).click();
  const reviewed = out.getByTestId('move-out-review');
  await expect(reviewed.locator('[data-leg="withdrawal"]')).toContainText(`${venueName} withdraws `);
  await expect(reviewed.locator('[data-leg="withdrawal"]')).toContainText(` USDC to your wallet ${owner}`);
  await expect(reviewed.locator('[data-leg="send"]')).toHaveText(
    `Your wallet sends what arrives, in USDC, to your account at ${PARTNER_BANK}`,
  );
  const confirm = page.getByTestId('step-up-confirm');
  await expect(confirm.getByLabel('Authenticator code', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await codeFor());
  const asked = wallet.requests.length;
  const sent = wallet.sends.length;
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  // Leg one: the wallet signs the venue withdrawal to itself.
  await continueInWallet(page);
  // Leg two, once the venue paid: the wallet sends what arrived to the partner.
  await expect(out.getByText(`Confirm the send to ${PARTNER_BANK} in your wallet.`, { exact: true })).toBeVisible({ timeout: 120_000 });
  await continueInWallet(page);
  await expect(out.getByText(`Waiting for ${PARTNER_BANK} to credit it…`, { exact: true })).toBeVisible({ timeout: 60_000 });
  for (let i = 0; i < summary.payIn.confirmations; i += 1) await mineTestBlock();
  await expect(out.getByTestId('move-out-done')).toHaveText(
    `Done: ${PARTNER_BANK} reports the money in your account, available to spend.`,
    { timeout: 120_000 },
  );
  expect(wallet.requests.length - asked, 'the wallet signs the withdrawal once').toBe(1);
  expect(wallet.sends.length - sent, 'and sends on to the partner once').toBe(1);

  // Leg one, as the venue reports it: one withdrawal of exactly the withdrawable figure to the wallet, done, with its fee.
  const legs = out.getByTestId('move-out-legs');
  const nonce = await legs.locator('[data-leg="withdrawal"]').getAttribute('data-nonce');
  const w = (await venueRecord(owner, '/withdrawal', { nonce })).value;
  expect(w).toMatchObject({ status: 'done', asset: 'USDC', destination: owner });
  expect(sameDecimal(w.amount, withdrawable)).toBe(true);
  expect(w.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(legs.locator('[data-leg="withdrawal"] [data-tx]')).toHaveAttribute('data-tx', w.txHash);
  await expect(legs.locator('[data-leg="withdrawal"] [data-fee]')).toHaveText(
    w.fee.known ? `Fee: ${Number(w.fee.value).toFixed(2)} USDC` : 'Fee: not known',
  );
  await expect(legs.locator('[data-leg="withdrawal"] [data-network-fee]')).toHaveText(
    w.networkFee.known ? `Network fee: ${Number(w.networkFee.value).toFixed(2)} USDC` : 'Network fee: not known',
  );
  // The venue took the amount and its fee from the trading account, once.
  const fee = w.fee.known ? toUnits(w.fee.value) : 0n;
  expect(toUnits(usdcBefore.total) - toUnits((await usdcOf(owner)).total)).toBe(toUnits(withdrawable) + fee);
  // Leg two: the wallet's own transfer of what arrived to its pay-in address at the partner, mined, from the wallet.
  expect(w.networkFee.known).toBe(true);
  const arrives = fromUnits(toUnits(w.amount) - toUnits(w.networkFee.value));
  const tx = await legs.locator('[data-leg="send"] [data-tx]').getAttribute('data-tx');
  const forwarded = await receipt(tx);
  expect(forwarded.status).toBe('0x1');
  expect(forwarded.from.toLowerCase()).toBe(owner);
  expect(forwarded.to.toLowerCase()).toBe(summary.payIn.token.toLowerCase());
  // Through the wallet and on: it holds what it held before.
  expect(await chainBalance(summary.payIn.token, owner)).toBe(walletBefore);
  const partnerFee = (await bankGet('payYourself.summary')).partnerFee;
  const sendLine = legs.locator('[data-leg="send"]');
  await expect(sendLine).toContainText(` USDC to your account at ${PARTNER_BANK}`);
  await expect
    .poll(async () =>
      sameDecimal((await sendLine.innerText()).match(/^Your wallet sends ([\d,.]+) USDC/)?.[1]?.replace(/,/g, '') ?? '', arrives),
    )
    .toBe(true);
  await expect(legs.locator('[data-leg="send"] [data-fee]')).toHaveText(
    partnerFee === null ? 'Fee: not known' : `Fee: ${Number(partnerFee).toFixed(2)} USDC`,
  );
  // The partner credited it once, by the transfer's own key, on its own book, and reports it available.
  const credited = payIns(await partnerMoves(userId));
  expect(credited.length - payInsBefore).toBe(1);
  const credit = credited.find((m) => m.key === `bank.pay-in:usdc:${CHAIN_ID}:${tx}:0`);
  expect(credit, JSON.stringify(credited)).toBeTruthy();
  expect(sameDecimal(credit.amount, arrives)).toBe(true);
  const spendingNow = fromUnits(toUnits(spendingBefore) + toUnits(arrives));
  expect(sameDecimal(await partnerMain(userId), spendingNow)).toBe(true);
  // The room: the partner account and the card show the money, from the partner.
  await expect
    .poll(async () => sameDecimal(await cellAmount(mainRow(page).locator('[data-cell="balance"]')), spendingNow), { timeout: 30_000 })
    .toBe(true);
  const card = await bankGet('cards.partnerHeld', { cardId, limit: 1 });
  expect(sameDecimal(card.figures.available, spendingNow)).toBe(true);
  const cardLine = spending(page).getByTestId('spending-card');
  await expect(cardLine).toContainText(`Card ending ${panTail}: `);
  await expect
    .poll(
      async () => sameDecimal((await cardLine.innerText()).match(/: ([\d,.]+) USDC available/)?.[1]?.replace(/,/g, '') ?? '', spendingNow),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  await expect(cardLine).toContainText(` USDC available, from ${PARTNER_BANK}`);
  await stepPicture();
  // The ledger posts nothing for the move.
  expect(await ledgerOf()).toEqual(ledger);
  run.write({ outNonce: nonce, outWithdrawalTx: w.txHash, outSendTx: tx, outCreditKey: credit.key, outAt: Date.now() });
});

test(`${J} #12 opens the trading account statement: every move, fill and fee with its venue, chain or partner reference; nothing labelled as an INTAFACED balance`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner, ledger, moveId, closeFills, outWithdrawalTx, outSendTx, outCreditKey, outAt } = state();
  const venueName = (await venueInfo()).displayName;
  // A statement that ends today ends at the last whole minute that has been over for a minute: wait until that end is
  // past #11's move, so every move is inside the range.
  await expect.poll(() => minuteStart(Date.now() - MINUTE), { timeout: 130_000, intervals: [1000] }).toBeGreaterThan(outAt);
  const moveIn = (await bankGet('ownMoves.list', { limit: 10 })).find((m) => m.id === moveId);
  expect(moveIn).toBeTruthy();
  const from = utcDay(Date.parse(moveIn.createdAt));
  const today = utcDay(Date.now());
  const fills = (await venueRecord(owner, '/fills', { since: `${from}T00:00:00.000Z` })).value;
  expect(fills.map((f) => f.fillId)).toEqual(expect.arrayContaining(closeFills));

  await openAccount(page);
  const statement = page.getByTestId('trading-statement');
  await statement.getByLabel('From', { exact: true }).fill(from);
  await statement.getByLabel('To (included)', { exact: true }).fill(today);
  const asked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/statements' && r.request().method() === 'POST');
  await statement.getByRole('button', { name: 'Make statement', exact: true }).click();
  const job = await (await asked).json();
  expect(job).toMatchObject({ status: 'finished', owner });
  const entries = statement.getByTestId('statement-entries');
  await expect(entries).toBeVisible({ timeout: 30_000 });
  const row = (record, ref) => entries.locator(`tr[data-record="${record}"][data-ref="${ref}"]`);

  // Every fill, with the venue's fill id and its fee, from the venue.
  for (const f of fills) {
    const r = row('trade', f.fillId);
    await expect(r).toHaveCount(1);
    await expect(r.locator('[data-cell="source"]')).toHaveText(venueName);
    const shownFee = (await r.locator('[data-cell="fee"]').innerText()).split(' ');
    expect(sameDecimal(shownFee[0], fromUnits(toUnits(f.venueFee) + toUnits(f.builderFee ?? '0')))).toBe(true);
    expect(shownFee[1]).toBe(f.feeAsset);
  }
  // The move in: the partner's send to the wallet with the partner's reference and its chain transaction, and the
  // venue's credit of the wallet's deposit with the venue's reference.
  const partnerLeg = entries.locator(`tr[data-record="partner_to_wallet"]`);
  await expect(partnerLeg).toHaveCount(1);
  await expect(partnerLeg).toHaveAttribute('data-ref', moveIn.partnerRef ?? moveIn.id);
  await expect(partnerLeg.locator('[data-cell="chain"]')).toHaveText(moveIn.deliveryTx);
  await expect(partnerLeg.locator('[data-cell="source"]')).toHaveText(PARTNER_BANK);
  await expect(partnerLeg.locator('[data-cell="fee"]')).toHaveText(moveIn.partnerFee === null ? 'not known' : `${moveIn.partnerFee} USDC`);
  const deposits = entries.locator('tr[data-record="deposit"]');
  await expect(deposits).toHaveCount(1);
  await expect
    .poll(async () => sameDecimal((await deposits.locator('[data-cell="amount"]').innerText()).split(' ')[0], MOVE_IN))
    .toBe(true);
  await expect(deposits.locator('[data-cell="source"]')).toHaveText(venueName);
  await expect(deposits).toHaveAttribute('data-ref', /.+/);
  // The move out: the venue's withdrawal by the chain transaction that paid it, with its fee or "not known", and the
  // wallet's send to the partner with the partner's credit key and its chain transaction.
  const out = row('withdrawal', outWithdrawalTx);
  await expect(out).toHaveCount(1);
  await expect(out.locator('[data-cell="chain"]')).toHaveText(outWithdrawalTx);
  await expect(out.locator('[data-cell="source"]')).toHaveText(venueName);
  await expect(out.locator('[data-cell="fee"]')).not.toHaveText('');
  const payIn = row('wallet_to_partner', outCreditKey);
  await expect(payIn).toHaveCount(1);
  await expect(payIn.locator('[data-cell="chain"]')).toHaveText(outSendTx);
  await expect(payIn.locator('[data-cell="source"]')).toHaveText(PARTNER_BANK);
  // Nothing labelled as an INTAFACED balance.
  await expect(statement).not.toContainText('INTAFACED');
  await expect(statement).not.toContainText(/balance/i);
  await stepPicture();
  // The file the job fingerprinted lists the venue's side the same: each fill and the withdrawal by their references.
  expect(sameDecimal(String(job.rows.trades), String(fills.length))).toBe(true);
  expect(await (await door()).balances()).toEqual(ledger);
});
