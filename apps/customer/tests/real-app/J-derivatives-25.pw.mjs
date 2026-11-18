// World: book, restart
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { personDoor, totp } from './person-door.mjs';
import { CHAIN_ID, connectWhenAsked, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { continueInWallet, sameDecimal, testVenue, venueBalance, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-derivatives-25, in the running app (docs/roadmap/journeys.json): I trade spot and perps from one trading account with
// cross margin. One test per step, titled "J-derivatives-25 #<n>", run in order on one TEST account, on the launch money
// model: the venue holds the trading money, the stack's TEST partner bank holds the spending money
// (`testPartner.set({ custody: 'off' })`), the app shows each as its source reports it, and the ledger posts nothing.
//
// TEST setup in #1, the journey's start: one verified TEST person with a TEST browser wallet holding TEST ETH for gas on
// the stack's TEST chain and an empty account on the TEST venue, TEST 1000 USDC in their TEST partner account and a TEST
// card in USDC. Every figure is read from its own source and compared: the venue's record (`/balances`, `/fills`), the
// partner's own book on loopback (`/test-partner`), the card partner's figure and the TEST chain. #4 rests the TEST
// BTC-USDC ladder at a TEST price the trading account can pay for, and puts it back after the step.
const J = 'J-derivatives-25';
const PARTNER_USDC = '1000';
const MOVE_IN = '600';
const PARTNER_BANK = 'TEST partner bank';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const SPOT = 'BTC-USDC';
const SPOT_MID = '20000';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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
async function receipt(hash) {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
  });
  return (await res.json()).result;
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

test(`${J} #1 opens /trade/account: two named groups with their as-of times, trading from the venue (empty) and spending from the partner (1000.00 USDC), and the liquidation line`, async ({
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

  await openAccount(page);
  await expect(page.getByTestId('liquidation-line')).toHaveText(
    'Liquidation only ever uses your trading account. Your spending balances are never used.',
  );
  // Trading: the venue's account, named by its own name, empty as the venue reports it, with the venue's time.
  const venue = await venueInfo();
  expect((await venueRecord(owner, '/balances')).value.filter((b) => toUnits(b.total) > 0n)).toEqual([]);
  await expect(trading(page).getByRole('heading', { name: /^Trading/ })).toBeVisible();
  await expect(trading(page).getByTestId('trading-source')).toContainText(`From ${venue.displayName}`);
  await expect(trading(page).getByTestId('trading-source').locator('[data-as-of]')).toHaveAttribute('data-as-of', /^\d{4}-\d\d-\d\dT/);
  await expect(trading(page).getByTestId('trading-empty')).toHaveText('This venue account is empty.');
  // Spending: the partner account, 1000.00 USDC as the partner reports it, with the partner's time; the card, from it.
  await expect(spending(page).getByRole('heading', { name: 'Spending', exact: true })).toBeVisible();
  await expect(spending(page).getByTestId('spending-source')).toContainText(`From ${PARTNER_BANK}`);
  await expect(spending(page).getByTestId('spending-source').locator('[data-as-of]')).toHaveAttribute('data-as-of', /^\d{4}-\d\d-\d\dT/);
  await expect(mainRow(page).locator('[data-cell="balance"]')).toHaveText('1,000.00 USDC', { timeout: 20_000 });
  expect(sameDecimal(await partnerMain(run.read().userId), PARTNER_USDC)).toBe(true);
  const figures = (await bankGet('cards.partnerHeld', { cardId: card.id, limit: 1 })).figures;
  await expect(spending(page).locator(`li[data-card="${card.id}"]`)).toHaveText(
    `Card ending ${card.panTail}: ${Number(figures.available).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC available, from ${PARTNER_BANK}`,
  );
  expect(
    sameDecimal(figures.available, PARTNER_USDC),
    'the card spends the partner account’s 1000.00 USDC, as the partner reports it',
  ).toBe(true);
  // Never one INTAFACED balance: nothing adds the two groups up, and the ledger holds nothing for either.
  await expect(page.getByText(/total balance/i)).toHaveCount(0);
});

test(`${J} #2 moves TEST 600 USDC from spending into trading, with step-up: the partner's transfer to the wallet, then the wallet's deposit, each with its fee or "not known"; the same move again sends nothing; the ledger posts nothing`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { owner, userId, ledger } = state();
  await signInNow(page, state().who);
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
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
  expect(wallet.requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(0);
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
