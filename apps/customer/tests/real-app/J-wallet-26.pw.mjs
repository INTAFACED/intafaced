// World: restart
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ageRecord } from './test-age.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { connectedNow } from './venue-wallet-room.mjs';
import { testDeposit, testVenue, venueBalance, venueForThisFile, venueInfo, venueRecord } from './venue.mjs';

// J-wallet-26, in the running app (docs/roadmap/journeys.json): when my week's profit hits my target, I'm offered a
// withdrawal to my own cold wallet, ready to sign. One test per step, titled "J-wallet-26 #<n>", run in order by one
// verified TEST person with one TEST browser wallet (their main wallet, test-wallet.mjs) connected to their account, and a
// second TEST address of their own, their cold wallet, derived from a public TEST seed for this run. The whole file runs
// on the TEST venue simulator behind svc-trade's user-venue door (venue.mjs `venueForThisFile`).
//
// The Starts line, made in #1: TEST 3000 USDC in the person's venue account (the TEST venue's deposit control), 10x
// isolated leverage on BTC-PERP, and no realised profit this week. Their TEST trades are signed by their own main wallet
// key and sent to the TEST venue itself: a long on BTC-PERP at the venue's best ask, then the TEST makers' ladder moved up
// (the venue's own TEST control), then the long closed at the venue's best bid. The week's realised profit the page and
// the message show is checked against the venue's own fills, read straight from the venue (`venueRecord`), never through
// our door. The TEST venue pays a withdrawal out on the stack's TEST chain from its TEST deposit address, which #1 funds.
//
// "A week later (TEST clock)" in #5 is svc-trade's TEST age door (subject `profit-lock`): it moves the lock's week back a
// day a call, seven times, so a new week begins; the venue's own fill times cannot move, so fills before that moment stay
// in the week that ended. "The venue can't be read (TEST switch)" in #6 is the TEST venue's own `venueDown` switch.
// Money: INTAFACED holds, moves and signs nothing: the one withdrawal is the person's own signed venue action, and the
// ledger posts nothing (the person's ledger balances are read before and after #4).
const J = 'J-wallet-26';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const BTC = 'BTC-PERP';
const MID = '60000';
const VENUE_USDC = '3000';
const TARGET = '200';
const SHARE = '50';
const SIZE = '0.1';
/** The gain per BTC #2 and #5 close at: 0.1 BTC × 3000 = about 300 TEST USDC of realised profit, past the 200 target. */
const GAIN = '3000';
const DAY = 86_400_000;
/** The TEST venue's published withdrawal fee (packages/venue-sim simulator.ts default switches). */
const VENUE_FEE = '1';
const OWNER_VALUES = JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/trade.json'), 'utf8')).values;
/** INTAFACED's TEST builder address on the venue: an INTAFACED address, never a cold wallet. */
const OURS = OWNER_VALUES.TRADE_USER_VENUE_BUILDER_ADDRESS.value;
const READY = 'Profit lock ready';
const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await testVenue('/test/switches', { venueDown: false }).catch(() => undefined);
  await testVenue('/test/ladder-mid', { symbol: BTC, price: MID }).catch(() => undefined);
  await testVenue('/test/set-mark', { symbol: BTC, price: MID }).catch(() => undefined);
});

function state() {
  const s = run.read();
  if (!s.who || !s.walletKey || !s.coldKey) throw new Error(`${J} #1 made no account and wallets, so this step has no one to act as`);
  const key = privateKeyToAccount(s.walletKey);
  return { ...s, key, owner: key.address.toLowerCase(), cold: privateKeyToAccount(s.coldKey).address };
}

// ---- sign-in: from #1 on the person has an authenticator, so every sign-in and confirmation takes a fresh code ----

async function freshCode() {
  const s = run.read();
  const { code, step } = await nextCode(totp, s.secret, s.step);
  run.write({ step });
  return code;
}

async function signInNow(page, who) {
  if (!run.read().secret) return signIn(page, who);
  const code = await freshCode();
  await page.goto('/login');
  await page.fill('input[name=totp]', code);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

let session;
test.beforeEach(() => {
  session = undefined;
});
/** The person's own API through Edge, one sign-in per step with a fresh code. */
const door = () => (session ??= (async () => api(state().who, { totpCode: await freshCode() }))());

// ---- the venue, signed by the person's own main wallet key and sent to the TEST venue itself ----

async function venueAct(intent) {
  const { owner, key } = state();
  const { id: venueId } = await venueInfo();
  const account = { venueId, owner, subAccount: null };
  const prep = await testVenue('/prepare', { account, signer: { role: 'owner', address: owner }, intent });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await testVenue('/submit', { prepared: prep.body, signature: { digest: prep.body.digest, signature, signedBy: owner } });
  expect(sent.body, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

const book = async () => (await testVenue('/book', { symbol: BTC, depth: 1 })).body.value;
const positionOf = async (owner) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === BTC) ?? null;
const order = (side, type, price, name, extra = {}) => ({
  kind: 'place_order',
  symbol: BTC,
  side,
  type,
  amount: SIZE,
  price,
  timeInForce: type === 'market' ? 'IOC' : 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${state().owner}:${J}:${name}`,
  builderFee: null,
  ...extra,
});

/** One TEST round trip on BTC-PERP closed in profit: a long at the best ask, the ladder moved GAIN up, closed at the best bid. */
async function closeInProfit(name) {
  const { owner } = state();
  await testVenue('/test/ladder-mid', { symbol: BTC, price: MID });
  await testVenue('/test/set-mark', { symbol: BTC, price: MID });
  const ask = (await book()).asks[0].price;
  await venueAct(order('buy', 'market', fromUnits(toUnits(ask) + toUnits('200')), `${name}-open`));
  await expect.poll(async () => (await positionOf(owner))?.size ?? '0', { timeout: 15_000 }).not.toBe('0');
  const up = fromUnits(toUnits(MID) + toUnits(GAIN));
  for (const route of ['/test/ladder-mid', '/test/set-mark']) {
    const moved = await testVenue(route, { symbol: BTC, price: up });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
  const bid = (await book()).bids[0].price;
  await venueAct(order('sell', 'market', fromUnits(toUnits(bid) - toUnits('200')), `${name}-close`, { reduceOnly: true }));
  await expect.poll(async () => (await positionOf(owner))?.size ?? '0', { timeout: 15_000 }).toBe('0');
  await testVenue('/test/ladder-mid', { symbol: BTC, price: MID });
  await testVenue('/test/set-mark', { symbol: BTC, price: MID });
}

/** The week's realised profit as the venue's own fills report it, since `from`. */
async function venueRealised(owner, from) {
  const fills = (await venueRecord(owner, '/fills', { since: from })).value;
  return fromUnits(
    fills
      .filter((f) => f.realisedPnl !== null && Date.parse(f.filledAt) >= Date.parse(from))
      .reduce((s, f) => s + toUnits(f.realisedPnl), 0n),
  );
}

/** `share` percent of `profit`, rounded down to USDC's smallest unit (6 places), as svc-trade's offer is. */
const shareOf = (profit, share) => {
  const exact = (toUnits(profit) * toUnits(share)) / toUnits('100');
  const unit = 10n ** 12n;
  return fromUnits(exact - (exact % unit));
};

// ---- the page ----

const sheet = (page) => page.locator('[data-sheet="sign"]');
const lockPanel = (page) => page.getByRole('region', { name: 'Profit lock', exact: true });

/** Signed in, the main wallet in this page on the TEST chain, on the venue account room (or `path`), connected. */
async function openRoom(page, path = '/wallet/venue') {
  const { who, walletKey } = state();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signInNow(page, who);
  await page.goto(path);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await connectedNow(page);
  await expect(lockPanel(page)).toBeVisible({ timeout: 30_000 });
  return wallet;
}

/** The person's own Profit lock record through Edge (`trade.profitLock.get`). */
async function lockRecord() {
  const res = await (
    await door()
  ).get(`/api/trade/trpc/profitLock.get?input=${encodeURIComponent(JSON.stringify({ owner: state().owner }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The person's inbox rows titled "Profit lock ready". */
async function readyRows(page) {
  await page.goto('/notifications');
  await page.waitForLoadState('networkidle');
  return page.getByTestId('nf-row').filter({ hasText: READY });
}

const shownAt = async (locator) => Date.parse(await locator.getAttribute('datetime'));

test(`${J} #1 opens Profit lock, sets a weekly target of TEST 200 USDC, a 50 percent share and their cold wallet's address: saved, with the address checked; an INTAFACED address or a mistyped one is refused naming why; this week's realised profit from the venue against the target, with its as-of time`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const who = await signUp(page, 'jwallet26');
  const walletKey = testWalletKey();
  const coldKey = keccak256(toHex(`INTAFACED LOCAL TEST cold wallet (${J}) ${who.handle}`));
  run.reset({ who, walletKey, coldKey });
  const { owner, cold } = state();
  // The venue door's reads and a withdrawal to another address of one's own need a verified person.
  await verify(page, who);
  run.write(await addAuthenticator(page, totp));

  // The Starts line: TEST USDC on the venue, 10x isolated on BTC-PERP, and the venue's TEST deposit address funded on the
  // TEST chain, which it pays withdrawals from.
  fundOnTestChain(owner, 'venue');
  const { chainId } = await venueInfo();
  await testDeposit(owner, 'USDC', VENUE_USDC, `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  const deposit = (await testVenue('/venue')).body.deposit;
  expect(deposit?.address, 'the TEST venue publishes its TEST deposit address').toBeTruthy();
  for (let i = 0; i < 2; i += 1) fundOnTestChain(deposit.address, 'venue');
  await venueAct({ kind: 'update_leverage', symbol: BTC, leverageBps: 10 * 10_000, marginMode: 'isolated' });

  const readFrom = new Date().toISOString();
  await openRoom(page);
  const panel = lockPanel(page);
  const fill = async (target, share, address) => {
    await panel.getByLabel('Weekly target (TEST USDC)', { exact: true }).fill(target);
    await panel.getByLabel('Share to lock (%)', { exact: true }).fill(share);
    await panel.getByLabel('Cold wallet address', { exact: true }).fill(address);
    await panel.getByRole('button', { name: 'Save profit lock', exact: true }).click();
  };

  // An INTAFACED address is refused naming why; nothing is saved.
  await fill(TARGET, SHARE, OURS);
  await expect(panel.getByText('That is an INTAFACED address, not your own wallet.', { exact: false })).toBeVisible();
  await expect(panel.getByTestId('profit-lock-saved')).toHaveCount(0);
  expect((await lockRecord()).setting).toBeNull();

  // A mistyped address (one letter's case changed, so its checksum fails) is refused naming why; nothing is saved.
  const flip = cold.search(/[a-fA-F]/);
  const mistyped =
    cold.slice(0, flip) +
    (cold[flip] === cold[flip].toUpperCase() ? cold[flip].toLowerCase() : cold[flip].toUpperCase()) +
    cold.slice(flip + 1);
  expect(mistyped.toLowerCase()).toBe(cold.toLowerCase());
  await fill(TARGET, SHARE, mistyped);
  await expect(
    panel.getByText('That address looks mistyped: its capital letters do not match its checksum.', { exact: false }),
  ).toBeVisible();
  expect((await lockRecord()).setting).toBeNull();

  // Their own cold wallet, with its checksum: saved, with the address checked.
  await fill(TARGET, SHARE, cold);
  await expect(panel.getByTestId('profit-lock-saved')).toHaveText(`Saved. Address checked: ${cold.toLowerCase()}`);
  const saved = await lockRecord();
  expect(saved.setting).toMatchObject({ target: TARGET, share: SHARE, coldWallet: cold.toLowerCase() });
  expect(saved.lockId).toEqual(expect.any(String));
  run.write({ lockId: saved.lockId });

  // This week's realised profit from the venue against the target, with its as-of time: the venue's own fills say none.
  const realised = await venueRealised(owner, saved.week.from);
  expect(realised).toBe('0');
  await expect(panel.getByTestId('profit-lock-setting')).toHaveText(
    `Weekly target ${TARGET} TEST USDC, ${SHARE}% to ${cold.toLowerCase()}`,
  );
  await expect(panel.getByTestId('profit-lock-profit')).toHaveText(
    `Realised profit ${realised} TEST USDC of your ${TARGET} TEST USDC target, as the venue reports it`,
  );
  const asOf = await shownAt(panel.getByTestId('profit-lock-as-of'));
  expect(asOf).toBeGreaterThanOrEqual(Date.parse(readFrom) - 5_000);
  expect(asOf).toBeLessThanOrEqual(Date.now() + 5_000);
  await expect(panel.getByTestId('profit-lock-offer')).toHaveCount(0);
  await stepPicture();
});

test(`${J} #2 closes TEST trades whose realised profit passes 200 this week: one "Profit lock ready" message naming the week's profit as the venue reports it, the share and the address; it does not repeat that week`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { who, owner, cold } = state();
  await signInNow(page, who);
  await expect(await readyRows(page)).toHaveCount(0);

  await closeInProfit('week-1');
  const { week } = await lockRecord();
  const profit = await venueRealised(owner, week.from);
  expect(toUnits(profit) >= toUnits(TARGET), `the venue reports ${profit} realised this week`).toBe(true);
  const amount = shareOf(profit, SHARE);

  // One message, naming the venue's figure, the share and the address.
  await expect
    .poll(async () => (await readyRows(page)).count(), { timeout: 60_000, message: 'the Profit lock ready message arrives' })
    .toBe(1);
  const row = (await readyRows(page)).first();
  await expect(row).toContainText(`This week’s realised profit on your venue account is ${profit} USDC, as the venue reports it`);
  await expect(row).toContainText(`Your ${SHARE}% share, ${amount} USDC, is ready to withdraw to your cold wallet ${cold.toLowerCase()}`);
  run.write({ profit, amount });

  // It does not repeat that week: more profit, read by the lock past the target again, sends nothing more.
  await closeInProfit('week-1-more');
  const more = await venueRealised(owner, week.from);
  expect(toUnits(more) > toUnits(profit)).toBe(true);
  await expect.poll(async () => (await lockRecord()).week.profit, { timeout: 30_000 }).toBe(more);
  expect((await lockRecord()).offer).toMatchObject({ profit, amount, state: 'ready' });
  await expect(await readyRows(page)).toHaveCount(1);
  await stepPicture();
});

test(`${J} #3 opens it: a venue withdrawal filled in with the share and the cold wallet's address, the venue's withdrawal fee, and the venue's withdrawable figure; a share above that figure is cut to it, saying so`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { who, owner, cold, amount } = state();
  if (!amount) throw new Error(`${J} #2 made no offer, so there is nothing to open`);
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey: state().walletKey, rpcUrl: testChain().gateUrl });
  await signInNow(page, who);

  // Opens the message: it leads to the venue account room, where the offer waits.
  await (await readyRows(page)).first().click();
  await expect(page).toHaveURL(/\/wallet\/venue/);
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await connectedNow(page);
  const offer = page.getByTestId('profit-lock-offer');
  await expect(offer.getByRole('heading', { name: READY, exact: true })).toBeVisible({ timeout: 30_000 });

  // A share above what the venue lets the account withdraw is cut to it, saying so: a resting TEST buy locks most of the
  // free balance, so the venue's free figure, less its fee, is below the share.
  const free = (await venueBalance(owner, 'USDC')).free;
  const lockPrice = '30000';
  const keep = toUnits(amount) / 2n;
  const size = ((toUnits(free) - keep) * 10n) / toUnits(lockPrice); // in 1e18 units of BTC at 10x
  const lot = toUnits('0.001');
  await venueAct(order('buy', 'limit', lockPrice, 'lock-free', { amount: fromUnits(size - (size % lot)) }));
  const freeNow = (await venueBalance(owner, 'USDC')).free;
  const withdrawable = fromUnits(toUnits(freeNow) - toUnits(VENUE_FEE));
  expect(toUnits(withdrawable) < toUnits(amount), `free ${freeNow} less the fee is below the share ${amount}`).toBe(true);
  await page.reload();
  await connectedNow(page);
  await expect(offer.getByTestId('profit-lock-withdrawable')).toHaveText(`${withdrawable} TEST USDC`, { timeout: 30_000 });
  await expect(offer.getByTestId('profit-lock-amount')).toHaveText(`${withdrawable} TEST USDC`);
  await expect(offer.getByTestId('profit-lock-cut')).toHaveText(
    `Your share, ${amount} TEST USDC, is above what the venue lets you withdraw now, so it is cut to ${withdrawable} TEST USDC.`,
  );
  await venueAct({ kind: 'cancel_order', symbol: BTC, clientOrderKey: `order:${owner}:${J}:lock-free` });
  await expect.poll(async () => (await venueRecord(owner, '/open-orders')).value.length).toBe(0);

  // With the free balance back, the withdrawal is filled in with the whole share, the cold wallet, the venue's fee and its
  // withdrawable figure, each the venue's own.
  const freeBack = (await venueBalance(owner, 'USDC')).free;
  const terms = (await testVenue('/withdrawal-terms', { asset: 'USDC' })).body.value;
  expect(terms.fee).toEqual({ known: true, value: VENUE_FEE });
  await page.reload();
  await connectedNow(page);
  await expect(offer.getByTestId('profit-lock-amount')).toHaveText(`${amount} TEST USDC`, { timeout: 30_000 });
  await expect(offer.getByTestId('profit-lock-to')).toHaveText(cold.toLowerCase());
  await expect(offer.getByTestId('profit-lock-fee')).toHaveText(`${VENUE_FEE} TEST USDC`);
  await expect(offer.getByTestId('profit-lock-withdrawable')).toHaveText(`${fromUnits(toUnits(freeBack) - toUnits(VENUE_FEE))} TEST USDC`);
  await expect(offer.getByTestId('profit-lock-cut')).toHaveCount(0);
  // Opening it signs nothing.
  expect(wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4')).toEqual([]);
  await stepPicture();
});

test(`${J} #4 signs with their main wallet: one venue withdrawal, sent once; pending then done as the venue reports it; the venue account's balance falls by the venue's figure`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const { owner, cold, amount } = state();
  if (!amount) throw new Error(`${J} #2 made no offer, so there is nothing to sign`);
  const ledgerBefore = await (await door()).balances();
  const before = await venueBalance(owner, 'USDC');
  const wallet = await openRoom(page);
  const offer = page.getByTestId('profit-lock-offer');
  await expect(offer.getByTestId('profit-lock-amount')).toHaveText(`${amount} TEST USDC`, { timeout: 30_000 });

  // The person's main wallet signs: the room asks for a fresh second factor, then the wallet signs the venue's withdrawal.
  const signedBefore = wallet.requests.length;
  await connectedNow(page);
  const code = await freshCode();
  await offer.getByRole('button', { name: 'Sign withdrawal in my wallet', exact: true }).click();
  const stepUp = page.getByTestId('step-up-confirm');
  await expect(stepUp).toContainText('Confirm it’s you');
  await stepUp.getByLabel('Authenticator code', { exact: true }).fill(code);
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await sheet(page).getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  const signs = () => wallet.requests.slice(signedBefore).filter((r) => r.method === 'eth_signTypedData_v4');
  await expect.poll(() => signs().length).toBe(1);

  // Pending, then done, as the venue reports it.
  const withdrawal = page.getByTestId('venue-withdrawal');
  await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText(/Pending|Done/, { timeout: 30_000 });
  await expect(withdrawal.getByTestId('venue-withdrawal-status')).toHaveText('Done', { timeout: 90_000 });

  // The venue's own record: one withdrawal, of the share, to the cold wallet; sent once.
  const record = await lockRecord();
  expect(record.offer).toMatchObject({ state: 'signed', amount, coldWallet: cold.toLowerCase() });
  const venueSays = (await venueRecord(owner, '/withdrawal', { nonce: record.offer.nonce })).value;
  expect(venueSays).toMatchObject({ amount, destination: cold.toLowerCase(), status: 'done', fee: { known: true, value: VENUE_FEE } });
  // The venue knows no agent key for the account: the wallet itself signed.
  expect((await venueRecord(owner, '/agents')).value).toEqual([]);

  // The venue account's balance falls by the venue's figure: the withdrawal and its fee.
  const after = await venueBalance(owner, 'USDC');
  expect(fromUnits(toUnits(before.total) - toUnits(after.total))).toBe(fromUnits(toUnits(venueSays.amount) + toUnits(venueSays.fee.value)));

  // Signed once: the offer now shows signed, with no way to sign it again, even after a reload.
  await page.reload();
  await connectedNow(page);
  await expect(page.getByTestId('profit-lock-signed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Sign withdrawal in my wallet', exact: true })).toHaveCount(0);
  // INTAFACED moved nothing: the person's ledger balances are the same.
  expect(await (await door()).balances()).toEqual(ledgerBefore);
  run.write({ withdrawn: true });
  await page.getByTestId('profit-lock-signed').scrollIntoViewIfNeeded();
  await stepPicture();
});

test(`${J} #5 a week later (TEST clock) passes the target again and closes the offer without signing: nothing is signed or sent; the venue balance is unchanged`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(360_000);
  const { who, owner, lockId, withdrawn } = state();
  if (!lockId || !withdrawn) throw new Error(`${J} #4 left no signed week, so there is no week to move on from`);
  // A week later: the TEST clock moves the lock's week back seven days, a day a call.
  for (let i = 0; i < 7; i += 1) await ageRecord('trade', 'profit-lock', lockId, DAY);
  const fresh = await lockRecord();
  expect(fresh.offer, 'a new week begins with no offer').toBeNull();
  expect(fresh.week.profit).toBe('0');

  await closeInProfit('week-2');
  const { week } = await lockRecord();
  const profit = await venueRealised(owner, week.from);
  expect(toUnits(profit) >= toUnits(TARGET)).toBe(true);
  await signInNow(page, who);
  await expect.poll(async () => (await readyRows(page)).count(), { timeout: 60_000 }).toBe(2);

  const wallet = await openRoom(page);
  const offer = page.getByTestId('profit-lock-offer');
  await expect(offer.getByTestId('profit-lock-amount')).toHaveText(`${shareOf(profit, SHARE)} TEST USDC`, { timeout: 30_000 });
  const before = await venueBalance(owner, 'USDC');
  const signedBefore = wallet.requests.length;

  await offer.getByRole('button', { name: 'Close offer', exact: true }).click();
  const closed = page.getByTestId('profit-lock-declined');
  await expect(closed).toContainText('You closed this week’s offer. Nothing was signed or sent.');
  await expect(page.getByTestId('profit-lock-offer')).toHaveCount(0);
  // Nothing is signed or sent: no wallet request, no withdrawal, and the venue balance is unchanged.
  expect(wallet.requests.slice(signedBefore).filter((r) => r.method === 'eth_signTypedData_v4')).toEqual([]);
  expect(await venueBalance(owner, 'USDC')).toEqual(before);
  expect((await lockRecord()).offer).toMatchObject({ state: 'declined', nonce: null });
  // It stays closed, and the week sends no other message.
  await page.reload();
  await connectedNow(page);
  await expect(page.getByTestId('profit-lock-declined')).toBeVisible({ timeout: 30_000 });
  await stepPicture();
  await expect(await readyRows(page)).toHaveCount(2);
});

test(`${J} #6 opens Profit lock while the venue can't be read (TEST switch): "Can't read the venue" with the last time it was read; no offer is made`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { who } = state();
  const lastRead = (await lockRecord()).week.lastReadAt;
  expect(lastRead).toEqual(expect.any(String));
  const switched = await testVenue('/test/switches', { venueDown: true });
  expect(switched.status).toBe(200);
  try {
    await signInNow(page, who);
    const rowsBefore = await (await readyRows(page)).count();
    await openRoom(page);
    const unread = page.getByTestId('profit-lock-unread');
    await expect(unread.getByRole('heading', { name: 'Can’t read the venue', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(unread).toContainText('It is not counted as no profit.');
    // The last time it was read: the last good read, never a time the venue was down.
    const shown = await shownAt(unread.getByTestId('profit-lock-last-read'));
    expect(shown).toBe(Date.parse((await lockRecordQuiet()).week.lastReadAt));
    expect(shown).toBeGreaterThanOrEqual(Date.parse(lastRead));
    await expect(page.getByTestId('profit-lock-profit')).toHaveCount(0);
    await expect(page.getByTestId('profit-lock-offer')).toHaveCount(0);
    await stepPicture();
    // No offer is made while it can't be read.
    await expect(await readyRows(page)).toHaveCount(rowsBefore);
  } finally {
    await testVenue('/test/switches', { venueDown: false });
  }
});

/** The lock's record while the venue is down: its last good read is the one it names. */
async function lockRecordQuiet() {
  const record = await lockRecord();
  expect(record.week.readable).toBe(false);
  expect(record.offer).toBeNull();
  return record;
}
