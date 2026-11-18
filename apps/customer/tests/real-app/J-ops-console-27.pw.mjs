// World: book, restart, gates, stack
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, STACK_PORTS, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { confirm, deskPath, openDesk, reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { ADMIN } from './admin.mjs';
import { bankOn, nextRunCode, numberShown, personApi, walletPerson } from './own-wallet-person.mjs';
import { CHAIN_ID, TOKEN_USD, connectWhenAsked, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  chainBalance,
  continueInWallet,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-ops-console-27, in the running app (docs/roadmap/journeys.json): the money loop reconciles to the cent, on the launch
// money model: INTAFACED holds none of the customer's money. One test per step, titled "J-ops-console-27 #<n>",
// run in order on one TEST account with one TEST browser wallet on the stack's TEST chain. The venue is the stack's LOCAL
// TEST venue (svc-trade's user-venue door, switched on for this file); the partner is the stack's TEST partner bank, its
// custody off, so it holds the spending money itself; the recipient of #5 is a second TEST wallet. Every signed action is
// the customer's own, signed in the TEST wallet; each figure the app shows is read from its own source at the same
// moment and kept, and #8 holds every one of them to its source. The ledger posts only our builder fee on the sale's fill.
const J = 'J-ops-console-27';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const SPOT = 'BTC-USDC';
const DESK_SYMBOL = 'BTC/USDC';
/** The row's own TEST 100 USDC, deposited into the venue account in #3. */
const DEPOSIT = '100';
/** What one `local-test-chain.mjs fund <address> venue` gives in TEST USD (seed-test-chain.ts VENUE_FUNDING). */
const VENUE_FUNDING = '100';
const BUY = '0.001';
const SELL = '0.0005';
/** TEST: the part of what is left that #8's planted break sells. */
const BREAK_SELL = '0.0002';
/** What #5 pays the recipient, and what #6 moves from the venue to spending: TEST figures. */
const PAY = '25';
const PROFIT = '20';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
/** The stack's TEST chain, read the way any wallet or explorer reads it, made on first use (the stack is up by then). */
let chainClient;
const chain = () => (chainClient ??= createPublicClient({ transport: http(testChain().gateUrl), cacheTime: 0 }));
const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const state = () => walletPerson(run, `${J} #1`);

/**
 * A figure the app showed the customer and its source's own figure, read at the same moment, kept for #8. `shown` and
 * `source` are decimal strings; `what` names the figure and its source.
 */
function keepShown(step, what, shown, source) {
  const s = run.read();
  run.write({ shown: [...(s.shown ?? []), { step, what, shown: String(shown), source: String(source), at: new Date().toISOString() }] });
}

// ---- sign-in: from #6 on the customer has an authenticator, so every sign-in takes a fresh code ----

const codeFor = () => nextRunCode(run);

async function signInNow(page) {
  const { who } = state();
  if (!run.read().secret) return signIn(page, who);
  const totpCode = await codeFor();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

let session;
test.beforeEach(() => {
  session = undefined;
});
/** The customer's own API through Edge, one sign-in per step (a fresh code once there is an authenticator). */
const door = () => (session ??= personApi(run, `${J} #1`));
const bank = bankOn(door);

/** The customer's ledger balances: every asset reads 0 (or none is listed). INTAFACED holds nothing for them. */
async function ledgerHoldsNothing(what) {
  const balances = await (await door()).balances();
  for (const [asset, row] of Object.entries(balances))
    expect(toUnits(row.total), `${what}: the ledger's ${asset} for the customer`).toBe(0n);
  return balances;
}

// ---- the founder side: svc-ledger's operator door and svc-trade's builder-fee recon, as the TEST founders read them ----

let founderDoor;
async function founders() {
  founderDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { ctx, sessions };
  })();
  return founderDoor;
}

/** One read of svc-ledger's own operator door (admin:treasury). */
async function ledgerRead(route) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}${route}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** What the ledger booked under our builder-fee key for one venue fill (`builder-fee:<venueId>:<owner>:<fillId>`). */
const builderFeeTrace = async (venueId, owner, fillId) =>
  ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(`builder-fee:${venueId}:${owner}:${fillId}`)}`);

/** The fee a builder-fee transaction books as earned: its one debit, as a decimal string. */
function bookedFee(trace) {
  const debits = trace.postings.filter((p) => p.direction === 'debit');
  expect(debits, JSON.stringify(trace).slice(0, 400)).toHaveLength(1);
  return { asset: debits[0].assetId, amount: debits[0].amount };
}

/** The builder-fee recon the console reads for a period (svc-trade `admin.builderFees.recon`), as the TEST founders read it. */
async function recon(from, to) {
  const { ctx, sessions } = await founders();
  const res = await ctx.edge.query(
    'trade',
    'admin.builderFees.recon',
    { from: from.toISOString(), to: to.toISOString() },
    await sessions.a.tradeOpsToken(),
  );
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

/** A decimal string without trailing zeros, so the venue's "0.0000100" and the console's "0.00001" compare equal. */
const dec = (s) =>
  String(s)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

/**
 * svc-trade restarted with the venue door on (as for the whole file) and the builder-fee poster on or off
 * (tooling/scripts/local-stack-services/trade.mjs): both settings in one restart, so the door never drops.
 */
async function tradeWith({ poster }) {
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_BUILDER_FEE_POSTER: poster ? undefined : 'off' });
}

// ---- the venue desk, with the customer's TEST wallet connected ----

const shownUnits = numberShown;

async function personWallet(page) {
  return installTestWallet(page, { chainId: CHAIN_ID, privateKey: state().walletKey, rpcUrl: testChain().gateUrl });
}

const venuePanel = (page) => page.getByRole('region', { name: /venue account/i });
const listed = (scope, label) => scope.locator('dt', { hasText: label }).first().locator('xpath=following-sibling::dd[1]');

/** The desk for BTC/USDC, signed in, with the customer's TEST wallet connected on its venue-account panel. */
async function venueDesk(page, { signedIn = false, wallet: installed } = {}) {
  // A page keeps the TEST wallet it was given across reloads; it is installed once per page.
  const wallet = installed ?? (await personWallet(page));
  if (signedIn) {
    await page.goto(deskPath(DESK_SYMBOL));
    await expect(page.getByRole('button', { name: 'Buy BTC', exact: true })).toBeVisible();
  } else if (run.read().secret) {
    await signInNow(page);
    await page.goto(deskPath(DESK_SYMBOL));
    await expect(page.getByRole('button', { name: 'Buy BTC', exact: true })).toBeVisible({ timeout: 30_000 });
  } else await openDesk(page, state().who, DESK_SYMBOL);
  const panel = venuePanel(page);
  await expect(panel).toBeVisible();
  const shown = wallet.address.toLowerCase();
  await connectWhenAsked(page, panel.getByText(shown), panel);
  await expect(panel).toContainText(shown);
  return { wallet, panel };
}

/** Waits until the panel shows the venue's own USDC figures, unit for unit, and keeps them for #8; returns the venue's read. */
async function panelEqualsVenue(page, step) {
  const { owner } = state();
  const panel = venuePanel(page);
  let venue;
  let shown;
  await expect(async () => {
    venue = await venueBalance(owner, 'USDC');
    shown = { free: shownUnits(await listed(panel, /^Free$/).innerText()), used: shownUnits(await listed(panel, /^Used$/).innerText()) };
    expect(shown.free, 'free').toBe(toUnits(venue.free));
    expect(shown.used, 'used').toBe(toUnits(venue.locked));
    await expect(listed(panel, /^As of$/)).toHaveText(/\d{1,2}:\d{2}/, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  keepShown(step, 'venue USDC free on the desk, from the venue', fromUnits(shown.free), venue.free);
  keepShown(step, 'venue USDC used on the desk, from the venue', fromUnits(shown.used), venue.locked);
  return venue;
}

/** The venue's fills of this account for one order, by its client order id, from the venue's own record. */
async function fillsOf(clientOrderId, since) {
  const { owner } = state();
  const fills = (await venueRecord(owner, '/fills', { since: since.toISOString() })).value;
  return fills.filter((f) => f.venueClientOrderId === clientOrderId);
}

/** TEST prices this file's own counterparties rest at: inside the TEST ladder's spread neither (they only make sure a
 * crossing order of the customer's meets enough size, at that price or better). */
const SELLER_ASK = '60100';
const BUYER_BID = '59900';

/** A TEST counterparty's resting order taken off the venue again, so nothing of this file's stays on the shared book. */
async function takeBack(name, clientOrderKey) {
  await otherTraderRun(name, { kind: 'cancel_order', symbol: SPOT, clientOrderKey });
}

/**
 * A limit order on the desk, reviewed from the venue's own preview, confirmed and signed once; returns the venue's order
 * row. `approve` answers our builder-fee approval first (a spot sell carries it).
 */
async function placeOnDesk(page, wallet, side, price, amount) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const at = side === 'buy' ? 0 : 1;
  await page.getByRole('textbox', { name: 'Price', exact: true }).nth(at).fill(price);
  // The preview of this very order: typing the price previews too, so one for another amount or side is not it.
  const previewed = page.waitForResponse((r) => {
    if (new URL(r.url()).pathname !== '/api/v1/venue/preview' || r.request().method() !== 'POST') return false;
    const intent = r.request().postDataJSON()?.intent;
    const same = (a, b) => typeof a === 'string' && toUnits(a) === toUnits(b);
    return intent?.side === side && same(intent.amount, amount) && same(intent.price, price);
  });
  await page.getByRole('textbox', { name: 'Amount', exact: true }).nth(at).fill(amount);
  const preview = await previewed;
  expect(preview.status()).toBe(200);
  await page.getByRole('button', { name: side === 'buy' ? 'Buy BTC' : 'Sell BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  const intent = preview.request().postDataJSON().intent;
  return { review, intent, preview: (await preview.json()).value };
}

// ---- Home: Spendable now and the partner's pay-in ----

async function toHome(page) {
  await page.goto('/');
  await connectWhenAsked(page, page.getByTestId('home-standing'));
  const show = page.getByRole('button', { name: 'Show balances', exact: true }).first();
  if (await show.isVisible().catch(() => false)) await show.click();
  await expect(page.getByTestId('pay-yourself-home')).toBeVisible({ timeout: 30_000 });
}
const part = (page, id) => page.getByTestId('spendable-now').locator(`li[data-spendable="${id}"]`);
const amountOf = async (locator) => (await locator.innerText()).replace(/,/g, '').replace(/ USDC?$/, '');

/** Every move on the customer's record at the TEST partner, oldest first, as its own book lists it. */
const partnerMoves = async (userId) => (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;
const payIns = (moves) => moves.filter((m) => m.key.startsWith('bank.pay-in:'));

async function mine(blocks = 1) {
  for (let i = 0; i < blocks; i += 1) {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
    });
    expect(res.status).toBe(200);
  }
}

/** The network fee a mined transaction paid, from its receipt on the TEST chain: gas used times the effective price, in wei. */
async function paidFee(hash) {
  const receipt = await chain().waitForTransactionReceipt({ hash, timeout: 60_000 });
  expect(receipt.status).toBe('success');
  return { fee: receipt.gasUsed * receipt.effectiveGasPrice, block: receipt.blockNumber };
}

/** The hashes of every transaction `from` sent in the blocks after `afterBlock` up to `head`, as the chain lists them. */
async function sentSince(from, afterBlock, head) {
  const hashes = [];
  for (let n = afterBlock + 1n; n <= head; n += 1n) {
    const block = await chain().getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) if (tx.from.toLowerCase() === from.toLowerCase()) hashes.push(tx.hash.toLowerCase());
  }
  return hashes;
}

/** TEST USD, the TEST chain's dollar token, in its own 6-decimal units, as a decimal string. */
const usd = (raw) => fromUnits(raw * 10n ** 12n);
/** TEST ETH in wei, as a decimal string. */
const eth = (wei) => {
  const s = wei.toString().padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ''}`;
};

/**
 * Sends `amount` TEST USD from the customer's wallet in the wallet room's Send, to `to`, typing its last four: one send,
 * signed in the wallet. Returns the transaction hash the page names and the network fee line it shows once mined.
 */
async function sendFromWallet(page, wallet, to, amount, { prefilled = false } = {}) {
  const form = page.getByRole('form', { name: 'Send', exact: true });
  await expect(form).toBeVisible({ timeout: 30_000 });
  if (!prefilled) {
    await form.getByRole('combobox', { name: 'Token', exact: true }).selectOption({ label: TOKEN_USD.name });
    await form.getByRole('textbox', { name: /^To/ }).fill(to);
  } else {
    await expect(form.getByRole('combobox', { name: 'Token', exact: true })).toHaveValue(new RegExp(`^${TOKEN_USD.address}$`, 'i'));
    await expect(form.getByRole('textbox', { name: /^To/ })).toHaveValue(to);
  }
  await form.getByRole('textbox', { name: /^Amount/ }).fill(amount);
  await form.getByRole('button', { name: 'Review', exact: true }).click();
  const summary = page.getByRole('dialog', { name: 'Review the send', exact: true });
  await expect(summary).toContainText(`${amount} ${TOKEN_USD.name}`);
  await summary.getByRole('textbox', { name: /^Last four characters/ }).fill(to.slice(-4));
  const sendsBefore = wallet.sends.length;
  await summary.getByRole('button', { name: 'Send', exact: true }).click();
  const representation = page.locator('[data-panel="representation"]');
  const sheet = page.locator('[data-sheet="sign"]');
  await expect(representation.or(sheet).first()).toBeVisible({ timeout: 30_000 });
  if (await representation.isVisible()) {
    // A fresh wallet accepts the representation once before its first signing action (J-dex-protocol-01 #8): a signed
    // message, never a transfer.
    await representation.getByLabel('I have read this and it is true for me.', { exact: true }).check();
    await representation.getByRole('button', { name: 'Accept and sign', exact: true }).click();
    await sheet.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
    await expect(representation).toHaveCount(0);
  }
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  const sent = page.getByText(/^Sent to the network\. Transaction 0x[0-9a-fA-F]{64}\.$/);
  await expect(sent).toBeVisible({ timeout: 30_000 });
  const hash = /0x[0-9a-fA-F]{64}/.exec(await sent.innerText())[0].toLowerCase();
  // One send, signed in the wallet.
  expect(wallet.sends.length - sendsBefore, 'the wallet sends once').toBe(1);
  expect(wallet.sends.at(-1).method).toBe('eth_sendTransaction');
  return { hash, feeLine: page.getByTestId('send-network-fee') };
}

/** The send's network fee as the page shows it, equal to what the chain's receipt says it paid; kept for #8. */
async function feeShownEqualsChain(step, feeLine, hash) {
  const { fee } = await paidFee(hash);
  await expect(feeLine).toHaveAttribute('data-fee', /^(known|unknown)$/, { timeout: 60_000 });
  if ((await feeLine.getAttribute('data-fee')) === 'known') {
    await expect
      .poll(async () => BigInt(await feeLine.getAttribute('data-fee-units')), 'the network fee shown is the one the chain charged')
      .toBe(fee);
    await expect(feeLine).toContainText(`Network fee: ${eth(fee)} ETH`);
    keepShown(step, `network fee of ${hash}, from the chain`, eth(BigInt(await feeLine.getAttribute('data-fee-units'))), eth(fee));
  } else await expect(feeLine).toHaveText(/Network fee: not known/);
  return fee;
}

test(`${J} #1 signs up as a fresh customer: a new signed-in account; INTAFACED holds nothing for it and the ledger has no balance for it`, async ({
  page,
  stepPicture,
}) => {
  const who = await signUp(page, 'jm');
  run.reset({ who, walletKey: testWalletKey() });
  await expect(page.getByRole('main').getByText('Verify your identity first', { exact: true }).first()).toBeVisible();
  const asked = new URL(page.url());
  run.write({ askedAt: `${asked.pathname}${asked.search}` });
  const me = await door();
  expect(me.userId).toMatch(/^[0-9a-f-]{36}$/);
  run.write({ userId: me.userId });
  // Signed in in this browser: the account menu names this new account, not yet verified.
  const menu = page.getByRole('button', { name: 'Account menu', exact: true });
  await menu.click();
  const summary = page.getByTestId('account-summary');
  await expect(summary).toHaveAttribute('aria-busy', 'false');
  await expect(summary).toContainText(`@${who.handle}`);
  await expect(summary).toContainText(`Account ID ${me.userId.slice(0, 8)}…`);
  await expect(summary).toContainText('Verification: Not verified');
  await stepPicture();
  await page.keyboard.press('Escape');
  // INTAFACED holds nothing for it: the ledger lists no balance for the customer, or only zeros.
  await ledgerHoldsNothing('a new account');
});

test(`${J} #2 passes TEST verification: the account reads as fully verified, and the app stops asking to verify`, async ({ page }) => {
  const { who, askedAt } = state();
  if (!askedAt) throw new Error(`${J} #1 kept no page that asked to verify, so this step cannot see it stop asking`);
  await signIn(page, who);
  // The guided request in the app, then the stack's two TEST operators approve it through identity's review door.
  await verify(page, who);
  const kyc = await (await door()).get(`/api/identity/trpc/kyc.status?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`);
  expect(kyc.status, JSON.stringify(kyc.body).slice(0, 300)).toBe(200);
  expect(kyc.body.result.data.tier).toBe('full');
  // Signed in again: fully verified in the account menu; the page that asked in #1 asks no more; Trade reads verified.
  await signIn(page, who);
  await page.goto(askedAt);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await expect(page.getByTestId('account-summary')).toContainText('Verification: Full');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('main').getByText('Verify your identity first', { exact: true })).toHaveCount(0);
  await page.goto('/trade');
  await page.mouse.move(0, 600);
  await expect(page.getByTestId('trade-access')).toHaveAttribute('data-state', 'verified');
  await expect(page.getByText('Verify to trade', { exact: true })).toHaveCount(0);
});

test(`${J} #3 connects a TEST wallet holding TEST USDC and deposits TEST 100 USDC into the venue account: the wallet signs one deposit; the venue's credit read back with its as-of time and shown exactly; the ledger records nothing for the customer`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  // The TEST wallet holding TEST USDC: the stack's TEST chain gives it TEST ETH for gas and TEST USD, twice, so #5 has
  // some left to pay with. The TEST venue pays withdrawals out from its TEST deposit address, which gets its own TEST USD.
  for (let i = 0; i < 2; i += 1) fundOnTestChain(owner, 'venue');
  const route = (await testVenue('/venue')).body.deposit;
  expect(route, 'the TEST venue publishes its TEST deposit route').toMatchObject({ chainId: CHAIN_ID, asset: 'USDC' });
  expect(route.token.toLowerCase()).toBe(TOKEN_USD.address.toLowerCase());
  fundOnTestChain(route.address, 'venue');
  const walletBefore = await chainBalance(TOKEN_USD.address, owner);
  expect(walletBefore).toBe((2n * toUnits(VENUE_FUNDING)) / 10n ** 12n);
  expect(toUnits((await venueBalance(owner, 'USDC')).total)).toBe(0n);
  const { wallet, panel } = await venueDesk(page);
  // Deposits from the wallet into the venue account: the wallet signs and sends one transfer.
  const sent = wallet.sends.length;
  const signed = wallet.requests.length;
  await panel.getByRole('button', { name: /^Deposit/ }).click();
  const deposit = page.getByRole('dialog', { name: /deposit/i });
  await deposit.getByRole('textbox', { name: /^Amount/ }).fill(DEPOSIT);
  await deposit
    .getByRole('button', { name: /deposit|sign/i })
    .last()
    .click();
  await continueInWallet(page);
  await expect.poll(() => wallet.sends.length, { timeout: 30_000 }).toBe(sent + 1);
  expect(wallet.requests.length, 'nothing else is signed for the deposit').toBe(signed);
  // The wallet keeps the send as it is asked, and its hash once the node has taken it.
  await expect
    .poll(() => wallet.sends.at(-1).hash ?? null, { message: 'the wallet sent the deposit as a chain transfer', timeout: 30_000 })
    .toMatch(/^0x[0-9a-f]{64}$/);
  const hash = wallet.sends.at(-1).hash;
  await paidFee(hash);
  expect(await chainBalance(TOKEN_USD.address, owner), 'the wallet moved exactly the deposit').toBe(
    walletBefore - toUnits(DEPOSIT) / 10n ** 12n,
  );
  // The venue credits it once: free 100, used 0, read back from the venue with its as-of time, and the desk shows exactly that.
  await expect.poll(async () => (await venueBalance(owner, 'USDC')).free, { timeout: 120_000 }).toMatch(/^100(\.0+)?$/);
  const venue = await panelEqualsVenue(page, 3);
  expect(toUnits(venue.free)).toBe(toUnits(DEPOSIT));
  const asOf = (await testVenue('/balances', { account: { venueId: (await venueInfo()).id, owner, subAccount: null } })).body.asOf;
  expect(Date.parse(asOf), 'the venue dates its read').not.toBeNaN();
  // The ledger records nothing for the customer.
  await ledgerHoldsNothing('after the venue deposit');
});

test(`${J} #4 buys on the desk, then sells part of it back: one signature and one venue order each; each fill and its fee as the venue reports it; no builder fee on the buy; our builder fee for the sale's fill on the ledger once, equal to the venue's`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const { owner } = state();
  const { id: venueId } = await venueInfo();
  // TEST counterparties of this file's own on the venue, so whatever the shard left on the ladder, each order meets its
  // whole size: a seller resting the buy's size, a buyer resting the sale's size. Each is taken off again after the step.
  const ask = toUnits(SELLER_ASK);
  const bid = toUnits(BUYER_BID);
  const seller = `${J}-seller-${process.env.JOURNEY_RUN_ID ?? 'local'}`;
  const buyer = `${J}-buyer-${process.env.JOURNEY_RUN_ID ?? 'local'}`;
  await testDeposit(otherTraderKey(seller).address, 'BTC', BUY, `seed:${seller}:${owner}:BTC`);
  await testDeposit(otherTraderKey(buyer).address, 'USDC', '1000', `seed:${buyer}:${owner}:USDC`);
  for (const [name, side, size, price] of [
    [seller, 'sell', BUY, ask],
    [buyer, 'buy', SELL, bid],
  ]) {
    const rested = await otherTraderRun(name, {
      kind: 'place_order',
      symbol: SPOT,
      side,
      type: 'limit',
      amount: size,
      price: fromUnits(price),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${name}:${owner}`,
      builderFee: null,
    });
    expect(rested, JSON.stringify(rested).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  }
  try {
    const ledgerBefore = await ledgerHoldsNothing('before the trades');
    const { wallet } = await venueDesk(page);

    // The buy: one signature, one venue order; the venue's preview carries no builder fee.
    const buySince = new Date(Date.now() - 1_000);
    const buy = await placeOnDesk(page, wallet, 'buy', fromUnits(ask), BUY);
    expect(toUnits(buy.preview.builderFee.value.amount), 'a spot buy carries no builder fee').toBe(0n);
    await expect(listed(buy.review, /builder fee/i)).toHaveText(/none/i);
    const beforeBuy = wallet.requests.length;
    await confirm(page, 'buy');
    await continueInWallet(page);
    await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(beforeBuy + 1);
    expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
    let buyFills = [];
    await expect
      .poll(
        async () => {
          // The account is this run's own, so its only order on this side placed since then is this one.
          const orders = (await venueRecord(owner, '/order-history')).value.filter(
            (r) => r.order.side === 'buy' && new Date(r.placedAt) >= buySince,
          );
          if (orders.length !== 1) return `orders ${orders.length}`;
          buyFills = await fillsOf(orders[0].order.venueClientOrderId, buySince);
          return fromUnits(buyFills.reduce((s, f) => s + toUnits(f.amount), 0n));
        },
        { timeout: 30_000 },
      )
      .toBe(fromUnits(toUnits(BUY)));
    for (const f of buyFills) {
      expect(f.side).toBe('buy');
      expect(toUnits(f.builderFee), 'no builder fee on a spot buy').toBe(0n);
    }

    // The sale of part of it: our builder fee is approved once in the wallet, then the order is signed once.
    const sellSince = new Date(Date.now() - 1_000);
    const sell = await placeOnDesk(page, wallet, 'sell', fromUnits(bid), SELL);
    const sheet = reviewSheet(page);
    const builderLine = sheet.locator('[data-line="builder-fee"]');
    const approval = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true });
    if (await approval.isVisible().catch(() => false)) {
      const asked = wallet.requests.length;
      await approval.click();
      await continueInWallet(page);
      await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
      await expect(builderLine).not.toContainText('Not signed', { timeout: 20_000 });
    }
    expect(toUnits(sell.preview.builderFee.value.amount) > 0n, 'a spot sell carries our builder fee').toBe(true);
    const beforeSell = wallet.requests.length;
    await expect(sheet.getByRole('button', { name: 'Confirm sell', exact: true })).toBeEnabled({ timeout: 20_000 });
    await confirm(page, 'sell');
    await continueInWallet(page);
    await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(beforeSell + 1);
    expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
    let sellFills = [];
    await expect
      .poll(
        async () => {
          // The account is this run's own, so its only order on this side placed since then is this one.
          const orders = (await venueRecord(owner, '/order-history')).value.filter(
            (r) => r.order.side === 'sell' && new Date(r.placedAt) >= sellSince,
          );
          if (orders.length !== 1) return `orders ${orders.length}`;
          sellFills = await fillsOf(orders[0].order.venueClientOrderId, sellSince);
          return fromUnits(sellFills.reduce((s, f) => s + toUnits(f.amount), 0n));
        },
        { timeout: 30_000 },
      )
      .toBe(fromUnits(toUnits(SELL)));
    for (const f of sellFills) {
      expect(f.side).toBe('sell');
      expect(toUnits(f.builderFee) > 0n, 'the sale carries our builder fee').toBe(true);
    }

    // Each fill and its fees, shown on the desk as the venue reports them.
    await venueDesk(page, { signedIn: true, wallet });
    await page
      .locator('[role=tab]', { hasText: /^(Order history|Trade history|Fills)$/ })
      .first()
      .click();
    const history = page.getByTestId('venue-fills');
    for (const f of [...buyFills, ...sellFills]) {
      const row = history.locator(`tr[data-fill="${f.fillId}"]`);
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      const heads = (await row.locator('xpath=ancestor::table//th').allInnerTexts()).map((h) => h.trim());
      const cells = await row.locator('td').allInnerTexts();
      const col = (name) => {
        const i = heads.findIndex((h) => name.test(h));
        expect(i, `${name} in ${heads.join(' | ')}`).toBeGreaterThanOrEqual(0);
        return cells[i];
      };
      expect(shownUnits(col(/^Price$/)), `${f.fillId} price`).toBe(toUnits(f.price));
      await expect
        .poll(async () => shownUnits(await row.locator('[data-cell="amount"]').innerText()), `${f.fillId} amount`)
        .toBe(toUnits(f.amount));
      expect(shownUnits(col(/venue.?s fee|^Fee$/i)), `${f.fillId} venue fee`).toBe(toUnits(f.venueFee));
      keepShown(4, `fill ${f.fillId} venue fee, from the venue`, fromUnits(shownUnits(col(/venue.?s fee|^Fee$/i))), f.venueFee);
      const builder = col(/builder fee/i);
      if (toUnits(f.builderFee) === 0n) expect(builder).toMatch(/none|^0(\.0+)?/i);
      else {
        expect(shownUnits(builder), `${f.fillId} builder fee`).toBe(toUnits(f.builderFee));
        keepShown(4, `fill ${f.fillId} builder fee, from the venue`, fromUnits(shownUnits(builder)), f.builderFee);
      }
    }
    await panelEqualsVenue(page, 4);

    // The ledger: our builder fee for each of the sale's fills, booked once under its fill's own key, equal to the venue's.
    for (const f of sellFills) {
      await expect.poll(async () => (await builderFeeTrace(venueId, owner, f.fillId)).found, { timeout: 60_000 }).toBe(true);
      const booked = bookedFee(await builderFeeTrace(venueId, owner, f.fillId));
      expect(booked.asset).toBe(f.feeAsset);
      expect(dec(booked.amount), `the ledger's builder fee for ${f.fillId} is the venue's`).toBe(dec(f.builderFee));
    }
    // Nothing for the buy: no builder fee was charged, so none was booked (the poster has run past it: the sale is booked).
    for (const f of buyFills) expect((await builderFeeTrace(venueId, owner, f.fillId)).found, `${f.fillId} booked nothing`).toBe(false);
    // Nothing on the ledger for the customer.
    expect(await (await door()).balances()).toEqual(ledgerBefore);
    run.write({ sellFills, loopFrom: buySince.toISOString() });
  } finally {
    await takeBack(seller, `order:${seller}:${owner}`).catch(() => undefined);
    await takeBack(buyer, `order:${buyer}:${owner}`).catch(() => undefined);
  }
});

test(`${J} #5 pays a person: one send signed by the customer's wallet to the recipient's wallet; both wallets read back from the chain, moved by exactly the amount; the network fee shown or "not known"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  // The person paid: their own TEST wallet, made for this run.
  const recipient = privateKeyToAccount(testWalletKey()).address;
  run.write({ recipient });
  const before = { from: await chainBalance(TOKEN_USD.address, owner), to: await chainBalance(TOKEN_USD.address, recipient) };
  const fromBlock = await chain().getBlockNumber();
  expect(before.from >= toUnits(PAY) / 10n ** 12n, 'the wallet holds the payment').toBe(true);
  const wallet = await personWallet(page);
  await signInNow(page);
  await page.goto('/wallet/send');
  await connectWhenAsked(page, page.getByRole('button', { name: 'Disconnect', exact: true }));
  const { hash, feeLine } = await sendFromWallet(page, wallet, recipient, PAY);
  await paidFee(hash);
  // Both wallets, read back from the chain: moved by exactly the amount.
  const raw = toUnits(PAY) / 10n ** 12n;
  expect(await chainBalance(TOKEN_USD.address, owner), 'the sender paid exactly the amount').toBe(before.from - raw);
  expect(await chainBalance(TOKEN_USD.address, recipient), 'the recipient got exactly the amount').toBe(before.to + raw);
  // The network fee: shown as the chain charged it, or "not known"; it was paid in TEST ETH, apart from the amount.
  await feeShownEqualsChain(5, feeLine, hash);
  // One send: the only transaction from the wallet since the step began is this one.
  const head = await chain().getBlockNumber();
  expect(await sentSince(owner, fromBlock, head), 'the wallet sent one transaction').toEqual([hash.toLowerCase()]);
  keepShown(5, 'amount sent, from the chain', PAY, usd(before.from - (await chainBalance(TOKEN_USD.address, owner))));
  await ledgerHoldsNothing('after the send');
});

test(`${J} #6 moves profit to spending: a signed venue withdrawal to the wallet, then a signed send to the TEST partner account; each leg sent once and read back from its source with its fee or "not known"; trading and spending each shown as their source reports, never added into one INTAFACED balance`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const { owner, userId } = state();
  // The partner holds the spending money itself (custody off), as at launch.
  await bank.mutate('testPartner.set', { custody: 'off' });
  // A second factor, from Security: a venue withdrawal is a stepped-up action.
  await signIn(page, state().who);
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  session = undefined;

  // Leg 1: the venue withdraws TEST 20 USDC to the wallet, signed once, after the step-up.
  const before = await venueBalance(owner, 'USDC');
  const walletBefore = await chainBalance(TOKEN_USD.address, owner);
  const { wallet, panel } = await venueDesk(page, { signedIn: true });
  const asked = wallet.requests.length;
  await panel.getByRole('button', { name: /^Withdraw/ }).click();
  const form = page.getByRole('dialog', { name: /withdraw/i });
  await form.getByRole('textbox', { name: /^Amount/ }).fill(PROFIT);
  await form
    .getByRole('button', { name: /withdraw|sign|confirm/i })
    .last()
    .click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it’s you', exact: true });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel('Authenticator code or recovery code', { exact: true }).fill(await codeFor());
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  const shown = page.getByTestId('venue-withdrawal').first();
  await expect(shown).toContainText(/pending|done/i, { timeout: 20_000 });
  const nonce = await shown.getAttribute('data-nonce');
  expect(nonce, 'the withdrawal names the venue nonce it was signed with').toBeTruthy();
  // The venue's own chain sender pays it out after its withdrawal delay and settles it done with the payment's hash.
  await expect(shown).toContainText(/done/i, { timeout: 60_000 });
  const w = (await venueRecord(owner, '/withdrawal', { nonce })).value;
  expect(w).toMatchObject({ asset: 'USDC', status: 'done', destination: owner });
  expect(toUnits(w.amount)).toBe(toUnits(PROFIT));
  expect(w.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  // Its fee, from the venue, shown or "not known".
  const fee = shown
    .locator('div', { has: page.locator('dt', { hasText: /fee/i }) })
    .locator('dd')
    .first();
  if (w.fee.known) {
    await expect.poll(async () => shownUnits(await fee.innerText())).toBe(toUnits(w.fee.value));
    keepShown(6, 'venue withdrawal fee, from the venue', fromUnits(shownUnits(await fee.innerText())), w.fee.value);
  } else await expect(fee).toHaveText(/not known/i);
  // What arrived, read from the chain: the withdrawal less any network fee the venue took from it.
  await paidFee(w.txHash);
  const arrived = (await chainBalance(TOKEN_USD.address, owner)) - walletBefore;
  expect(arrived > 0n && arrived <= toUnits(PROFIT) / 10n ** 12n, `${usd(arrived)} arrived of ${PROFIT}`).toBe(true);
  const after = await venueBalance(owner, 'USDC');
  expect(toUnits(before.total) - toUnits(after.total)).toBe(toUnits(PROFIT) + (w.fee.known ? toUnits(w.fee.value) : 0n));
  expect(wallet.requests.length, 'the withdrawal was signed once').toBe(asked + 1);

  // Leg 2: from Home, the partner's pay-in for this customer, and Send in the wallet with it filled in.
  await toHome(page);
  const summary = await bank.query('payYourself.summary');
  expect(summary.payIn, JSON.stringify(summary.payIn)).toMatchObject({ label: 'TEST', chainId: CHAIN_ID });
  expect(summary.payIn.token.toLowerCase()).toBe(TOKEN_USD.address.toLowerCase());
  const routeBox = page.getByTestId('pay-in-route');
  await expect(routeBox.locator('[data-pay-in="address"] code')).toHaveText(summary.payIn.address);
  const partnerFee = routeBox.locator('[data-pay-in="partner-fee"]');
  if (summary.partnerFee === null) await expect(partnerFee).toHaveText('not known');
  else await expect.poll(async () => shownUnits(await partnerFee.innerText())).toBe(toUnits(summary.partnerFee));
  const creditedBefore = payIns(await partnerMoves(userId)).length;
  await routeBox.locator('[data-pay-in="send"]').click();
  await expect(page).toHaveURL(/\/wallet\/send\?/);
  await connectWhenAsked(page, page.getByRole('button', { name: 'Disconnect', exact: true }));
  const amount = usd(arrived);
  const sent = await sendFromWallet(page, wallet, summary.payIn.address, amount, { prefilled: true });
  await feeShownEqualsChain(6, sent.feeLine, sent.hash);
  // The partner sees it pending, then credits it once after its confirmations, keyed by the transfer itself.
  await toHome(page);
  const credit = page.getByTestId('pay-in-credits').locator(`li[data-pay-in-credit="${sent.hash}"]`);
  await expect(credit).toHaveAttribute('data-status', 'pending', { timeout: 60_000 });
  await expect(page.getByTestId('on-its-way').locator(`li[data-credit="${sent.hash}"]`)).toContainText(
    `${amount} USDC: your wallet sent it`,
  );
  await mine(summary.payIn.confirmations);
  await expect(credit).toHaveAttribute('data-status', 'available', { timeout: 60_000 });
  const moves = payIns(await partnerMoves(userId));
  expect(moves.length - creditedBefore, 'the partner credited the send once').toBe(1);
  const move = moves.find((m) => m.key.includes(sent.hash));
  expect(move?.key).toBe(`bank.pay-in:usdc:${CHAIN_ID}:${sent.hash}:0`);
  expect(sameDecimal(move.amount, amount), `${move?.amount} credited for ${amount} sent`).toBe(true);
  await expect.poll(async () => shownUnits(await credit.locator('[data-credit-amount]').innerText())).toBe(toUnits(move.amount));
  keepShown(
    6,
    'partner credit of the send, from the partner',
    fromUnits(shownUnits(await credit.locator('[data-credit-amount]').innerText())),
    move.amount,
  );

  // Trading and spending, each as its own source reports it, side by side and never one INTAFACED balance: on Home the
  // partner's figure and the venue's withdrawable figure, each with its source; and the ledger holds nothing for either.
  const venueNow = await venueBalance(owner, 'USDC');
  const partnerRow = part(page, 'partner');
  await expect(partnerRow.locator('[data-part-source]')).toContainText('the partner’s own figure, as of');
  await expect
    .poll(async () => sameDecimal(await amountOf(partnerRow.locator('[data-part-amount]')), move.amount), { timeout: 30_000 })
    .toBe(true);
  keepShown(6, 'spending at the partner on Home, from the partner', await amountOf(partnerRow.locator('[data-part-amount]')), move.amount);
  const venueRow = part(page, 'venue');
  await expect(venueRow.locator('[data-part-source]')).toContainText('the venue’s own figure, as of');
  await expect
    .poll(async () => sameDecimal(await amountOf(venueRow.locator('[data-part-amount]')), venueNow.free), { timeout: 30_000 })
    .toBe(true);
  keepShown(6, 'trading on the venue on Home, from the venue', await amountOf(venueRow.locator('[data-part-amount]')), venueNow.free);
  await ledgerHoldsNothing('after moving profit to spending');
});

test(`${J} #7 withdraws what is left on the venue to the TEST wallet: the wallet signs one venue withdrawal; its amount and the venue's fee read back from the venue and the chain; the venue account reads empty; the ledger records nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner } = state();
  const before = await venueBalance(owner, 'USDC');
  expect(toUnits(before.locked), 'nothing is locked behind an order').toBe(0n);
  // What is left: the venue's free USDC less the withdrawal fee the venue publishes for it.
  const terms = (await testVenue('/withdrawal-terms', { asset: 'USDC' })).body.value;
  const published = terms.fee.known ? toUnits(terms.fee.value) : null;
  const leftUnits = toUnits(before.free) - (published ?? 0n);
  expect(leftUnits > 0n, `free ${before.free} covers the fee ${published === null ? 'not known' : fromUnits(published)}`).toBe(true);
  const left = fromUnits(leftUnits);
  const walletBefore = await chainBalance(TOKEN_USD.address, owner);
  await signInNow(page);
  const { wallet, panel } = await venueDesk(page, { signedIn: true });
  const asked = wallet.requests.length;
  await panel.getByRole('button', { name: /^Withdraw/ }).click();
  const form = page.getByRole('dialog', { name: /withdraw/i });
  await form.getByRole('textbox', { name: /^Amount/ }).fill(left);
  await form
    .getByRole('button', { name: /withdraw|sign|confirm/i })
    .last()
    .click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it’s you', exact: true });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel('Authenticator code or recovery code', { exact: true }).fill(await codeFor());
  await stepUp.getByRole('button', { name: 'Confirm', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  const shown = page.getByTestId('venue-withdrawal').first();
  await expect(shown).toContainText(/pending|done/i, { timeout: 20_000 });
  const nonce = await shown.getAttribute('data-nonce');
  // The venue's own chain sender pays it out after its withdrawal delay and settles it done with the payment's hash.
  await expect(shown).toContainText(/done/i, { timeout: 60_000 });
  const w = (await venueRecord(owner, '/withdrawal', { nonce })).value;
  expect(w).toMatchObject({ asset: 'USDC', status: 'done', destination: owner });
  // Its amount and the venue's fee, from the venue, as the app shows them.
  expect(toUnits(w.amount)).toBe(leftUnits);
  const fee = shown
    .locator('div', { has: page.locator('dt', { hasText: /fee/i }) })
    .locator('dd')
    .first();
  if (w.fee.known) {
    await expect.poll(async () => shownUnits(await fee.innerText())).toBe(toUnits(w.fee.value));
    keepShown(7, 'venue withdrawal fee, from the venue', fromUnits(shownUnits(await fee.innerText())), w.fee.value);
  } else await expect(fee).toHaveText(/not known/i);
  // And from the chain: the transfer the venue paid out landed in the wallet.
  await paidFee(w.txHash);
  const arrived = (await chainBalance(TOKEN_USD.address, owner)) - walletBefore;
  const networkFee = w.networkFee?.known ? toUnits(w.networkFee.value) / 10n ** 12n : null;
  if (networkFee !== null) expect(arrived).toBe(leftUnits / 10n ** 12n - networkFee);
  else expect(arrived > 0n && arrived <= leftUnits / 10n ** 12n).toBe(true);
  // The venue account reads empty: no USDC left on it, and the desk shows the venue's own figures.
  const after = await venueBalance(owner, 'USDC');
  expect(toUnits(after.total), 'the venue account holds no USDC').toBe(0n);
  await panelEqualsVenue(page, 7);
  await ledgerHoldsNothing('after the last withdrawal');
});

test(`${J} #8 the founder runs the reconciliation: the ledger's own records for the loop equal what the venue and the partner report, to the cent, and the control PASSes; every figure shown in #3 to #7 equals its source; a difference is a break row, never an entry posted to make them agree`, async ({
  founders,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const { owner, sellFills, loopFrom, shown = [], userId } = state();
  if (!sellFills?.length || !loopFrom) throw new Error(`${J} #4 kept no sale, so the loop has nothing of ours to reconcile`);
  const { id: venueId } = await venueInfo();
  const from = new Date(loopFrom);
  const to = new Date(Date.now() + 10 * 60_000);

  // The ledger's own records for the loop: our builder fee on the sale's fill, and nothing for the customer.
  await ledgerHoldsNothing('at the reconciliation');
  for (const f of sellFills) expect(dec(bookedFee(await builderFeeTrace(venueId, owner, f.fillId)).amount)).toBe(dec(f.builderFee));
  // Any fee of ours on the send: none, so the partner's record of the customer carries no move of ours, only their pay-ins.
  const moves = await partnerMoves(userId);
  expect(
    moves.filter((m) => !m.key.startsWith('bank.pay-in:')),
    JSON.stringify(moves).slice(0, 400),
  ).toEqual([]);

  // The founder runs the builder-fee reconciliation for the loop's period in the console: the venue's own builder fee on
  // each fill against the ledger's, and the venue's own totals for our builder address against the ledger's: it PASSes.
  // Polled until it reads matched; on a timeout the recon's own verdict, break rows and totals are what it shows.
  await expect
    .poll(
      async () => {
        const v = (await recon(from, to)).venues.find((one) => one.venueId === venueId);
        if (!v || v.matched) return v ? 'matched' : 'venue not read';
        const breaks = v.lines.filter((l) => l.status !== 'matched' && l.status !== 'not_our_order');
        return JSON.stringify({ verdict: v.verdict, compared: v.compared, totals: v.totals, venueTotals: v.venueTotals, breaks }).slice(
          0,
          2500,
        );
      },
      { timeout: 90_000 },
    )
    .toBe('matched');
  const { page } = await founders.console('a');
  const open = async () => {
    await page.goto(`${ADMIN}/ledger/treasury?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
    await expect(page.getByRole('heading', { name: 'Builder-fee recon', exact: true })).toBeVisible({ timeout: 60_000 });
    return page.locator(`[data-testid="builder-fee-venue"][data-venue-id="${venueId}"]`);
  };
  const venue = await open();
  await expect(venue).toHaveAttribute('data-state', 'green');
  await expect(venue.getByTestId('builder-fee-verdict')).toContainText('Green: every builder fee the venue reports matches the ledger.');
  for (const f of sellFills) {
    const row = venue.getByTestId('builder-fee-lines').locator(`tr[data-fill-id="${f.fillId}"]`);
    await expect(row).toHaveAttribute('data-state', 'matched');
    const cells = row.locator('td');
    await expect.poll(async () => dec(await cells.nth(4).innerText()), 'the venue’s builder fee, to the cent').toBe(dec(f.builderFee));
    await expect.poll(async () => dec(await cells.nth(5).innerText()), 'the ledger’s builder fee, to the cent').toBe(dec(f.builderFee));
  }
  await stepPicture(page);

  // Every figure the app showed the customer in #3 to #7 equals its source, read at the same moment.
  for (const step of [3, 4, 5, 6, 7])
    expect(shown.filter((s) => s.step === step).length, `#${step} kept what it showed`).toBeGreaterThan(0);
  for (const s of shown) expect(sameDecimal(s.shown, s.source), `#${s.step} ${s.what}: shown ${s.shown}, source ${s.source}`).toBe(true);

  // A difference is a break row, never an entry posted to make them agree: with the poster stopped, the customer's own
  // sale of part of the BTC they still hold, sent through our door and signed by their wallet key, carries our builder fee
  // the ledger does not have yet. The recon names that fill as a break; the ledger books nothing for it then, and books the
  // fee itself, once, when the poster runs again.
  const counter = `${J}-break-bid-${process.env.JOURNEY_RUN_ID ?? 'local'}-${randomBytes(3).toString('hex')}`;
  const counterKey = `order:${counter}:buy`;
  const limit = (side, timeInForce, clientOrderKey) => ({
    kind: 'place_order',
    symbol: SPOT,
    side,
    type: 'limit',
    amount: BREAK_SELL,
    price: BUYER_BID,
    timeInForce,
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  });
  await tradeWith({ poster: false });
  let fill;
  try {
    await testDeposit(otherTraderKey(counter).address, 'USDC', '1000', `seed:${counter}:USDC`);
    expect(await otherTraderRun(counter, limit('buy', 'GTC', counterKey))).toMatchObject({ definite: true, accepted: true });
    const breakFrom = new Date(Date.now() - 1_000);
    const me = await door();
    const prepared = await me.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: limit('sell', 'IOC', `order:${J}:break:${owner}:${randomBytes(3).toString('hex')}`),
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
    const { typedData: t, digest } = prepared.body.prepared;
    const signature = await privateKeyToAccount(state().walletKey).signTypedData({
      domain: t.domain,
      types: t.types,
      primaryType: t.primaryType,
      message: t.message,
    });
    const sent = await me.post('/api/v1/venue/submit', {
      actionKey: prepared.body.actionKey,
      signature: { digest, signature, signedBy: owner },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
    expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
    await expect
      .poll(
        async () => {
          fill = (await venueRecord(owner, '/fills', { since: breakFrom.toISOString() })).value.find((f) => toUnits(f.builderFee) > 0n);
          return fill ? 'filled' : 'none';
        },
        { timeout: 30_000 },
      )
      .toBe('filled');
    await expect
      .poll(
        async () => {
          const line = (await recon(from, to)).venues.find((v) => v.venueId === venueId)?.lines.find((l) => l.fillId === fill.fillId);
          return line ? { status: line.status, ledgerAmount: line.ledgerAmount } : 'no line';
        },
        { timeout: 30_000 },
      )
      .toEqual({ status: 'not_in_ledger', ledgerAmount: null });
    const broken = await open();
    await expect(broken).toHaveAttribute('data-state', 'break');
    await expect(broken.getByTestId('builder-fee-verdict')).toContainText('Break: the venue and the ledger do not agree.');
    const row = broken.getByTestId('builder-fee-lines').locator(`tr[data-fill-id="${fill.fillId}"]`);
    await expect(row).toHaveAttribute('data-state', 'not_in_ledger');
    await expect(row.locator('td').nth(5)).toHaveText('none');
    // Nothing was posted to make them agree.
    expect((await builderFeeTrace(venueId, owner, fill.fillId)).found).toBe(false);
  } finally {
    await tradeWith({ poster: true });
    await takeBack(counter, counterKey);
  }
  // The poster books the fee itself, once, and the recon reads green again.
  await expect.poll(async () => (await builderFeeTrace(venueId, owner, fill.fillId)).found, { timeout: 60_000 }).toBe(true);
  expect(dec(bookedFee(await builderFeeTrace(venueId, owner, fill.fillId)).amount)).toBe(dec(fill.builderFee));
  await expect
    .poll(async () => (await recon(from, to)).venues.find((v) => v.venueId === venueId)?.matched ?? null, { timeout: 60_000 })
    .toBe(true);
});
