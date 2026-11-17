// World: freeze, gates
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fund, ORIGIN, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN } from './identity-factors.mjs';
import { acceptRepresentation, dexRun, testChain, TOKEN_USD } from './dex.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';
import { METHOD, browserHoldsPasskey, confirmEmail, p2p, testInstrument, testPasskey } from './p2p.mjs';

// J-p2p-21, in the running app (docs/roadmap/journeys.json): a P2P order whose escrow is a contract on the TEST chain
// instead of the ledger. One test per step, titled "J-p2p-21 #<n>", run in order. A verified TEST seller posts a TEST
// USDT sell ad; a verified TEST buyer takes it and chooses the contract escrow. On the stack's LOCAL TEST chain (anvil,
// chain id 84532) the seller's TEST wallet opens and funds a SovereignEscrow deal in TEST USD, which carries the ad's
// USDT there (tooling/scripts/local-stack-services/p2p.mjs). The coins sit in the contract; svc-p2p posts nothing to
// the ledger for this order and reads the deal from the chain. Fiat never moves.
const J = 'J-p2p-21';
const buyerRun = dexRun(J);
const sellerRun = dexRun(`${J}-seller`);
const run = buyerRun.run;
// 10 USDT at 0.92 EUR; on the chain 10 TEST USD, 6 decimals.
const AD = { price: '0.92', min: '10', max: '20', total: '100' };
const UNITS = 10_000_000n;

test.describe.configure({ mode: 'default' });

test.beforeAll(() => {
  tool('local-test-gates.mjs', 'p2p');
});

function journey() {
  const state = run.read();
  if (!state.buyer || !state.offerId) throw new Error(`${J} #1 made no ad or buyer, so this step has no one to act as`);
  return state;
}

/**
 * The seller's ledger escrow pot for one order as svc-ledger itself books it (`user:<seller>`, kind `escrow`, purpose
 * `trade:<tradeId>`), read by the stack's founder A as a treasury operator, as J-p2p-01 reads it. Null when the ledger
 * has no such account: a contract order must leave none.
 */
let ledgerOperators;
async function ledgerTradeEscrow(sellerId, tradeId) {
  if (!ledgerOperators) {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    ledgerOperators = { ctx, pair: await gates.approverSessions(ctx) };
  }
  const { ctx, pair } = ledgerOperators;
  const prefix = `user:${sellerId}`;
  const res = await fetch(`${ctx.url('ledger')}/operator/accounts?prefix=${encodeURIComponent(prefix)}`, {
    headers: { authorization: `Bearer ${await pair.a.treasuryToken()}` },
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`ledger accounts under ${prefix} refused (${res.status}): ${text.slice(0, 300)}`);
  const page = JSON.parse(text);
  if (page.nextCursor !== null) throw new Error(`more than one page of ledger accounts under ${prefix}`);
  return page.accounts.find((row) => row.kind === 'escrow' && row.purpose === `trade:${tradeId}`) ?? null;
}

/** The TEST chain as svc-protocol reads it, through the stack's chain gate. */
function chain() {
  const status = testChain();
  if (status.chain !== 'running') throw new Error(`${J} needs the stack's LOCAL TEST chain (anvil), and it is ${status.chain}`);
  return createPublicClient({ transport: http(status.gateUrl) });
}
const usdOf = (address) => chain().readContract({ address: TOKEN_USD.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

/** One person's browser on the app, signed in, holding their TEST wallet (and, for the buyer, their TEST passkey). */
async function personPage(browser, who, walletKey, { passkey = null } = {}) {
  const context = await browser.newContext({ baseURL: passkey ? PASSKEY_ORIGIN : ORIGIN });
  const page = await context.newPage();
  if (passkey) await browserHoldsPasskey(page, passkey);
  await installTestWallet(page, { chainId: 84532, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
  return { context, page };
}

/** Continues one wallet sequence as the person does: the representation once for a fresh wallet, then the sheet. */
async function continueInWallet(page) {
  const representation = page.locator('[data-panel="representation"]');
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' }).filter({ has: page.locator('[data-sheet="sequence"]') });
  await expect(representation.or(sheet)).toBeVisible({ timeout: 30_000 });
  if (await representation.isVisible()) await acceptRepresentation(page);
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(sheet).toHaveCount(0, { timeout: 30_000 });
}

/** The TEST wallet connected inside one part of the page, pressing its Connect when the part asks. */
async function connectIn(part) {
  const connect = part.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  if (await connect.isVisible().catch(() => false)) await connect.click();
}

/** The buyer takes the ad for 10 USDT with the contract escrow, confirmed with their passkey; returns the order id. */
async function takeWithContract(page) {
  await page.goto(`/p2p?offerId=${journey().offerId}`);
  const take = page.getByTestId('take-offer');
  await take.getByTestId('take-fiat-amount').fill('9.2');
  await take.locator('select').selectOption(METHOD);
  await expect(take.getByLabel('Quantity in USDT')).toHaveValue('10');
  const escrow = take.getByTestId('take-escrow-type');
  await escrow.getByRole('radio', { name: /Contract escrow \(TEST\)/ }).check({ timeout: 30_000 });
  await connectIn(escrow);
  const wallet = privateKeyToAccount(buyerRun.key()).address;
  await expect(escrow.getByTestId('take-escrow-wallet')).toContainText(wallet, { ignoreCase: true });
  await take.getByTestId('take-review').click();
  const dialog = page.getByTestId('take-review-dialog');
  await expect(dialog.getByTestId('take-review-escrow')).toContainText('Contract escrow (TEST)');
  const passkey = dialog.getByRole('button', { name: 'Use a passkey' });
  const confirm = dialog.getByTestId('take-confirm');
  await expect(passkey.or(confirm).first()).toBeVisible();
  await ((await passkey.isVisible()) ? passkey : confirm).click();
  await expect(page).toHaveURL(/\/uc\/order\?tradeId=/, { timeout: 30_000 });
  return new URL(page.url()).searchParams.get('tradeId');
}

/** The seller opens and funds the order's deal from their TEST wallet on the order page; returns the deal id shown. */
async function sellerFunds(page, tradeId) {
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const panel = page.getByTestId('order-contract-escrow');
  await connectIn(panel);
  await panel.getByRole('button', { name: 'Open and fund the deal in your wallet' }).click();
  await continueInWallet(page); // approve + open
  await continueInWallet(page); // lock
  await expect(panel.getByTestId('order-deal-id')).toHaveText(/^#\d+$/, { timeout: 60_000 });
  return (await panel.getByTestId('order-deal-id').textContent()).slice(1);
}

/** The buyer ticks the checklist and marks the payment sent, as in J-p2p-01 #7. */
async function markPaid(page, tradeId) {
  await page.goto(`/uc/order?tradeId=${tradeId}`);
  const order = page.getByRole('main');
  await order.getByRole('button', { name: 'Mark payment sent' }).click();
  const review = page.getByRole('dialog');
  for (const box of await review.getByTestId('order-paid-checklist').getByRole('checkbox').all()) await box.check();
  await review.getByRole('button', { name: 'Mark payment sent' }).click();
  await expect(review).toHaveCount(0);
  await expect(order).toContainText('Payment marked sent');
}

test('J-p2p-21 #1 an ad that offers a contract escrow: the escrow type is chosen at order time and labelled', async ({ page, browser }) => {
  test.setTimeout(300_000);
  // The seller: verified, TEST USDT in the ledger (it stays there: the contract holds the order's coins), a TEST bank
  // account, a sell ad, and a TEST wallet with TEST ETH and TEST USD on the TEST chain.
  const seller = await signUp(page, 'p2p21s');
  await verify(page, seller);
  expect(fund(seller.email, 'USDT', '100').tx).toBeTruthy();
  const s = p2p(await api(seller));
  await testInstrument(s, seller);
  const offer = await s.mutate('offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'EUR',
    priceType: 'fixed',
    price: AD.price,
    minAmount: AD.min,
    maxAmount: AD.max,
    totalAmount: AD.total,
    methods: [METHOD],
    terms: 'TEST terms: pay from an account in your own name.',
    idempotencyKey: `${J}:offer:${seller.handle}`,
  });
  const buyer = await signUp(page, 'p2p21b');
  await verify(page, buyer);
  const buyerSession = await api(buyer);
  await confirmEmail(buyerSession, buyer);
  const passkey = await testPasskey(buyerSession);
  const b = p2p(buyerSession, passkey);
  const sellerWallet = sellerRun.start({}, { funding: 'venue' }).walletKey;
  const sellerId = (await s.query('offers.get', { offerId: offer.id })).makerId;
  run.reset({ ...buyerRun.start(), seller, sellerId, buyer, offerId: offer.id, sellerWallet, passkey: passkey.saved() });

  // What the contract escrow is, for this ad's coin, as the buyer is offered it.
  const offered = await b.query('trades.contractEscrow', { asset: 'USDT' });
  expect(offered).toMatchObject({
    available: true,
    network: { chainId: 84532, label: 'Base Sepolia testnet, not INTACHAIN' },
    token: { address: TOKEN_USD.address, decimals: 6 },
    timeout: 'refund_seller',
    mainnet: { available: false, blocker: 'audit.external' },
    audited: false,
  });

  const { context, page: buyerPage } = await personPage(browser, buyer, buyerRun.key());
  await buyerPage.goto(`/p2p?offerId=${offer.id}`);
  const escrow = buyerPage.getByTestId('take-offer').getByTestId('take-escrow-type');
  await expect(escrow).toContainText('Escrow type');
  await expect(escrow).toContainText('Chosen when you place the order, and fixed after.');
  await expect(escrow.getByRole('radio', { name: /Ledger escrow/ })).toBeChecked();
  const contract = escrow.getByRole('radio', { name: /Contract escrow \(TEST\)/ });
  await expect(contract).toBeEnabled({ timeout: 30_000 });
  await expect(escrow).toContainText('A contract on Base Sepolia testnet, not INTACHAIN holds the seller’s coins');
  await expect(escrow.getByTestId('take-escrow-networks')).toContainText('Base Sepolia testnet, not INTACHAIN');
  await expect(escrow.getByTestId('take-escrow-mainnet')).toContainText('audit.external');
  await contract.check();
  await connectIn(escrow);
  await expect(escrow.getByTestId('take-escrow-wallet')).toContainText(privateKeyToAccount(buyerRun.key()).address, {
    ignoreCase: true,
  });
  await context.close();
});

test('J-p2p-21 #2 the buyer places the order; the contract deal opens with an id the order shows', async ({ browser }) => {
  test.setTimeout(300_000);
  const state = journey();
  const buyerSide = await personPage(browser, state.buyer, buyerRun.key(), { passkey: state.passkey });
  const tradeId = await takeWithContract(buyerSide.page);
  const b = p2p(await api(state.buyer));
  const placed = await b.query('trades.get', { tradeId });
  expect(placed).toMatchObject({ escrowKind: 'contract', status: 'created', amount: '10', escrowHeld: '0' });
  expect(placed.contract).toMatchObject({ chainId: 84532, units: UNITS.toString(), dealId: null, timeout: 'refund_seller' });
  expect(placed.contract.buyerWallet.toLowerCase()).toBe(privateKeyToAccount(buyerRun.key()).address.toLowerCase());
  const order = buyerSide.page.getByTestId('order-contract-escrow');
  await expect(order.getByTestId('order-escrow-kind')).toContainText('Contract escrow on Base Sepolia testnet, not INTACHAIN');
  await expect(order.getByTestId('order-escrow-kind')).toContainText('TEST network');
  await expect(order.getByTestId('order-deal-id')).toContainText('Waiting for the seller to open and fund the deal');

  // The seller opens and funds the deal from their own wallet; the contract now holds the coins.
  const sellerSide = await personPage(browser, state.seller, state.sellerWallet);
  const sellerAddress = privateKeyToAccount(state.sellerWallet).address;
  const sellerBefore = await usdOf(sellerAddress);
  const dealId = await sellerFunds(sellerSide.page, tradeId);
  expect(sellerBefore - (await usdOf(sellerAddress))).toBe(UNITS);

  // The buyer's order shows the same deal id, the deal locked on the chain, and nothing in the ledger.
  await buyerSide.page.reload();
  await expect(order.getByTestId('order-deal-id')).toHaveText(`#${dealId}`);
  await expect(order.getByTestId('order-deal-state')).toHaveText('Funded and locked');
  await expect(order.getByTestId('order-deal-held')).toHaveText(UNITS.toString());
  await expect(order.getByTestId('order-ledger-held')).toHaveText('Nothing: the contract holds these coins');
  const escrowed = await b.query('trades.get', { tradeId });
  expect(escrowed).toMatchObject({ status: 'escrowed', escrowHeld: '0' });
  expect(escrowed.contract).toMatchObject({ dealId });
  run.write({ tradeId, dealId });
  await buyerSide.context.close();
  await sellerSide.context.close();
});

test('J-p2p-21 #3 the buyer marks paid and the seller releases: the contract release matches the order and the coins were never also in the ledger', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  const s = p2p(await api(state.seller));
  const b = p2p(await api(state.buyer));
  const sellerLedger = async () => (await s.query('trades.get', { tradeId: state.tradeId })).escrowHeld;
  const buyerSide = await personPage(browser, state.buyer, buyerRun.key());
  await markPaid(buyerSide.page, state.tradeId);

  const buyerAddress = privateKeyToAccount(buyerRun.key()).address;
  const buyerBefore = await usdOf(buyerAddress);
  const sellerSide = await personPage(browser, state.seller, state.sellerWallet);
  await sellerSide.page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const panel = sellerSide.page.getByTestId('order-contract-escrow');
  await connectIn(panel);
  await panel.getByRole('button', { name: 'Release from the contract in your wallet' }).click();
  await continueInWallet(sellerSide.page);
  await expect(panel.getByTestId('order-deal-state')).toHaveText('Released to the buyer', { timeout: 60_000 });

  // The chain paid the buyer's own wallet exactly the order's amount; the order reads released from that deal.
  expect((await usdOf(buyerAddress)) - buyerBefore).toBe(UNITS);
  const released = await b.query('trades.get', { tradeId: state.tradeId });
  expect(released).toMatchObject({ status: 'released', escrowKind: 'contract', escrowHeld: '0' });
  expect(released.contract).toMatchObject({ dealId: state.dealId });
  expect(await sellerLedger()).toBe('0');
  // svc-ledger itself has no escrow pot for this order: the same coins were never also held there.
  expect(await ledgerTradeEscrow(state.sellerId, state.tradeId)).toBeNull();
  await buyerSide.page.reload();
  const order = buyerSide.page.getByTestId('order-contract-escrow');
  await expect(order.getByTestId('order-deal-state')).toHaveText('Released to the buyer');
  await expect(order.getByTestId('order-deal-held')).toHaveText('0');
  await expect(order.getByTestId('order-ledger-held')).toHaveText('Nothing: the contract holds these coins');
  await buyerSide.context.close();
  await sellerSide.context.close();
});

test('J-p2p-21 #4 the deal on mainnet shows the audit.external notice, switched off in this build', async ({ browser }) => {
  const state = journey();
  const buyerSide = await personPage(browser, state.buyer, buyerRun.key());
  await buyerSide.page.goto(`/uc/order?tradeId=${state.tradeId}`);
  const mainnet = buyerSide.page.getByTestId('order-contract-escrow').getByTestId('order-escrow-mainnet');
  await expect(mainnet).toHaveText(
    'audit.external: the escrow contract has no external audit, so a mainnet deal is switched off in this build.',
  );
  const offered = await p2p(await api(state.buyer)).query('trades.contractEscrow', { asset: 'USDT' });
  expect(offered).toMatchObject({ mainnet: { available: false, blocker: 'audit.external' }, audited: false });
  await buyerSide.context.close();
});

test('J-p2p-21 #5 after the buyer marked paid, the seller finds no Cancel: release or a dispute only, and the coins stay in the contract', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const state = journey();
  const buyerSide = await personPage(browser, state.buyer, buyerRun.key(), { passkey: state.passkey });
  const tradeId = await takeWithContract(buyerSide.page);
  const sellerSide = await personPage(browser, state.seller, state.sellerWallet);
  const dealId = await sellerFunds(sellerSide.page, tradeId);
  await markPaid(buyerSide.page, tradeId);

  await sellerSide.page.goto(`/uc/order?tradeId=${tradeId}`);
  const main = sellerSide.page.getByRole('main');
  const panel = sellerSide.page.getByTestId('order-contract-escrow');
  await connectIn(panel);
  await expect(panel.getByTestId('order-contract-seller-paid')).toContainText('The order cannot be cancelled now.');
  const actions = panel.getByTestId('order-contract-actions');
  await expect(actions.getByRole('button', { name: 'Release from the contract in your wallet' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Open a dispute on the contract' })).toBeVisible();
  await expect(main.getByRole('button', { name: /cancel/i })).toHaveCount(0);
  await expect(actions.getByRole('button', { name: 'Refund to me from the contract' })).toHaveCount(0);
  await expect(panel.getByTestId('order-deal-state')).toHaveText('Funded and locked');
  await expect(panel.getByTestId('order-deal-held')).toHaveText(UNITS.toString());
  // A cancel asked of svc-p2p directly is refused too: the coins are the contract's.
  const s = p2p(await api(state.seller));
  const refused = await s.bare.mutate('trades.cancel', { tradeId });
  expect(refused.status).not.toBe(200);
  expect(await s.query('trades.get', { tradeId })).toMatchObject({ status: 'fiat_sent', escrowHeld: '0', contract: { dealId } });
  expect(await ledgerTradeEscrow(state.sellerId, tradeId)).toBeNull();
  expect(
    await chain().readContract({
      address: TOKEN_USD.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [(await s.query('trades.contractEscrow', { asset: 'USDT' })).network.escrow],
    }),
  ).toBeGreaterThanOrEqual(UNITS);
  await buyerSide.context.close();
  await sellerSide.context.close();
});
