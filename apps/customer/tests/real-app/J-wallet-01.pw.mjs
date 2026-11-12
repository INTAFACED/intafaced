// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState, restartWithSetting } from './stack.mjs';
import { TEST_MEMBERSHIP_TIERS } from '../../../../tooling/scripts/local-stack-services/identity.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { setPartner } from './partner.mjs';
import {
  continueInWallet,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-wallet-01, in the running app (docs/roadmap/journeys.json): I see what I hold and what I can actually withdraw.
// One test per step, titled "J-wallet-01 #<n>", run in order by one verified TEST person with one TEST browser wallet.
// The launch model (OWNER 226): INTAFACED holds none of these funds. Assets (`/money`, with svc-trade's user-venue door on
// for this file, venueForThisFile) shows the connected wallet, read from the stack's TEST chain at one block, and the
// venue account, read from the stack's TEST venue simulator, each with its own as-of time and never added into one total.
// TEST setup (beforeAll, not a step) gives the journey its start: a verified account, a TEST wallet funded on the TEST
// chain (`fund <address> venue`: TEST ETH for gas and 100 TEST USD), TEST 500 USDC in its venue account by the TEST
// venue's deposit control, and one TEST limit buy resting on the venue that locks part of it, signed by the wallet's key.
// Every figure is checked against its own source: the chain's node at the block the page names, and the venue's record.
// The ledger is read before and after: it holds no balance for this person and posts nothing in #1 to #4.
// #3 puts this person's bank money at the stack's TEST partner bank (`testPartner.set({ custody: 'off' })`, funded there
// with TEST 50 USDT), buys TEST 10 USDT by card and TEST 20 USDT by a bank pull through the partner's TEST pay-in page, and reads what the partner
// holds back of it on Withdraw, through its switches for "not reported" and for the release; then puts it back.
// #5 reads the asset registry and holds Deposit's and Withdraw's own pickers to it. #6 reads the membership panel with the tiers blank, then with identity restarted
// with one TEST tier (`LOCAL_STACK_IDENTITY_MEMBERSHIP=test`), then blank again.
const J = 'J-wallet-01';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
/** The TEST venue's start: 500 TEST USDC, and the resting TEST buy far under the market (the TEST asks start at 60010). */
const START_USDC = '500';
const RESTING = { amount: '0.001', price: '30000' };
/** #3's TEST limit buy while the partner holds the purchase back, far under the market, cancelled straight after. */
const THIRD = { amount: '0.001', price: '30500' };
/** #2's TEST limit buy, also far under the market, so it rests until it is cancelled. */
const SECOND = { amount: '0.002', price: '31000' };
/** The stack's TEST chain's TEST USD (services/svc-protocol/scripts/seed-test-chain.ts TEST_TOKENS.USD), 6 decimals. */
const TEST_USD = '0x000000000000000000000000000000000000d011';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}
const account = () => state().account;

/** One read from the TEST chain's node itself, at a block given as a hex tag. */
async function node(method, params) {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
/** The chain's own figures for `owner` at `block` (a decimal string): TEST ETH in wei, TEST USD in base units. */
async function chainAt(owner, block) {
  const tag = `0x${BigInt(block).toString(16)}`;
  const data = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
  const [eth, usd, head] = await Promise.all([
    node('eth_getBalance', [owner, tag]),
    node('eth_call', [{ to: TEST_USD, data }, tag]),
    node('eth_getBlockByNumber', [tag, false]),
  ]);
  return { eth: BigInt(eth), usd: BigInt(usd), time: new Date(Number(BigInt(head.timestamp)) * 1000).toISOString() };
}
/** An exact base-unit amount as the page prints it: thousands grouped, no trailing zeros. */
function shownUnits(units, decimals) {
  const digits = units.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
/** A venue decimal as the page prints it. */
const shown = (decimal) => {
  const [whole, frac] = String(decimal).split('.');
  const f = (frac ?? '').replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
};

/** The person signs one action on the TEST venue with their own wallet key, as their wallet would (TEST setup only). */
async function signOnVenue(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value;

/**
 * Connects the TEST wallet when the page asks for it, until `connected` shows. A page opened again in the same tab may
 * restore the connection itself, and then shows no Connect button.
 */
async function connectWhenAsked(page, connected) {
  const connect = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect
    .poll(
      async () => {
        if (await connected.isVisible().catch(() => false)) return true;
        // A short click: the page may restore the connection and drop the button mid-click, and a click with no limit
        // of its own would then wait out the whole poll instead of letting it look again.
        if (await connect.isVisible().catch(() => false)) await connect.click({ timeout: 2_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
}

/**
 * Signed in with the TEST wallet on the TEST chain in this page: the wallet is installed once per page (a second install
 * in the same page is refused), and the page's own reads go to the TEST chain's node.
 */
async function withWallet(page) {
  const { account: who, walletKey } = state();
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
}

/** Assets open with the wallet connected. `fresh` installs the wallet and signs in first; else the page already has both. */
async function openAssets(page, { via = null, fresh = true } = {}) {
  const { owner } = state();
  if (fresh) await withWallet(page);
  if (via) await via();
  else await page.goto('/money');
  await page.mouse.move(0, 600);
  const sources = page.getByTestId('assets-by-source');
  await expect(sources).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.locator(`[data-testid="source-wallet"][data-address="${owner}"]`));
  return { sources, owner };
}

/** The venue row on Assets for `asset`, once it shows exactly the venue's own free and locked figures. */
async function venueRowAgrees(page, owner, asset) {
  const row = page.getByTestId('source-venue').locator(`tr[data-asset="${asset}"]`);
  let venue;
  await expect
    .poll(
      async () => {
        venue = await venueBalance(owner, asset);
        const cell = async (name) =>
          (
            await row
              .locator(`[data-cell="${name}"]`)
              .innerText()
              .catch(() => '')
          )
            .split('\n')[0]
            .trim();
        return (
          (await cell('free')) === shown(venue.free) &&
          (await cell('locked')) === shown(venue.locked) &&
          (await cell('total')) === shown(venue.total) &&
          (await cell('withdrawable')) === shown(venue.free)
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return { row, venue };
}

/** The TEST partner bank's label (svc-bank `partner/test-partner.ts`). */
const PARTNER_BANK = 'TEST partner bank';

let jobCtx;
const stackCtx = () =>
  (jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} })));

/** The TEST pay-in partner says a payment was paid, through its signed job door, as the partner would. */
async function partnerPaid(body) {
  const ctx = await stackCtx();
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payin-sim/paid`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`payin-sim/paid refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/** What the partner holds back of this person's purchases, and what they can withdraw, as svc-bank reads it from the partner. */
async function holds(session) {
  const res = await session.get('/api/bank/trpc/partnerHolds');
  if (res.status !== 200) throw new Error(`partnerHolds refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.result.data;
}

/** The ledger's figures for this person: none of these funds are its, so it holds nothing of them and posts nothing. */
const ledger = async () => (await api(account())).balances();

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'jw');
    await verify(page, who);
    const walletKey = testWalletKey();
    run.reset({ account: who, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
    fundOnTestChain(owner, 'venue');
    const ref = `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`;
    expect(await testDeposit(owner, 'USDC', START_USDC, ref)).toBe(true);
    const placed = await signOnVenue(walletKey, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: RESTING.amount,
      price: RESTING.price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:btc-usdc:jw01${randomBytes(4).toString('hex')}`,
      builderFee: null,
    });
    expect(placed.outcome?.accepted ?? placed.accepted ?? true, JSON.stringify(placed)).toBe(true);
    const [resting] = await openOrders(owner);
    expect(resting?.status).toBe('open');
    run.write({ resting: resting.venueClientOrderId, ledgerStart: await (await api(who)).balances() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens Assets: the wallet's assets read from the chain and the venue account's read from the venue, each with an as-of time, grouped by where they sit, free and locked apart, and no INTAFACED balance`, async ({
  page,
}) => {
  const { resting, ledgerStart, owner: who } = state();
  // The venue's own clock before Assets opens: every venue read the page shows is stamped by the venue after this.
  const venueBefore = Date.parse((await venueRecord(who, '/balances')).asOf);
  const { sources, owner } = await openAssets(page, {
    via: async () => {
      await page.goto('/');
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money' }).click();
      await expect(page).toHaveURL(/\/money(\?|$)/);
    },
  });
  await expect(page.getByRole('heading', { name: 'Assets', level: 1 })).toBeVisible();

  // The wallet, read from the chain: the block it was read at, that block's own time, the network, and each asset's
  // amount exactly as the node reports it at that block.
  const wallet = page.getByTestId('source-wallet');
  await expect(wallet).toHaveAttribute('data-source', 'chain');
  await expect(wallet.locator('[data-testid="source-wallet-block"]')).toHaveAttribute('data-block', /^\d+$/, { timeout: 30_000 });
  const block = await wallet.locator('[data-testid="source-wallet-block"]').getAttribute('data-block');
  const chain = await chainAt(owner, block);
  expect(chain.usd).toBe(100_000_000n);
  await expect(wallet.locator('[data-testid="source-wallet-block"] time')).toHaveAttribute('datetime', chain.time);
  await expect(wallet.getByTestId('source-wallet-network')).toHaveText(`Base Sepolia test network (chain ${CHAIN_ID})`);
  const totals = wallet.getByRole('region', { name: 'Totals on Base Sepolia test network' });
  await expect(totals.locator('tr[data-asset="TESTUSD"] [data-cell="amount"]')).toHaveText(shownUnits(chain.usd, 6));
  await expect(totals.locator('tr[data-asset="ETH"] [data-cell="amount"]')).toHaveText(shownUnits(chain.eth, 18));

  // The venue account, read from the venue, with the venue's as-of time: free and locked apart, the lock naming the
  // resting order, and Can withdraw is the venue's free figure.
  const venueSection = page.getByTestId('source-venue');
  await expect(venueSection).toHaveAttribute('data-source', 'venue');
  await expect(venueSection.getByTestId('source-venue-test')).toHaveText('TEST');
  const { row, venue } = await venueRowAgrees(page, owner, 'USDC');
  // The as-of shown is the venue's own stamp on a read the page made: after the venue's clock before Assets opened, and
  // no later than the venue's clock now.
  const shownAsOf = Date.parse(await venueSection.getByTestId('source-as-of').getAttribute('datetime'));
  const venueNow = Date.parse((await venueRecord(owner, '/balances')).asOf);
  expect(shownAsOf).toBeGreaterThanOrEqual(venueBefore);
  expect(shownAsOf).toBeLessThanOrEqual(venueNow);
  expect(sameDecimal(venue.total, START_USDC)).toBe(true);
  const [order] = await openOrders(owner);
  expect(order.venueClientOrderId).toBe(resting);
  expect(sameDecimal(venue.locked, order.locked)).toBe(true);
  await expect(row.locator(`li[data-order="${resting}"]`)).toContainText(`(buy ${SYMBOL}) locks ${shown(order.locked)} USDC`);

  // Grouped by where it sits, and nothing is called an INTAFACED balance or added into one total.
  await expect(sources.getByRole('heading', { name: 'In your wallet' })).toBeVisible();
  await expect(sources.getByRole('heading', { name: /^In your venue account on / })).toBeVisible();
  await expect(page.locator('main').first()).not.toContainText(/INTAFACED balance|Est\. total value|main account/i);
  await expect(page.getByTestId('money-total')).toHaveCount(0);
  // The ledger holds nothing of these funds: what it held for this person at the start, it holds now.
  expect(await ledger()).toEqual(ledgerStart);
});

test(`${J} #2 places an order, then looks again: the venue's lock shows as locked naming the order; cancelling it returns it to free, as the venue reports`, async ({
  page,
}) => {
  // The desk, a signed order, Assets, the desk again and a signed cancel: more than one default step's time.
  test.setTimeout(240_000);
  const { owner, resting, ledgerStart } = state();
  const before = await venueBalance(owner, 'USDC');
  await withWallet(page);
  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address').filter({ hasText: new RegExp(owner, 'i') }));
  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Buy', exact: true }).click();
  await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
  await ticket.getByRole('textbox', { name: 'Price' }).fill(SECOND.price);
  await ticket.getByRole('textbox', { name: 'Amount (BTC)' }).fill(SECOND.amount);
  await ticket.getByRole('button', { name: 'Review buy' }).click();
  const sheet = page.getByTestId('venue-review');
  await sheet.getByRole('button', { name: 'Confirm and sign' }).click();
  await continueInWallet(page);
  await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Open on the venue.');
  const second = (await openOrders(owner)).find((o) => o.venueClientOrderId !== resting);
  expect(second?.status).toBe('open');

  // Assets: the venue's lock for the new order shows as locked, naming that order by its id.
  await openAssets(page, { fresh: false });
  const { row, venue } = await venueRowAgrees(page, owner, 'USDC');
  expect(sameDecimal(venue.total, before.total)).toBe(true);
  const lock = row.locator(`li[data-order="${second.venueClientOrderId}"]`);
  await expect(lock).toContainText(`(buy ${SYMBOL}) locks ${shown(second.locked)} USDC`);
  await expect(lock).toHaveAttribute('title', second.venueClientOrderId);
  await expect(row.locator(`li[data-order="${resting}"]`)).toBeVisible();

  // Cancel it on the desk: the venue releases its lock, and Assets shows it back in free, as the venue reports.
  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  // The desk may restore the connection itself; it is connected only when it asks.
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address').filter({ hasText: new RegExp(owner, 'i') }));
  const orderRow = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${second.venueClientOrderId}"]`);
  await orderRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-ticket').getByTestId('venue-outcome')).toContainText(
    'Cancelled on the venue; its lock is released.',
  );
  await expect.poll(async () => (await openOrders(owner)).map((o) => o.venueClientOrderId)).toEqual([resting]);
  await openAssets(page, { fresh: false });
  const after = await venueRowAgrees(page, owner, 'USDC');
  expect(sameDecimal(after.venue.free, before.free) && sameDecimal(after.venue.locked, before.locked)).toBe(true);
  await expect(after.row.locator(`li[data-order="${second.venueClientOrderId}"]`)).toHaveCount(0);
  expect(await ledger()).toEqual(ledgerStart);
});

/**
 * One purchase through the partner from the Add money room: TEST USDT priced from NL by the stack's TEST rate stand-in,
 * paid `method` on the partner's TEST pay-in page, and the partner's signed "paid", twice. Returns the request as paid.
 */
async function buyThroughPartner(page, method, amount) {
  await page.goto('/bank/ramps/new');
  await page.getByLabel('Add to').selectOption('USDT');
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Country you pay from').fill('NL');
  const answered = page.waitForResponse((res) => res.url().includes('/api/bank/trpc/addMoney.methods') && res.status() === 200);
  await page.getByRole('button', { name: 'See ways to pay' }).click();
  const quote = (await (await answered).json()).result.data.methods.find((m) => m.method === method)?.quote;
  expect(quote, `the TEST rate stand-in prices a ${method} purchase from NL`).toBeTruthy();
  await page.getByTestId(`method-${method}`).getByRole('radio').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  const confirm = page.getByTestId('add-money-confirm');
  await expect(confirm).toBeVisible();
  const { url } = await stackCtx();
  await confirm.getByRole('button', { name: 'Ask for this payment' }).click();
  await page.waitForURL((at) => at.href.startsWith(`${url('bank')}/test/payin-sim/pay/`));
  await page.getByRole('button', { name: 'Approve payment' }).click();
  await page.waitForURL(/\/bank\/ramps\/new\?request=/);
  const requestId = new URL(page.url()).searchParams.get('request');
  const said = { requestId, paidAmount: quote.payAmount, payCurrency: quote.payCurrency };
  const paid = await partnerPaid(said);
  // Credited by the partner, at the partner, once: the partner saying paid again credits nothing more.
  expect(paid).toMatchObject({ requestId, method, status: 'credited', creditedAmount: amount, creditedBy: 'partner' });
  expect(await partnerPaid(said)).toEqual(paid);
  return paid;
}

/** The TEST partner's hold time for a purchase paid each way (svc-bank `TEST_PURCHASE_HOLD_DAYS`), in milliseconds. */
const HOLD_MS = { card: 7 * 86_400_000, bank_pull: 3 * 86_400_000 };

test(`${J} #3 buys with a card and with a bank pull through the partner, then opens Withdraw: each partner hold with its release time, or "not reported by the partner"; trading is unaffected; the release shows once`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { account: who, owner, resting, ledgerStart } = state();
  const session = await api(who);
  const tag = `${process.env.JOURNEY_RUN_ID ?? 'local'}${session.userId}`.replace(/[^A-Za-z0-9-]/g, '').slice(-40);
  const venueBefore = await venueBalance(owner, 'USDC');
  // TEST setup: this person's bank money is held at the TEST partner bank, which already holds TEST 50 USDT for them.
  await setPartner(who, { custody: 'off', purchaseHolds: 'reported', purchaseHold: 'live' });
  try {
    const funded = await session.post('/api/bank/trpc/testPartner.fund', { fundId: `jw01-${tag}`, assetId: 'USDT', amount: '50' });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    expect(funded.body.result.data).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: '50' });

    // Two purchases through the partner: TEST 10 USDT by card, then TEST 20 USDT by a pull from the person's bank.
    await withWallet(page);
    const byCard = await buyThroughPartner(page, 'card', '10');
    const byBank = await buyThroughPartner(page, 'pay_by_bank', '20');
    expect(await ledger()).toEqual(ledgerStart);

    // The partner's report: one hold per purchase, each released the partner's hold time after it credited it.
    const report = await holds(session);
    expect(report).toMatchObject({ held: true, label: PARTNER_BANK, reported: true, released: [] });
    expect(report.holds.map((h) => [h.assetId, h.amount, h.paidBy])).toEqual([
      ['USDT', '10', 'card'],
      ['USDT', '20', 'bank_pull'],
    ]);
    for (const [h, paid] of [
      [report.holds[0], byCard],
      [report.holds[1], byBank],
    ]) {
      const late = Date.parse(h.releaseAt) - Date.parse(paid.creditedAt) - HOLD_MS[h.paidBy];
      expect(Math.abs(late), `${h.paidBy} hold released ${h.releaseAt}, credited ${paid.creditedAt}`).toBeLessThan(60_000);
    }
    expect(report.balances).toEqual([expect.objectContaining({ assetId: 'USDT', balance: '80', heldBack: '30', withdrawable: '50' })]);

    // Withdraw: each hold with its release time, and what can be withdrawn now leaves both out.
    await page.goto('/uc/withdraw');
    const panel = page.getByTestId('partner-holds');
    await expect(panel).toHaveAttribute('data-source', PARTNER_BANK);
    await expect(panel).toHaveAttribute('data-reported', 'true');
    const row = panel.locator('[data-testid="partner-withdrawable"][data-asset="USDT"]');
    await expect(row).toHaveAttribute('data-balance', '80');
    await expect(row.locator('[data-cell="balance"]')).toHaveText('80 USDT');
    await expect(row.locator('[data-cell="held-back"]')).toHaveText('30 USDT');
    await expect(row.locator('[data-cell="withdrawable"]')).toHaveText('50 USDT');
    const shownHolds = panel.getByTestId('partner-hold');
    await expect(shownHolds).toHaveCount(2);
    const label = { card: 'card', bank_pull: 'bank pull' };
    for (const [i, h] of report.holds.entries()) {
      const shown = shownHolds.nth(i);
      await expect(shown).toHaveAttribute('data-release-at', h.releaseAt);
      await expect(shown).toHaveAttribute('data-amount', h.amount);
      // The release time as the page writes every time: the day and month of the partner's own release time.
      const day = await page.evaluate(
        (at) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(at)),
        h.releaseAt,
      );
      await expect(shown).toHaveText(
        new RegExp(`^${PARTNER_BANK}'s hold: ${h.amount} USDT from a ${label[h.paidBy]} purchase, released ${day}`),
      );
    }
    await expect(panel.getByTestId('partner-release')).toHaveCount(0);

    // Trading is unaffected: the resting order is still open on the venue, the venue's own figures are as they were, and
    // while the partner holds the purchases back the person places a signed order on the desk and cancels it.
    expect((await openOrders(owner)).map((o) => o.venueClientOrderId)).toEqual([resting]);
    const venueAfter = await venueBalance(owner, 'USDC');
    expect({ free: venueAfter.free, locked: venueAfter.locked, total: venueAfter.total }).toEqual({
      free: venueBefore.free,
      locked: venueBefore.locked,
      total: venueBefore.total,
    });
    await page.goto(DESK);
    await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
    await connectWhenAsked(page, page.getByTestId('venue-wallet-address').filter({ hasText: new RegExp(owner, 'i') }));
    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Buy', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('textbox', { name: 'Price' }).fill(THIRD.price);
    await ticket.getByRole('textbox', { name: 'Amount (BTC)' }).fill(THIRD.amount);
    await ticket.getByRole('button', { name: 'Review buy' }).click();
    const sheet = page.getByTestId('venue-review');
    await sheet.getByRole('button', { name: 'Confirm and sign' }).click();
    await continueInWallet(page);
    await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Open on the venue.');
    const placed = (await openOrders(owner)).find((o) => o.venueClientOrderId !== resting);
    expect(placed?.status).toBe('open');
    // Close the review, as a person does, before cancelling on the desk.
    await sheet.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(sheet).toBeHidden();
    const orderRow = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${placed.venueClientOrderId}"]`);
    await orderRow.getByRole('button', { name: 'Cancel', exact: true }).click();
    await continueInWallet(page);
    await expect(page.getByTestId('venue-ticket').getByTestId('venue-outcome')).toContainText(
      'Cancelled on the venue; its lock is released.',
    );
    await expect.poll(async () => (await openOrders(owner)).map((o) => o.venueClientOrderId)).toEqual([resting]);
    // The partner's holds are untouched by the trade.
    expect((await holds(session)).holds).toEqual(report.holds);

    // A partner that does not report what it holds back: "not reported by the partner", never 0 and never all free.
    await setPartner(who, { purchaseHolds: 'not_reported' });
    await page.goto('/uc/withdraw');
    await expect(panel).toHaveAttribute('data-reported', 'false');
    await expect(row.locator('[data-cell="balance"]')).toHaveText('80 USDT');
    await expect(row.locator('[data-cell="held-back"]')).toHaveText('not reported by the partner');
    await expect(row.locator('[data-cell="withdrawable"]')).toHaveText('not reported by the partner');
    await expect(panel.getByTestId('partner-hold')).toHaveCount(0);
    expect(await holds(session)).toMatchObject({ held: true, reported: false, holds: [], released: [] });
    await setPartner(who, { purchaseHolds: 'reported' });

    // The partner releases the holds: each release shows once, and every read after still shows it once.
    await setPartner(who, { purchaseHold: 'expired' });
    await page.reload();
    await expect(panel).toHaveAttribute('data-reported', 'true');
    await expect(panel.getByTestId('partner-hold')).toHaveCount(0);
    const release = panel.getByTestId('partner-release');
    await expect(release).toHaveCount(2);
    for (const [i, h] of report.holds.entries()) {
      await expect(release.nth(i)).toHaveAttribute('data-amount', h.amount);
      await expect(release.nth(i)).toHaveText(
        new RegExp(`^Released by ${PARTNER_BANK}: ${h.amount} USDT from a ${label[h.paidBy]} purchase, at \\d`),
      );
    }
    await expect(row.locator('[data-cell="withdrawable"]')).toHaveText('80 USDT');
    await page.reload();
    await expect(panel.getByTestId('partner-release')).toHaveCount(2);
    const after = await holds(session);
    expect(after.holds).toEqual([]);
    expect(after.released.map((r) => [r.id, r.amount, r.releaseAt])).toEqual(report.holds.map((h) => [h.id, h.amount, h.releaseAt]));
    expect(await ledger()).toEqual(ledgerStart);
  } finally {
    // The other steps read this person's money as before.
    await setPartner(who, { custody: 'on', purchaseHolds: 'reported', purchaseHold: 'live' });
  }
});

test(`${J} #4 looks at an asset with no published price: it reads "No price published", never a zero value, and nothing is totalled`, async ({
  page,
}) => {
  await openAssets(page);
  const wallet = page.getByTestId('source-wallet');
  const usd = wallet.locator('tr[data-asset="TESTUSD"]');
  await expect(usd.locator('[data-cell="amount"]')).toHaveText('100');
  await expect(usd.locator('[data-cell="value"]')).toHaveText('No price published');
  const usdc = page.getByTestId('source-venue').locator('tr[data-asset="USDC"]');
  await expect(usdc.locator('[data-cell="value"]')).toHaveText('No price published');
  await expect(page.getByTestId('assets-no-price-note')).toHaveText(
    'No price is published for these assets here, so none is valued and nothing is totalled.',
  );
  const sources = page.getByTestId('assets-by-source');
  await expect(sources).not.toContainText(/\$\s?0(\.0+)?\b|\b0(\.0+)? USD\b/);
  await expect(sources).not.toContainText(/total value/i);
});

const RETIRED = 'TESTRETIRED';
/** The select inside the form field of `scope` whose own caption is exactly `caption` (a panel of the same title is not the field). */
const picker = (scope, caption) =>
  scope
    .locator('label')
    .filter({ has: scope.page().getByText(caption, { exact: true }) })
    .getByRole('combobox');
/** The places after the point a decimal string is written with, trailing zeros not counted. */
const places = (value) => (String(value).split('.')[1] ?? '').replace(/0+$/, '').length;
/** A decimal string as the customer app writes it: the whole part grouped by thousands, the fraction as given. */
const grouped = (value) => {
  const [whole, fraction] = String(value).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
};

test(`${J} #5 opens the asset and network list: the rows Deposit and Withdraw use, and a retired asset stays listed with its history`, async ({
  page,
}) => {
  const who = account();
  const credit = fund(who.email, RETIRED, '5', `jw01-ret-${who.email.split('@')[0].replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 64));
  expect(credit.out).toMatch(/TEST FUNDS credited/);
  const customer = await api(who);
  const read = async (procedure) => {
    const { status, body } = await customer.get(`/api/bank/trpc/${procedure}`);
    expect(status, `${procedure}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    return body.result.data;
  };
  const { assets: listed } = await read('assets.list');
  const withdrawable = await read('ramps.destinations.networks');
  const deposits = await read('deposits.assets');
  const row = (id) => listed.find((asset) => asset.assetId === id);

  // Withdraw's address book offers exactly the listed rows that are active and allow withdrawals, at the same precision,
  // with the same networks (each by its id and label: the list also names a network's contract and links where known,
  // which the address book does not carry).
  expect(withdrawable).toEqual(
    listed
      .filter((asset) => asset.state === 'active' && asset.allowedActions.includes('withdraw') && asset.networks.length > 0)
      .map(({ assetId, precision, networks, defaultNetworkId }) => ({
        assetId,
        precision,
        networks: networks.map(({ networkId, label }) => ({ networkId, label })),
        defaultNetworkId,
      })),
  );
  // Deposit offers only pairs the list allows for deposits; the retired asset takes none.
  expect(deposits.assets.length).toBeGreaterThan(0);
  for (const asset of deposits.assets) {
    expect(row(asset.assetId)).toMatchObject({ state: 'active', allowedActions: expect.arrayContaining(['deposit']) });
    // Deposit's precision for the asset is the list's own, exactly.
    expect(asset.precision, `Deposit's precision for ${asset.assetId}`).toBe(row(asset.assetId).precision);
    for (const network of asset.networks) {
      expect(row(asset.assetId).networks.map((n) => n.networkId)).toContain(network.id);
      // Deposit's figure for the pair, its minimum, is written at the list's precision for that asset, never finer.
      expect(places(network.minimumDeposit), `${asset.assetId} on ${network.id}: minimum ${network.minimumDeposit}`).toBeLessThanOrEqual(
        row(asset.assetId).precision,
      );
    }
  }
  expect(deposits.assets.map((asset) => asset.assetId)).not.toContain(RETIRED);
  expect(row(RETIRED)).toMatchObject({ state: 'retired', allowedActions: [] });

  // The page: from Deposit, every listed row with its precision and networks, the retired one marked and linked to its history.
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  // Deposit's own pickers use those rows: its coins are the ones the list lets in (and any whose pairs are switched off,
  // shown with their reason), and each coin's open networks are the list's networks for it.
  const optionValues = (select, extra = '') =>
    select.locator(`option${extra}`).evaluateAll((options) => options.map((o) => o.value).filter(Boolean));
  // Deposit's own pickers sit in its "Asset" panel; the records' filter further down has an "Asset" field of its own.
  const depositPanel = page.getByRole('region', { name: 'Asset', exact: true });
  const depositAsset = picker(depositPanel, 'Asset');
  const depositNetwork = picker(depositPanel, 'Network');
  await expect(depositAsset).toHaveCount(1);
  await expect(depositNetwork).toHaveCount(1);
  const depositOffered = [...new Set([...deposits.assets, ...(deposits.halted ?? [])].map((asset) => asset.assetId))];
  await expect.poll(() => optionValues(depositAsset).then((v) => [...v].sort())).toEqual([...depositOffered].sort());
  for (const id of depositOffered) expect(row(id), `Deposit offers ${id}, which the list does not have`).toBeTruthy();
  for (const asset of deposits.assets) {
    await depositAsset.selectOption(asset.assetId);
    const open = asset.networks.map((n) => n.id);
    await expect.poll(() => optionValues(depositNetwork, ':not([data-halted])').then((v) => [...v].sort())).toEqual([...open].sort());
    for (const network of asset.networks) {
      expect(row(asset.assetId).networks.map((n) => n.networkId)).toContain(network.id);
      // The page shows that minimum exactly as the bank gives it, so Deposit shows no more places than the list's precision.
      await depositNetwork.selectOption(network.id);
      await expect(
        page
          .getByRole('term')
          .filter({ hasText: /^Minimum deposit$/ })
          .locator('xpath=following-sibling::dd[1]'),
      ).toHaveText(`${grouped(network.minimumDeposit)} ${asset.assetId}`);
      // And the page names the decimal places Deposit uses for the asset: the list's precision, exactly.
      await expect(
        page
          .getByRole('term')
          .filter({ hasText: /^Decimal places$/ })
          .locator('xpath=following-sibling::dd[1]'),
      ).toHaveText(String(row(asset.assetId).precision));
    }
  }
  await page.getByRole('link', { name: 'Supported assets and networks' }).click();
  await expect(page).toHaveURL(/\/uc\/assets$/);
  await expect(page.getByRole('heading', { name: 'Supported assets and networks', level: 1 })).toBeVisible();
  const table = page.getByTestId('supported-assets');
  await expect(table.locator('tbody tr')).toHaveCount(listed.length);
  for (const asset of listed) {
    const tr = table.locator(`tr[data-asset="${asset.assetId}"]`);
    await expect(tr.locator('[data-col="precision"]')).toHaveText(String(asset.precision));
    await expect(tr.locator('[data-col="networks"] li')).toHaveText(
      asset.networks.map((n) => (n.networkId === asset.defaultNetworkId ? `${n.label} (default)` : n.label)),
    );
    await expect(tr).toHaveAttribute('data-state', asset.state);
  }
  const usdt = table.locator('tr[data-asset="USDT"]');
  await expect(usdt.locator('[data-col="actions"]')).toContainText('Deposit');
  await expect(usdt.locator('[data-col="actions"]')).toContainText('Withdraw');
  const retired = table.locator(`tr[data-asset="${RETIRED}"]`);
  await expect(retired.locator('[data-col="state"]')).toContainText('Retired');
  await expect(retired.locator('[data-col="state"]')).toContainText('What you hold and your history with it stay.');
  await expect(retired.locator('[data-col="actions"]')).toHaveText('Nothing new');
  await retired.getByRole('link', { name: `Your ${RETIRED} history` }).click();
  await expect(page).toHaveURL(new RegExp(`/money/balance/${RETIRED}$`));
  await expect(page.getByRole('region', { name: `${RETIRED} balance, entry by entry` })).toContainText(credit.tx);

  // Withdraw links the same list.
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await expect(page.getByRole('link', { name: 'Supported assets and networks' })).toHaveAttribute('href', '/uc/assets');
  // Withdraw's own pickers use the same rows: for every coin the person holds, the networks it offers are exactly the
  // list's withdrawal networks for that coin, and the retired coin they still hold is offered none.
  // Withdraw's own pickers sit in its form, the one with the Network field.
  const withdrawForm = page.locator('form').filter({ has: page.getByText('Network', { exact: true }) });
  const withdrawAsset = picker(withdrawForm, 'Asset');
  const withdrawNetwork = picker(withdrawForm, 'Network');
  await expect(withdrawAsset).toHaveCount(1);
  await expect(withdrawNetwork).toHaveCount(1);
  await expect.poll(() => optionValues(withdrawAsset)).toContain(RETIRED);
  for (const id of await optionValues(withdrawAsset)) {
    await withdrawAsset.selectOption(id);
    const open = (withdrawable.find((asset) => asset.assetId === id)?.networks ?? []).map((n) => n.networkId);
    await expect
      .poll(() => optionValues(withdrawNetwork).then((v) => [...v].sort()), `Withdraw's networks for ${id}`)
      .toEqual([...open].sort());
  }
  await withdrawAsset.selectOption(RETIRED);
  await expect(withdrawNetwork).toContainText('No network is open for this asset');
});

test(`${J} #6 opens membership tier on Account: with config blank, a refused state; with config set, the tier`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const panel = page.getByTestId('membership');
  const tiers = page.locator('#membership [data-tier]');
  // Config blank (the stack's default, as production is until the owner publishes tiers): a refused state, with no
  // tier, price or join control in its place.
  await page.goto('/uc/account');
  await expect(panel).toHaveAttribute('data-state', 'not-offered');
  await expect(panel).toContainText('Membership is not offered');
  await expect(panel).toContainText('No membership tier is published, so there is nothing to join and nothing is charged.');
  await expect(page.locator('#membership').getByRole('button')).toHaveCount(0);
  await expect(tiers).toHaveCount(0);

  // Config set: identity restarted with the one TEST tier (tooling/scripts/local-stack-services/identity.mjs), and the
  // panel shows that tier as identity publishes it: its name, its price and period, and its perks.
  const [tier] = TEST_MEMBERSHIP_TIERS;
  restartWithSetting('identity', 'LOCAL_STACK_IDENTITY_MEMBERSHIP', 'test');
  try {
    // Identity may still be coming back up: open the page again until it has asked identity and shows the answer.
    await expect(async () => {
      await page.goto('/uc/account');
      await expect(panel).toHaveAttribute('data-state', 'offered', { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(tiers).toHaveCount(TEST_MEMBERSHIP_TIERS.length);
    const row = page.locator(`#membership [data-tier="${tier.id}"]`);
    await expect(row.locator('strong')).toHaveText(tier.name);
    await expect(row).toContainText(`${tier.price} ${tier.assetId} every ${tier.periodDays} days`);
    await expect(row.getByRole('list', { name: 'Perks' }).getByRole('listitem')).toHaveText([...tier.perks]);
    // Nobody holds a tier yet, and nothing is charged: the panel says so, with no join control.
    await expect(panel).toContainText('Your tier');
    await expect(panel).toContainText('You have no membership tier.');
    await expect(panel).toContainText('There is no way to buy a membership here. Nothing is charged.');
    await expect(page.locator('#membership').getByRole('button')).toHaveCount(0);
  } finally {
    restartWithSetting('identity', 'LOCAL_STACK_IDENTITY_MEMBERSHIP', null);
  }
  // Back to blank: the refused state again, so no later journey sees the TEST tier.
  await expect(async () => {
    await page.goto('/uc/account');
    await expect(panel).toHaveAttribute('data-state', 'not-offered', { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await expect(tiers).toHaveCount(0);
});
