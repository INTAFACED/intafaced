// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, api, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  shownBalance,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-01's steps on the user's own venue account (B1, project-state #1789), in the running app against the
// stack's TEST venue simulator. One test per step, titled "J-cex-spot-01 #<n>" as J-cex-spot-01.pw.mjs titles them; a step
// in both files must pass in both. Steps #1–#3 (sign up, verify) are today's file's; this file starts from a verified
// account it makes in #4. #5 (ticker, book, chart, tape of the venue market) and #11 (profit and loss) need venue
// market-data and lot reads the user-venue door does not have yet, so they stay in today's file only.
// Every figure is TEST. The door is on for this file only (venueForThisFile).
const J = 'J-cex-spot-01';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** The TEST limit buy of #6 to #8: TEST 0.1 BTC at a TEST price TEST 1,000 USDC covers, resting under the market. */
const BUY = { amount: '0.1', price: '9000' };
/** #9's market buy and its slippage limit (the TEST ladder's asks start at 60010). */
const MARKET_BUY = { amount: '0.001', worst: '60100' };
/** #10's limit far from the market. */
const AWAY = { amount: '0.001', price: '30000' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #4 made no account and wallet, so this step has no one to act as`);
  return s;
}

const desk = async (page) => {
  const s = state();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  return { ...s, wallet, owner: wallet.address };
};

/** Fill the venue ticket and press Review; returns the review sheet. */
async function review(page, { side = 'buy', type = 'limit', price, amount }) {
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: side === 'buy' ? 'Buy' : 'Sell', exact: true }).click();
  await ticket.getByRole('button', { name: type === 'limit' ? 'Limit' : 'Market', exact: true }).click();
  await ticket.getByRole('textbox', { name: type === 'limit' ? 'Price' : 'Worst price (slippage limit)' }).fill(price);
  await ticket.getByRole('textbox', { name: 'Amount (BTC)' }).fill(amount);
  await ticket.getByRole('button', { name: side === 'buy' ? 'Review buy' : 'Review sell' }).click();
  const sheet = page.getByTestId('venue-review');
  await expect(sheet).toBeVisible();
  return sheet;
}

const line = (sheet, name) => sheet.locator(`[data-line="${name}"]`);

/** Confirm and sign in the review; returns the outcome text. */
async function confirmAndSign(page, sheet) {
  await sheet.getByRole('button', { name: 'Confirm and sign' }).click();
  await continueInWallet(page);
  const outcome = sheet.getByTestId('venue-outcome').last();
  await expect(outcome).not.toHaveText('');
  return outcome;
}

test(`${J} #4 connects a wallet and deposits TEST 1000 USDC into the venue account; a replay of the same deposit adds nothing; the ledger posts nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const account = await signUp(page, 'vspot');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const { owner } = await desk(page);
  const ledgerBefore = await (await api(account)).balances();

  // B2 owns the real chain-transfer watcher: until it lands, the deposit is the TEST venue's own deposit control, keyed by
  // a chain-transfer-shaped reference (<chainId>:<txHash>:<logIndex>), and the wallet's own transfer is not signed here.
  // #4 moves to that watcher when it lands.
  const ref = `84532:0x${randomBytes(32).toString('hex')}:0`;
  expect(await testDeposit(owner, 'USDC', '1000', ref)).toBe(true);
  await expect.poll(async () => (await shownBalance(page, 'USDC')).free, { timeout: 15_000 }).toBe('1000');
  expect((await shownBalance(page, 'USDC')).used).toBe('0');
  await expect(page.getByTestId('venue-balances').getByTestId('venue-as-of')).toContainText('As of');
  await expect(page.getByTestId('venue-balances').getByTestId('venue-test').first()).toHaveText('TEST');

  // The same deposit event again credits nothing; the venue and the desk still read 1000.
  expect(await testDeposit(owner, 'USDC', '1000', ref)).toBe(false);
  const venue = await venueBalance(owner, 'USDC');
  expect(sameDecimal(venue.free, '1000') && sameDecimal(venue.locked, '0')).toBe(true);
  await page.waitForTimeout(2_500);
  expect(await shownBalance(page, 'USDC')).toEqual({ free: '1000', used: '0', total: '1000' });
  // The ledger posts nothing: the account's own ledger balances are as they were.
  expect(await (await api(account)).balances()).toEqual(ledgerBefore);
});

test(`${J} #6 reviews a TEST 0.1 BTC limit buy: what the venue locks, the venue's fee and our builder fee, maker role, time in force, the client id held for retry, and the builder-fee approval`, async ({
  page,
}) => {
  const { owner, wallet } = await desk(page);
  const sheet = await review(page, BUY);
  // Every line is the venue's: the same intent previewed on the venue directly, with our builder fee as the door adds it.
  const status = await testVenue('/venue');
  const clientId = (await line(sheet, 'client-id').innerText()).trim();
  expect(clientId).toMatch(new RegExp(`^order:${owner}:btc-usdc:[a-z0-9]+$`));
  const venuePreview = await venueRecord(owner, '/preview', {
    intent: {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: BUY.amount,
      price: BUY.price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: clientId,
      builderFee: { builder: '0x7e57000000000000000000000000000000000b1d', feeBps: '0.5' },
    },
  });
  expect(status.body.label).toBe('TEST');
  const p = venuePreview.value;
  expect((await line(sheet, 'lock').innerText()).replace(/,/g, '')).toBe(`${p.lock.amount} ${p.lock.asset}`);
  expect(p.lock.asset).toBe('USDC');
  expect((await line(sheet, 'venue-fee').innerText()).trim()).toBe(`${p.venueFee.value.amount} ${p.venueFee.value.asset}`);
  expect((await line(sheet, 'builder-fee').innerText()).trim()).toBe(`${p.builderFee.value.amount} ${p.builderFee.value.asset}`);
  expect(p.role).toBe('maker');
  await expect(line(sheet, 'role')).toHaveText('Maker');
  await expect(line(sheet, 'tif')).toHaveText('Good till cancelled');
  await expect(sheet.getByTestId('venue-test').first()).toHaveText('TEST');

  // The wallet has not approved our builder fee: the review says so and the wallet signs the approval here, once.
  await expect(line(sheet, 'builder-approval')).toHaveText('Not signed: your wallet signs an approval of up to 0.5 bps before the order');
  await expect(sheet.getByRole('button', { name: 'Confirm and sign' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' }).click();
  await continueInWallet(page);
  await expect(line(sheet, 'builder-approval')).toHaveText('Signed, up to 0.5 bps', { timeout: 15_000 });
  expect(wallet.requests.map((r) => r.method)).toEqual(['eth_signTypedData_v4']);
  // Nothing was placed: the review sends no order.
  expect((await venueRecord(owner, '/open-orders')).value).toEqual([]);
});

test(`${J} #7 confirms and signs: the order rests on the venue and shows Open in Open orders; the locked amount equals the venue's`, async ({
  page,
}) => {
  const { owner, wallet } = await desk(page);
  const sheet = await review(page, BUY);
  await expect(line(sheet, 'builder-approval')).toHaveText('Signed, up to 0.5 bps');
  const outcome = await confirmAndSign(page, sheet);
  await expect(outcome).toContainText('Open on the venue.');
  expect(wallet.requests).toHaveLength(1);
  await sheet.getByRole('button', { name: 'Back' }).click();

  const open = (await venueRecord(owner, '/open-orders')).value;
  expect(open).toHaveLength(1);
  expect(open[0].status).toBe('open');
  run.write({ restingClientId: open[0].venueClientOrderId });
  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${open[0].venueClientOrderId}"]`);
  await expect(row.locator('[data-cell="status"]')).toHaveText('Open');
  const lockedShown = (await row.locator('[data-cell="locked"]').innerText()).replace(/,/g, '').split(' ');
  expect(sameDecimal(lockedShown[0], open[0].locked) && lockedShown[1] === open[0].lockedAsset).toBe(true);
  // The balance's used figure equals the venue's lock.
  const venue = await venueBalance(owner, 'USDC');
  expect(sameDecimal(venue.locked, open[0].locked)).toBe(true);
  await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).used, venue.locked), { timeout: 15_000 }).toBe(true);
});

test(`${J} #8 a TEST sell on the venue fills the order: filled with price, size, the venue's fee, our builder fee and the maker role, read from the venue; the venue balances move by the fill`, async ({
  page,
}) => {
  const { owner } = await desk(page);
  const { restingClientId } = state();
  const before = await venueBalance(owner, 'USDC');
  // The other TEST trader sells into every bid at or above our price (IOC), so our resting buy fills at its own price.
  const seller = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(seller).address),
    asset: 'BTC',
    amount: '1000',
    depositRef: `seed:${seller}:BTC`,
  });
  const sold = await otherTraderRun(seller, {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'sell',
    type: 'limit',
    amount: '100',
    price: BUY.price,
    timeInForce: 'IOC',
    reduceOnly: false,
    clientOrderKey: `order:${seller}:fill`,
    builderFee: null,
  });
  expect(sold.definite && sold.accepted, JSON.stringify(sold)).toBe(true);

  const order = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: restingClientId })).value;
  expect(order.status).toBe('filled');
  const fills = (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 3_600_000).toISOString() })).value.filter(
    (f) => f.venueClientOrderId === restingClientId,
  );
  expect(fills).toHaveLength(1);
  const fill = fills[0];
  expect(fill.role).toBe('maker');
  expect(sameDecimal(fill.price, BUY.price) && sameDecimal(fill.amount, BUY.amount)).toBe(true);

  await page.getByTestId('venue-bottom').getByRole('button', { name: 'Trade history' }).click();
  const row = page.getByTestId('venue-fills').locator(`tr[data-fill="${fill.fillId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('[data-cell="price"]')).toHaveText('9,000');
  await expect(row.locator('[data-cell="amount"]')).toHaveText('0.1');
  await expect(row.locator('[data-cell="role"]')).toHaveText('Maker');
  await expect(row.locator('[data-cell="venue-fee"]')).toHaveText(fill.venueFee);
  await expect(row.locator('[data-cell="builder-fee"]')).toHaveText(fill.builderFee);
  expect(toUnits(fill.builderFee) > 0n).toBe(true);

  // The venue balances moved by the fill: the lock is spent, and the desk shows the venue's figures.
  const after = await venueBalance(owner, 'USDC');
  expect(sameDecimal(after.locked, '0')).toBe(true);
  expect(toUnits(before.total) - toUnits(after.total)).toBe(toUnits('900'));
  const btc = await venueBalance(owner, 'BTC');
  await expect.poll(async () => sameDecimal((await shownBalance(page, 'BTC')).free, btc.free), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).total, after.total), { timeout: 15_000 }).toBe(true);
});

test(`${J} #9 places a market buy: it fills on the venue inside its slippage limit; nothing stays locked`, async ({ page }) => {
  const { owner } = await desk(page);
  const sheet = await review(page, { type: 'market', price: MARKET_BUY.worst, amount: MARKET_BUY.amount });
  await expect(line(sheet, 'role')).toHaveText('Taker');
  await expect(line(sheet, 'tif')).toHaveText('Immediate or cancel');
  const outcome = await confirmAndSign(page, sheet);
  await expect(outcome).toContainText('Filled on the venue.');
  const fills = (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 3_600_000).toISOString() })).value.filter(
    (f) => f.role === 'taker',
  );
  expect(fills.length).toBeGreaterThan(0);
  for (const f of fills) expect(toUnits(f.price) <= toUnits(MARKET_BUY.worst)).toBe(true);
  const usdc = await venueBalance(owner, 'USDC');
  expect(sameDecimal(usdc.locked, '0')).toBe(true);
  expect((await venueRecord(owner, '/open-orders')).value).toEqual([]);
  await expect.poll(async () => (await shownBalance(page, 'USDC')).used, { timeout: 15_000 }).toBe('0');
});

test(`${J} #10 rests a limit away from the market, cancels it, cancels it again: cancelled on the venue, the lock released; the repeat reports the same outcome`, async ({
  page,
}) => {
  const { owner, wallet } = await desk(page);
  const sheet = await review(page, AWAY);
  await expect(await confirmAndSign(page, sheet)).toContainText('Open on the venue.');
  await sheet.getByRole('button', { name: 'Back' }).click();
  const [resting] = (await venueRecord(owner, '/open-orders')).value;
  expect(resting.status).toBe('open');
  await expect.poll(async () => sameDecimal((await shownBalance(page, 'USDC')).used, resting.locked), { timeout: 15_000 }).toBe(true);

  const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${resting.venueClientOrderId}"]`);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  const outcome = page.getByTestId('venue-ticket').getByTestId('venue-outcome');
  await expect(outcome).toContainText('Cancelled on the venue; its lock is released.');
  const signed = wallet.requests.length;
  const cancelled = (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId: resting.venueClientOrderId })).value;
  expect(cancelled.status).toBe('canceled');
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, '0')).toBe(true);
  await expect.poll(async () => (await shownBalance(page, 'USDC')).used, { timeout: 15_000 }).toBe('0');

  // The repeat names the same action: no new signature, and the venue's first answer.
  await expect(row.locator('[data-cell="status"]')).toHaveText('Cancelled', { timeout: 15_000 });
  await row.getByRole('button', { name: 'Cancel again' }).click();
  await expect(outcome).toContainText('Cancelled on the venue; its lock is released. This is the same action as before');
  expect(wallet.requests).toHaveLength(signed);
});

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test(`${J} #12 withdraws TEST 10 USDC from the venue to the wallet: the wallet signs; pending then done, with its fee; a session that has not stepped up is refused before the wallet is asked`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  // Signed in with the wallet, then a second factor to step up with (Security), then back to the desk.
  const { owner, wallet } = await desk(page);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  const connect = page.getByRole('button', { name: 'Connect TEST Wallet' });
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(owner);
  const before = await venueBalance(owner, 'USDC');

  // A session that has not stepped up: the door refuses before anything is prepared, so no wallet is asked.
  const fresh = await nextCode(totp, secret, step);
  run.write({ step: fresh.step });
  const client = await api(s.account, { totpCode: fresh.code });
  const unstepped = await client.post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: { kind: 'withdraw', asset: 'USDC', amount: '10', destination: owner, withdrawalKey: `withdraw:${owner}:unstepped` },
    stepUpApprovalId: null,
  });
  expect(unstepped.status, JSON.stringify(unstepped.body)).toBe(403);
  expect(unstepped.body.intafacedCode).toMatch(/step_up/);
  expect(wallet.requests).toHaveLength(0);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).free, before.free)).toBe(true);

  // In the desk: the amount, a fresh confirmation, then the wallet signs.
  const panel = page.getByTestId('venue-withdraw');
  await panel.getByRole('combobox').selectOption('USDC');
  await panel.getByRole('textbox').fill('10');
  await panel.getByRole('button', { name: 'Review withdrawal' }).click();
  const code = await nextCode(totp, secret, run.read().step);
  run.write({ step: code.step });
  await panel.getByLabel('Authenticator code').fill(code.code);
  await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
  await continueInWallet(page);
  await expect(panel.getByTestId('venue-outcome')).toContainText('The venue accepted it.');
  expect(wallet.requests).toHaveLength(1);
  const shown = panel.getByTestId('venue-withdrawal');
  await expect(shown).toHaveAttribute('data-status', 'pending', { timeout: 15_000 });
  await expect(shown.locator('[data-cell="fee"]')).toHaveText(/^(\d+(\.\d+)?|not known)$/);

  // The venue settles it (its TEST control), and the desk reads it done.
  const settled = await testVenue('/test/settle-withdrawals', {});
  expect(settled.status).toBe(200);
  await expect(shown).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(shown).toContainText('Done');
  const after = await venueBalance(owner, 'USDC');
  expect(toUnits(before.free) - toUnits(after.free) >= toUnits('10')).toBe(true);
});
