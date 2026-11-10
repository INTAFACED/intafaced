// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
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
// #5 and #6 read the asset registry and the membership panel, as before.
const J = 'J-wallet-01';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
/** The TEST venue's start: 500 TEST USDC, and the resting TEST buy far under the market (the TEST asks start at 60010). */
const START_USDC = '500';
const RESTING = { amount: '0.001', price: '30000' };
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
        if (await connect.isVisible().catch(() => false)) await connect.click().catch(() => undefined);
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

// #3's partner hold (its release time, or "not reported by the partner") is not asserted here: no TEST partner purchase
// or hold exists yet, so the PR that lands this test names #3 Left-or-replaced, and the clause waits for that partner.
test(`${J} #3 opens Withdraw: what can be withdrawn leaves out the venue's lock, a card or bank purchase is refused with its blocker, and trading is unaffected`, async ({
  page,
}) => {
  const { owner, resting, ledgerStart } = state();
  // Withdraw is the venue account's room in Wallet: the wallet connects, then signs the connection to this account.
  await withWallet(page);
  await page.goto('/wallet');
  await page.getByRole('button', { name: 'Venue account', exact: true }).click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);
  const connected = page.getByRole('heading', { name: 'Connected' });
  const connectAccount = page.getByRole('button', { name: 'Connect to my account' });
  await connectWhenAsked(page, connected.or(connectAccount));
  if (await connectAccount.isVisible()) {
    await connectAccount.click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  }
  await expect(connected).toBeVisible();
  await expect(page.getByRole('region', { name: 'Venue actions' }).getByRole('button', { name: 'Withdraw TEST USDC' })).toBeVisible();
  // What Withdraw offers is the venue's free figure: the resting order still locks part of it, so it is below the total.
  let venue;
  await expect
    .poll(
      async () => {
        venue = await venueBalance(owner, 'USDC');
        // The room prints the venue's decimal as it is, trailing zeros dropped.
        const plain = venue.free.includes('.') ? venue.free.replace(/0+$/, '').replace(/\.$/, '') : venue.free;
        return (await page.getByTestId('venue-balance').textContent()) === `${plain} TEST USDC`;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
  expect(toUnits(venue.locked)).toBeGreaterThan(0n);
  expect(toUnits(venue.free)).toBeLessThan(toUnits(venue.total));
  // A card or bank purchase needs a payment partner, which is not connected: nothing is bought, and nothing is held.
  await page.goto('/uc/recharge');
  await expect(page.locator('main').first()).toContainText('Needs a payment partner, which is not connected.');
  // Trading is unaffected: the resting order is still open on the venue.
  expect((await openOrders(owner)).map((o) => o.venueClientOrderId)).toEqual([resting]);
  expect(await ledger()).toEqual(ledgerStart);
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

  // Withdraw's address book offers exactly the listed rows that are active and allow withdrawals, at the same precision.
  expect(withdrawable).toEqual(
    listed
      .filter((asset) => asset.state === 'active' && asset.allowedActions.includes('withdraw') && asset.networks.length > 0)
      .map(({ assetId, precision, networks, defaultNetworkId }) => ({ assetId, precision, networks, defaultNetworkId })),
  );
  // Deposit offers only pairs the list allows for deposits; the retired asset takes none.
  expect(deposits.assets.length).toBeGreaterThan(0);
  for (const asset of deposits.assets) {
    expect(row(asset.assetId)).toMatchObject({ state: 'active', allowedActions: expect.arrayContaining(['deposit']) });
    for (const network of asset.networks) expect(row(asset.assetId).networks.map((n) => n.networkId)).toContain(network.id);
  }
  expect(deposits.assets.map((asset) => asset.assetId)).not.toContain(RETIRED);
  expect(row(RETIRED)).toMatchObject({ state: 'retired', allowedActions: [] });

  // The page: from Deposit, every listed row with its precision and networks, the retired one marked and linked to its history.
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
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
});

test(`${J} #6 opens membership on Account: with no tier published, it says membership is not offered`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto('/uc/account');
  const panel = page.getByTestId('membership');
  await expect(panel).toHaveAttribute('data-state', 'not-offered');
  await expect(panel).toContainText('Membership is not offered');
  await expect(panel).toContainText('No membership tier is published, so there is nothing to join and nothing is charged.');
  // No tier, price or join control in its place.
  await expect(page.locator('#membership').getByRole('button')).toHaveCount(0);
  await expect(page.locator('#membership [data-tier]')).toHaveCount(0);
});
