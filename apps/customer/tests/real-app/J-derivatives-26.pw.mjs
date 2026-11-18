// World: book, restart
import { randomBytes, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { personDoor } from './person-door.mjs';
import { CHAIN_ID, connectWhenAsked } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { otherTraderKey, sameDecimal, testDeposit, venueForThisFile, venueRecord } from './venue.mjs';
import { signedOnVenue, venueAt, venueNow } from './venue-door.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-derivatives-26, in the running app (docs/roadmap/journeys.json): my spending money stays untouched when my cross
// account is liquidated. One test per step, titled "J-derivatives-26 #<n>", run in order, on the launch money model: the
// venue holds the trading money, liquidates and charges its fee; the stack's TEST partner bank holds the spending money
// (`testPartner.set({ custody: 'off' })`); the app shows each as its source reports it, and our ledger posts nothing.
//
// TEST setup in the journey's start (the "starts:" test, and the same for the second person in #6): a verified TEST
// person with a TEST browser wallet; TEST 500 USDC paid in at the TEST partner bank, TEST 100 of it moved into a named
// space, so the partner account reads 400 and the space 100; a TEST card in USDC; on the TEST venue, TEST 300 USDC and a
// TEST cross long of 50 XCRS-PERP at 100 at 20x (maintenance 125 against equity near 297.75), bought from a TEST other
// trader. XCRS-PERP is the TEST perpetual on cross margin that only this journey trades, so moving its mark
// (`/test/set-mark`, the simulator's TEST mark control) reaches no other journey. Every figure is compared with its own
// source: the venue's record (`/balances`, `/account-summary`, `/liquidations`), the partner's own book on loopback
// (`/test-partner`), and our ledger, read before and after.
const J = 'J-derivatives-26';
const XCRS = 'XCRS-PERP';
const VENUE_USDC = '300';
const PAID_IN = '500';
const TO_SPACE = '100';
const MAIN_LEFT = '400';
const SPACE_NAME = 'TEST Savings';
const LONG = '50';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);
const second = journeyState(`${J}-two-${runId}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const one = personDoor(J, run, test);
const two = personDoor(`${J} #6`, second, test);

// ── the TEST venue ──

const setMark = (price) => venueAt('/test/set-mark', { symbol: XCRS, price });
/** The mark moves against the long one TEST step at a time, as a market does, to `to`. */
async function walkMark(prices) {
  for (const price of prices) await setMark(price);
}
const summaryOf = async (owner) => (await venueRecord(owner, '/account-summary')).value;
const liquidationsOf = async (owner) =>
  (await venueRecord(owner, '/liquidations', { since: new Date(0).toISOString() })).value.filter((l) => l.symbol === XCRS);
const usdcOn = async (owner) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };
const fundNow = async () => (await venueAt('/insurance-fund', {})).value;

// ── the TEST partner bank's own book ──

const partnerMoves = async (userId) => (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;
/** The partner's own figure for the person's main USDC account. */
async function partnerMain(userId) {
  const rows = (await venueRecord(userId, '/balances', {}, PARTNER_RECORD, null)).value;
  return rows.find((r) => r.asset === 'USDC')?.total ?? '0';
}
/** The partner's own figure for one space: every move its book lists into it, less every move out. */
async function partnerSpace(userId, spaceId) {
  let units = 0n;
  for (const m of await partnerMoves(userId)) {
    if (m.to.spaceId === spaceId) units += toUnits(m.amount);
    if (m.from.spaceId === spaceId) units -= toUnits(m.amount);
  }
  return units;
}

// ── the person, set up the same for #1 and #6 ──

/** TEST setup, not a step: a verified person, their spending at the TEST partner, a TEST card, and a cross long on the venue. */
async function startsFor(page, door, store, tag) {
  const who = await signUp(page, tag);
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  store.reset({ who, walletKey });

  // Spending at the TEST partner: 500 paid in, 100 of it into a named space, and a TEST card in USDC.
  await door.bankPost('testPartner.set', { custody: 'off' });
  await door.bankPost('currencies.add', { assetId: 'USDC' }).catch(() => undefined);
  await door.bankPost('testPartner.fund', { fundId: `${J}-${who.email}`.slice(0, 64), assetId: 'USDC', amount: PAID_IN });
  await door.bankPost('spaces.create', { assetId: 'USDC', name: SPACE_NAME });
  const spaces = await door.bankGet('spaces.list', { limit: 200 });
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'USDC');
  const space = spaces.find((s) => s.kind === 'named' && s.name === SPACE_NAME);
  expect(space).toMatchObject({ assetId: 'USDC', ledgerAccount: null, heldAt: expect.any(Object) });
  expect(main).toMatchObject({ ledgerAccount: null, heldAt: expect.any(Object) });
  await door.bankPost('transfers.create', {
    transferId: `${tag}-space-${who.email}`.slice(0, 64),
    fromSpaceId: main.id,
    toSpaceId: space.id,
    amount: TO_SPACE,
  });
  const card = await door.bankPost('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
  const userId = (await door.door()).userId;
  expect(sameDecimal(await partnerMain(userId), MAIN_LEFT)).toBe(true);
  expect(await partnerSpace(userId, space.id)).toBe(toUnits(TO_SPACE));

  // The venue: TEST 300 USDC, cross at 20x, and a long of 50 XCRS-PERP at 100 from a TEST other trader's ask.
  const venue = await venueNow();
  await setMark('100');
  await testDeposit(owner, 'USDC', VENUE_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`);
  const cross = { kind: 'update_leverage', symbol: XCRS, leverageBps: 200_000, marginMode: 'cross' };
  const seller = otherTraderKey(`${tag}-${runId}-${randomBytes(3).toString('hex')}`);
  await testDeposit(seller.address.toLowerCase(), 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:0`);
  await signedOnVenue(venue, seller, cross);
  const ask = { kind: 'place_order', symbol: XCRS, side: 'sell', type: 'limit', amount: LONG, price: '100', timeInForce: 'GTC' };
  await signedOnVenue(venue, seller, {
    ...ask,
    reduceOnly: false,
    clientOrderKey: `order:${tag}:${randomBytes(4).toString('hex')}:ask`,
    builderFee: null,
  });
  const key = privateKeyToAccount(walletKey);
  await signedOnVenue(venue, key, cross);
  await signedOnVenue(venue, key, {
    ...ask,
    side: 'buy',
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${tag}:${randomBytes(4).toString('hex')}:open`,
    builderFee: null,
  });
  const position = (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === XCRS);
  expect(position).toMatchObject({ side: 'long', marginMode: 'cross' });
  expect(sameDecimal(position.size, LONG)).toBe(true);
  const cross0 = (await summaryOf(owner)).cross;
  expect(cross0).toMatchObject({ state: 'healthy' });
  store.write({
    owner,
    userId,
    spaceId: space.id,
    cardId: card.id,
    ledger: await (await door.door()).balances(),
    partnerMovesAtStart: (await partnerMoves(userId)).length,
  });
}

// ── the room ──

async function openAccount(page, door, store) {
  const { who, walletKey } = store.read();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey });
  await door.signInNow(page, who);
  await page.goto('/trade/account');
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(privateKeyToAccount(walletKey).address.toLowerCase());
  return wallet;
}
const spending = (page) => page.getByTestId('group-spending');
const mainCell = (page) => spending(page).locator('tr[data-space="main:USDC"] [data-cell="balance"]');
const spaceCell = (page, spaceId) => spending(page).locator(`tr[data-space="${spaceId}"] [data-cell="balance"]`);

/** The spending group reads 400.00 and 100.00, and the partner's own book says the same, to the cent. */
async function spendingUntouched(page, store) {
  const { userId, spaceId, partnerMovesAtStart } = store.read();
  await expect(mainCell(page)).toHaveText('400.00 USDC', { timeout: 30_000 });
  await expect(spaceCell(page, spaceId)).toHaveText('100.00 USDC');
  expect(sameDecimal(await partnerMain(userId), MAIN_LEFT)).toBe(true);
  expect(await partnerSpace(userId, spaceId)).toBe(toUnits(TO_SPACE));
  // No move on the person's partner book since the start: nothing left any spending account.
  expect((await partnerMoves(userId)).length).toBe(partnerMovesAtStart);
}

test(`${J} starts: a verified TEST person with TEST 400 in the TEST partner account and TEST 100 in a partner space, a TEST card, and a venue account in cross holding TEST 300 USDC with a TEST long perp close to its maintenance level`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  await startsFor(page, one, run, 'jd26');
});

test(`${J} #1 waits while the TEST mark moves against the long, to below the account's maintenance level: one margin-call alert naming the trading account; the account margin ratio shown equals the venue's; the spending balances still read 400.00 and 100.00`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = run.read();
  await openAccount(page, one, run);
  const cross = page.getByTestId('cross-margin');
  await expect(cross).toHaveAttribute('data-state', 'healthy', { timeout: 30_000 });
  await expect(page.getByTestId('margin-call')).toHaveCount(0);
  await spendingUntouched(page, run);
  const usdcBefore = await usdcOn(owner);

  // The TEST mark walks down: 99, 98, 97, then 96.50, where the venue's equity is below its maintenance requirement.
  await walkMark(['99', '98', '97', '96.5']);
  const venueSays = (await summaryOf(owner)).cross;
  expect(venueSays.state).toBe('margin_call');
  expect(toUnits(venueSays.equity) < toUnits(venueSays.maintenanceMargin)).toBe(true);
  expect(toUnits(venueSays.equity) > toUnits(venueSays.liquidationEquity)).toBe(true);
  // One margin-call alert, naming the trading account and its venue.
  const alert = page.getByTestId('margin-call');
  await expect(alert).toHaveCount(1, { timeout: 30_000 });
  const venue = await venueNow();
  await expect(alert).toContainText(`Margin call on your trading account at ${venue.name}`);
  await expect(cross).toHaveAttribute('data-state', 'margin_call');
  // The margin ratio shown is the venue's, exact.
  expect(venueSays.marginRatio.known).toBe(true);
  await expect(cross.locator('[data-line="ratio"]')).toHaveAttribute('data-value', venueSays.marginRatio.value);
  await expect(cross.locator('[data-line="ratio"] dd')).toHaveText(venueSays.marginRatio.value);
  await expect(cross.locator('[data-line="equity"]')).toHaveAttribute('data-value', venueSays.equity);
  await expect(cross.locator('[data-line="maintenance"]')).toHaveAttribute('data-value', venueSays.maintenanceMargin);
  // Nothing moved: the venue holds what it held, and spending reads as before, from the partner.
  expect(await usdcOn(owner)).toEqual(usdcBefore);
  expect(await liquidationsOf(owner)).toEqual([]);
  await spendingUntouched(page, run);
});

test(`${J} #2 opens /trade/account during the margin call: one action, "Move money into your trading account", which opens the person's own signed move; nothing has moved from spending`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, ledger } = run.read();
  expect((await summaryOf(owner)).cross.state).toBe('margin_call');
  const wallet = await openAccount(page, one, run);
  const alert = page.getByTestId('margin-call');
  await expect(alert).toHaveCount(1, { timeout: 30_000 });
  // One action, and only one.
  await expect(alert.getByRole('button')).toHaveCount(1);
  const action = alert.getByRole('button', { name: 'Move money into your trading account', exact: true });
  const signs = () => wallet.requests.filter((r) => /sign/i.test(r.method)).length;
  const signedBefore = signs();
  await action.click();
  // It opens the person's own move: its amount field, waiting for them; nothing is reviewed, signed or sent.
  const move = page.getByTestId('move-in');
  await expect(move.getByLabel('Amount (USDC)', { exact: true })).toBeFocused();
  await expect(move.getByRole('button', { name: 'Review move', exact: true })).toBeVisible();
  await expect(move.getByTestId('move-review')).toHaveCount(0);
  expect(signs() - signedBefore, 'the wallet is asked to sign nothing').toBe(0);
  expect(wallet.sends, 'the wallet sends nothing').toHaveLength(0);
  expect(await one.bankGet('ownMoves.list', { limit: 10 })).toEqual([]);
  await spendingUntouched(page, run);
  expect(await (await one.door()).balances()).toEqual(ledger);
});

test(`${J} #3 waits while the TEST mark crosses the account's liquidation level: the venue closes the account's positions once; the liquidation list shows each part the venue reports with size, price, fee and the venue's id`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = run.read();
  await openAccount(page, one, run);
  await expect(page.getByTestId('margin-call')).toHaveCount(1, { timeout: 30_000 });
  // On down, 96, 95.50, then 95.29, where equity reaches the venue's liquidation level (half the maintenance requirement).
  await walkMark(['96', '95.5']);
  expect(await liquidationsOf(owner)).toEqual([]);
  await setMark('95.29');
  const [liquidation, ...more] = await liquidationsOf(owner);
  expect(more, 'the venue liquidates the account once').toEqual([]);
  expect(liquidation).toMatchObject({ symbol: XCRS, side: 'long', state: 'done' });
  expect(liquidation.parts.length).toBeGreaterThan(0);
  const position = (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === XCRS);
  expect(position ? toUnits(position.size) : 0n).toBe(0n);
  expect((await summaryOf(owner)).cross).toBeNull();

  // The list shows each part, as the venue reports it.
  const list = page.getByTestId('trading-liquidations');
  await expect(list.locator('tr[data-part]')).toHaveCount(liquidation.parts.length, { timeout: 30_000 });
  for (const part of liquidation.parts) {
    const row = list.locator(`tr[data-part="${part.partId}"]`);
    await expect(row).toHaveAttribute('data-liquidation', liquidation.liquidationId);
    await expect(row.locator('[data-cell="size"]')).toHaveText(part.size);
    await expect(row.locator('[data-cell="price"]')).toHaveText(part.price);
    await expect(row.locator('[data-cell="fee"]')).toHaveText(`${part.fee} ${part.feeAsset}`);
    await expect(row.locator('[data-cell="id"]')).toHaveText(part.partId);
  }
  await expect(page.getByTestId('margin-call')).toHaveCount(0);
  // Once: the mark again, and lower, closes nothing more.
  await walkMark(['95.29', '95']);
  expect(await liquidationsOf(owner)).toHaveLength(1);
  await page.reload();
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  await expect(page.getByTestId('trading-liquidations').locator('tr[data-part]')).toHaveCount(liquidation.parts.length, {
    timeout: 30_000,
  });
});

test(`${J} #4 opens the spending balances: the partner balance 400.00 and the space 100.00, unchanged to the cent, as the partner reports them; no liquidation line on any spending account`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { ledger, spaceId } = run.read();
  await openAccount(page, one, run);
  await spendingUntouched(page, run);
  await expect(spending(page)).not.toContainText(/liquidat/i);
  // The bank's own read of the same two accounts: the partner's figures, and the partner holds both.
  const spaces = await one.bankGet('spaces.list', { limit: 200 });
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'USDC');
  const space = spaces.find((s) => s.id === spaceId);
  expect(sameDecimal(main.balance, MAIN_LEFT)).toBe(true);
  expect(sameDecimal(space.balance, TO_SPACE)).toBe(true);
  expect(main.heldAt).toBeTruthy();
  expect(space.heldAt).toMatchObject({ label: main.heldAt.label });
  expect(await (await one.door()).balances()).toEqual(ledger);
});

test(`${J} #6 for the second TEST person, the mark gaps past the account's bankruptcy level in one step: the venue account ends at 0.00 and never below, as the venue reports it; any shortfall is the venue's under its own rules and INTAFACED posts nothing; that person's spending balances are unchanged`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  await startsFor(page, two, second, 'jd26b');
  const { owner, ledger } = second.read();
  const before = (await summaryOf(owner)).cross;
  const fundBefore = await fundNow();
  // The bankruptcy level: where the long's loss takes the whole equity. One step from 100 to 80 is past it (a 1000 loss).
  const bankruptcy = toUnits('100') - (toUnits(before.equity) * toUnits('1')) / toUnits(LONG);
  expect(toUnits('80') < bankruptcy).toBe(true);
  await setMark('80');
  const [liquidation, ...more] = await liquidationsOf(owner);
  expect(more).toEqual([]);
  expect(liquidation.parts.every((p) => sameDecimal(p.price, '80'))).toBe(true);
  // The venue account ends at 0, never below, as the venue reports it.
  const usdc = await usdcOn(owner);
  expect([usdc.free, usdc.locked, usdc.total].map((v) => toUnits(v))).toEqual([0n, 0n, 0n]);
  const deficits = (await venueRecord(owner, '/balances')).value.filter((b) => toUnits(b.total) < 0n);
  expect(deficits).toEqual([]);
  // The shortfall is the venue's: its insurance fund paid it, under its own rule.
  const fundAfter = await fundNow();
  expect(fundBefore.known && fundAfter.known).toBe(true);
  expect(toUnits(fundAfter.value.balance) < toUnits(fundBefore.value.balance)).toBe(true);

  await openAccount(page, two, second);
  const usdcRow = page.getByTestId('group-trading').locator('tr[data-asset="USDC"] [data-cell="total"]');
  await expect(usdcRow).toHaveText('0.00', { timeout: 30_000 });
  await spendingUntouched(page, second);
  // INTAFACED posts nothing.
  expect(await (await two.door()).balances()).toEqual(ledger);
});
