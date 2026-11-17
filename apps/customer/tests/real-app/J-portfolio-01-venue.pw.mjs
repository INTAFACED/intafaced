// World: book, restart
import { randomBytes } from 'node:crypto';
import { createWalletClient, encodeFunctionData, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting } from './stack.mjs';
import { confirm, reviewSheet, signUp, verify } from './desk.mjs';
import { CHAIN_ID, connectWhenAsked, fundOnTestChain, testChain } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { setPartner } from './partner.mjs';
import {
  indexedTransfers,
  partnerLines,
  pricesPublished,
  signInWithWallet,
  signedOnVenue,
  testChainRead,
  walletPerson,
} from './sources.mjs';
import {
  continueInWallet,
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-portfolio-01 #1 #3 #4 #5 #6, in the running app (docs/roadmap/journeys.json): after I trade, I see what I hold, what is locked and what it is worth, on the launch
// model: INTAFACED holds none of this person's money. With svc-trade's user-venue door on for this file
// (venueForThisFile), /money lists what each place holding it reports: the connected wallet (read from the stack's TEST
// chain at one block), the venue account (the stack's TEST venue simulator) and the partner account (the stack's TEST
// partner bank), each figure checked here against that source's own record, never against the page. #2 #7 #8 are in
// J-portfolio-01.pw.mjs.
//
// TEST setup (beforeAll, not a step), the journey's start: one verified TEST person with one TEST browser wallet, funded
// on the TEST chain (`fund <address> venue`: TEST ETH for gas and 100 TEST USD) and sending TEST 10 USD from it to the
// venue's published deposit address (a chain transaction the wallet's record keeps); TEST 500 USDC in the venue account
// by the TEST venue's deposit control; one TEST buy of BTC filled there against a sell another TEST trader rests first
// (a venue fill); one TEST limit buy resting on the venue, far under the market (the open order the journey starts
// with); and the person's bank money at the TEST partner bank (`testPartner.set({ custody: 'off' })`) with TEST 50 USDT
// paid in there (a partner line). svc-ops publishes its TEST price list (`LOCAL_STACK_VALUATION_PRICES=test`: USDC and
// USDT at 1, nothing for BTC or the TEST chain's tokens), put back after the file.
//
// #4 takes, inside the step, a TEST stake of USDC on the venue (its `/test/stake` control: the TEST stand-in for a
// venue's own staking, which no venue adapter reaches yet) and opens a TEST isolated perpetual long, signed by the
// wallet's key, whose posted margin is the collateral. Every amount is exact decimal arithmetic at 18 places.
const J = 'J-portfolio-01';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
const PERP = 'BTC-PERP';
/** svc-bank's TEST partner bank's own name (`partner/test-partner.ts`). */
const PARTNER_BANK = 'TEST partner bank';
/** The TEST chain's network as the app names it (features/protocol/blockers networkLabel). */
const NETWORK = 'Base Sepolia test network';
const VENUE_USDC = '500';
const CHAIN_DEPOSIT = '10';
const PARTNER_USDT = '50';
const BOUGHT = { amount: '0.002', price: '60100' };
/** The open order the journey starts with: a TEST buy far under the market, so it rests. */
const RESTING = { amount: '0.001', price: '30000' };
/** Where the desk keeps the business keys of the orders it placed, per wallet (VenueKit `heldKeys`). */
const deskKeysName = (owner) => `if.venue.keys.${owner.toLowerCase()}`;
/** #3's TEST limit sell of BTC, far over the market, so it rests until #5 cancels it. */
const SELL = { amount: '0.001', price: '90000' };
const STAKE = '25';
const LONG = { amount: '0.001', price: '61000', leverageBps: 100_000 };
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.beforeAll(() => {
  test.setTimeout(240_000);
  restartWithSetting('ops', 'LOCAL_STACK_VALUATION_PRICES', 'test');
});
test.afterAll(() => {
  test.setTimeout(240_000);
  restartWithSetting('ops', 'LOCAL_STACK_VALUATION_PRICES', null);
});

const state = () => walletPerson(run, J);
const withWallet = (page) => signInWithWallet(page, state());

// ── exact decimals ───────────────────────────────────────────────────────────
const SCALE = 10n ** 18n;
function units(decimal) {
  const text = String(decimal).replace(/,/g, '');
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const v = BigInt(whole || '0') * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return negative ? -v : v;
}
function decimal(v) {
  const negative = v < 0n;
  const a = negative ? -v : v;
  const frac = (a % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${a / SCALE}${frac ? `.${frac}` : ''}`;
}
const grouped = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A decimal as Assets prints an amount: thousands grouped, no trailing zeros. */
function shown(value) {
  const [whole, frac = ''] = decimal(units(value)).split('.');
  return `${grouped(whole)}${frac ? `.${frac}` : ''}`;
}
/** A scaled value rounded once, half up, to `places`. */
const round = (v, places) => {
  const step = 10n ** BigInt(18 - places);
  return ((v + step / 2n) / step) * step;
};
function fixed(v, places) {
  const [whole, frac = ''] = decimal(v).split('.');
  return `${whole}.${frac.padEnd(places, '0').slice(0, places)}`;
}
/** Dollars as Assets prints them: grouped, to the cent, rounded half up. */
const dollars = (v) => {
  const [whole, cents] = fixed(round(v, 2), 2).split('.');
  return `$${grouped(whole)}.${cents}`;
};
/** A share as Assets prints it: value × 100 / total, cut at 18 places, then half up to 0.01. */
const share = (value, total) => `${fixed(round((value * 100n * SCALE) / total, 2), 2)}%`;
const sum = (list) => list.reduce((a, b) => a + b, 0n);

// ── each source's own record ─────────────────────────────────────────────────
/** The stack's TEST chain's TEST USD (services/svc-protocol/scripts/seed-test-chain.ts TEST_TOKENS.USD), 6 decimals. */
const TEST_USD = '0x000000000000000000000000000000000000d011';
/** The chain's own figures for `owner` at `block`: TEST ETH and TEST USD as decimals. */
async function chainAt(owner, block) {
  const tag = `0x${BigInt(block).toString(16)}`;
  const data = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
  const [eth, usd] = await Promise.all([
    testChainRead('eth_getBalance', [owner, tag]),
    testChainRead('eth_call', [{ to: TEST_USD, data }, tag]),
  ]);
  return { ETH: decimal(BigInt(eth)), TESTUSD: decimal(BigInt(usd) * 10n ** 12n) };
}
/** The partner's own figure for the person, as svc-bank reads it from the partner (`spaces.list` rows with `heldAt`). */
async function partnerHeld(who, asset) {
  const session = await api(who);
  const input = encodeURIComponent(JSON.stringify({ limit: 200 }));
  const res = await session.get(`/api/bank/trpc/spaces.list?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return sum(res.body.result.data.filter((s) => s.heldAt && s.assetId === asset).map((s) => units(s.balance)));
}
const openOrders = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const lockOn = (orders, asset) => sum(orders.filter((o) => o.lockedAsset === asset).map((o) => units(o.locked)));

const order = (owner, side, type, { amount, price }, timeInForce, tag) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side,
  type,
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: `order:${owner}:btc-usdc:pf1${tag}${randomBytes(4).toString('hex')}`,
  builderFee: null,
});

// ── the page ─────────────────────────────────────────────────────────────────
/** Assets open with the wallet connected. */
async function openAssets(page, { fresh = true } = {}) {
  const { owner } = state();
  if (fresh) await withWallet(page);
  await page.goto('/money');
  await page.mouse.move(0, 600);
  const sources = page.getByTestId('assets-by-source');
  await expect(sources).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.locator(`[data-testid="source-wallet"][data-address="${owner}"]`));
  return sources;
}
const cell = async (row, name) =>
  (
    (
      await row
        .locator(`[data-cell="${name}"]`)
        .innerText()
        .catch(() => '')
    ).split('\n')[0] ?? ''
  ).trim();
/** The venue row for `asset` once it shows exactly the venue's own free, locked and total, and the venue's figures. */
async function venueRowAgrees(page, owner, asset) {
  const row = page.getByTestId('source-venue').locator(`tr[data-asset="${asset}"]`);
  let venue;
  await expect
    .poll(
      async () => {
        venue = await venueBalance(owner, asset);
        return (
          (await cell(row, 'free')) === shown(venue.free) &&
          (await cell(row, 'locked')) === shown(venue.locked) &&
          (await cell(row, 'total')) === shown(venue.total) &&
          (venue.lockedBy
            ? (await row
                .locator('[data-part="in-orders"]')
                .getAttribute('data-amount')
                .catch(() => null)) !== null
            : true) &&
          (!venue.lockedBy || sameUnits(await row.locator('[data-part="in-orders"]').getAttribute('data-amount'), venue.lockedBy.inOrders))
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return { row, venue };
}
const sameUnits = (a, b) => a !== null && units(a) === units(b);
/** The lock's parts as the page shows them, each from its own element, and its words. */
async function splitShown(row) {
  const part = (name) => row.getByTestId('source-venue-split').locator(`[data-part="${name}"]`);
  return {
    inOrders: units(await part('in-orders').getAttribute('data-amount')),
    collateral: units(await part('collateral').getAttribute('data-amount')),
    stake: units(await part('stake').getAttribute('data-amount')),
    words: {
      inOrders: (await part('in-orders').innerText()).trim(),
      collateral: (await part('collateral').innerText()).trim(),
      stake: (await part('stake').innerText()).trim(),
    },
  };
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'pf1v');
    await verify(page, who);
    const walletKey = testWalletKey();
    run.reset({ account: who, walletKey });
    const session = await api(who);
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');

    // Wallet: TEST USD minted into it, then TEST 10 USD sent from it to the venue's deposit address.
    fundOnTestChain(owner, 'venue');
    const door = await session.get('/api/v1/venue/status');
    expect(door.status, JSON.stringify(door.body)).toBe(200);
    const deposit = door.body.deposit;
    expect(deposit, 'the TEST venue publishes where a wallet deposits').toMatchObject({ chainId: CHAIN_ID, asset: 'USDC' });
    const wallet = createWalletClient({
      account: key,
      transport: http(testChain().gateUrl),
      chain: {
        id: CHAIN_ID,
        name: 'TEST',
        nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [testChain().gateUrl] } },
      },
    });
    const txHash = await wallet.sendTransaction({
      to: deposit.token,
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [deposit.address, parseUnits(CHAIN_DEPOSIT, deposit.tokenDecimals)],
      }),
    });
    await expect
      .poll(
        async () => (await venueRecord(owner, '/deposits')).value.find((d) => d.txHash.toLowerCase() === txHash.toLowerCase())?.status,
        {
          timeout: 120_000,
        },
      )
      .toBe('credited');

    // Venue: TEST 500 USDC, then one TEST buy of BTC filled against a sell another TEST trader rests first.
    expect(await testDeposit(owner, 'USDC', VENUE_USDC, `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const seller = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
    await testVenue('/test/deposit', {
      account: await venueAccount(otherTraderKey(seller).address),
      asset: 'BTC',
      amount: '1',
      depositRef: `seed:${seller}:BTC`,
    });
    const rested = await otherTraderRun(seller, {
      ...order(otherTraderKey(seller).address.toLowerCase(), 'sell', 'limit', BOUGHT, 'GTC', 'ask'),
    });
    expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
    await signedOnVenue(walletKey, order(owner, 'buy', 'limit', BOUGHT, 'IOC', 'buy'));
    await expect.poll(async () => (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value.length).toBe(1);

    // The open order the journey starts with.
    await signedOnVenue(walletKey, order(owner, 'buy', 'limit', RESTING, 'GTC', 'rest'));
    const [resting] = await openOrders(owner);
    expect(resting?.status).toBe('open');

    // Partner: the person's bank money at the TEST partner bank, with TEST USDT paid in there.
    await setPartner(who, { custody: 'off' });
    const tag = `${process.env.JOURNEY_RUN_ID ?? 'local'}${session.userId}`.replace(/[^A-Za-z0-9-]/g, '').slice(-40);
    const funded = await session.post('/api/bank/trpc/testPartner.fund', { fundId: `pf1v-${tag}`, assetId: 'USDT', amount: PARTNER_USDT });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    expect(funded.body.result.data).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT' });
    run.write({ resting: resting.venueClientOrderId, txHash: txHash.toLowerCase(), ledgerStart: await session.balances() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens /money: every holding in the wallet, the venue account and the partner account with amount, price, value, share and source; the total with its breakdown by source and quick actions`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { account: who, owner, ledgerStart } = state();
  const { displayName: venueName } = await venueInfo();
  const prices = await pricesPublished();
  expect(prices).toMatchObject({ published: true, test: true, source: 'TEST price list' });
  const price = new Map(prices.prices.map((row) => [row.asset, units(row.usd)]));
  await openAssets(page);

  // Each source's own figures; the total is what is priced, worked out here from those figures.
  const walletSection = page.getByTestId('source-wallet');
  const block = await walletSection.getByTestId('source-wallet-block').getAttribute('data-block');
  const chain = await chainAt(owner, block);
  const venueRows = (await venueRecord(owner, '/balances')).value.filter((b) => units(b.total) !== 0n);
  const partnerUsdt = await partnerHeld(who, 'USDT');
  expect(partnerUsdt).toBe(units(PARTNER_USDT));
  const valued = [
    ...Object.entries(chain).map(([asset, amount]) => ({ part: 'wallet', asset, amount: units(amount) })),
    ...venueRows.map((b) => ({ part: 'venue', asset: b.asset, amount: units(b.total) })),
    { part: 'partner', asset: 'USDT', amount: partnerUsdt },
  ]
    .filter((row) => row.amount !== 0n)
    .map((row) => ({ ...row, price: price.get(row.asset) ?? null }))
    .map((row) => ({ ...row, value: row.price === null ? null : (row.amount * row.price) / SCALE }));
  const total = sum(valued.filter((row) => row.value !== null).map((row) => row.value));
  expect(total, 'the venue USDC and the partner USDT are priced').toBeGreaterThan(0n);

  /** One holding's row: its amount as its source reports it, then price, value, share and source. */
  async function holding(section, row, { amountCells, source }) {
    const el = page.getByTestId(section).locator(`tr[data-asset="${row.asset}"]`);
    for (const [name, value] of Object.entries(amountCells))
      await expect(el.locator(`[data-cell="${name}"]`).first()).toHaveText(new RegExp(`^${shown(value).replace(/\./g, '\\.')}`));
    if (row.price === null) {
      await expect(el.locator('[data-cell="price"]')).toHaveText('No price published');
      await expect(el.locator('[data-cell="value"]')).toHaveText('No price published');
      await expect(el.locator('[data-cell="share"]')).toHaveText('—');
    } else {
      await expect(el.locator('[data-cell="price"]')).toHaveText(dollars(row.price));
      await expect(el.locator('[data-cell="value"]')).toHaveText(dollars(row.value));
      await expect(el.locator('[data-cell="share"]')).toHaveText(share(row.value, total));
    }
    const sourceCell = el.locator('[data-cell="source"]');
    await expect(sourceCell).toHaveAttribute('data-source', row.part);
    await expect(sourceCell).toContainText(source);
  }
  // The wallet: every token the chain holds for the address at the block the page names.
  const walletRows = valued.filter((row) => row.part === 'wallet');
  await expect(walletSection.locator('tbody tr')).toHaveCount(walletRows.length);
  for (const row of walletRows)
    await holding('source-wallet', row, { amountCells: { amount: decimal(row.amount) }, source: `${NETWORK}, block ${block}` });
  // The venue account: free, locked and total exactly as the venue reports them, each asset it holds.
  await expect(page.getByTestId('source-venue').locator('tbody > tr')).toHaveCount(venueRows.length);
  for (const b of venueRows) {
    const row = valued.find((r) => r.part === 'venue' && r.asset === b.asset);
    await holding('source-venue', row, { amountCells: { free: b.free, locked: b.locked, total: b.total }, source: venueName });
  }
  // The partner account: what the partner reports it holds.
  await holding(
    'source-partner',
    valued.find((r) => r.part === 'partner'),
    { amountCells: { amount: decimal(partnerUsdt) }, source: PARTNER_BANK },
  );

  // The total value header: the sum of what is priced, to the cent, with its breakdown by source, each named with its
  // source and as-of time, and what is left out named.
  const standing = page.getByTestId('assets-total');
  await expect(standing.getByTestId('standing-figure')).toHaveAttribute('data-total-usd', fixed(round(total, 2), 2));
  await expect(standing.getByTestId('standing-prices')).toContainText('TEST price list');
  const parts = standing.getByTestId('standing-part');
  await expect(parts).toHaveCount(3);
  for (const [id, label] of [
    ['wallet', NETWORK],
    ['venue', venueName],
    ['partner', PARTNER_BANK],
  ]) {
    const part = standing.locator(`[data-testid="standing-part"][data-part="${id}"]`);
    const partValue = sum(valued.filter((r) => r.part === id && r.value !== null).map((r) => r.value));
    await expect(part).toHaveAttribute('data-value-usd', partValue === 0n ? '' : decimal(partValue));
    await expect(part.getByTestId('standing-part-label')).toContainText(label);
    if (id !== 'wallet') await expect(part.getByTestId('standing-part-value')).toHaveText(dollars(partValue));
    await expect(part.getByTestId('standing-part-as-of')).toHaveAttribute('datetime', /\d{4}-\d\d-\d\dT/);
  }
  await expect(standing.getByTestId('standing-unpriced')).toHaveAttribute(
    'data-assets',
    [...new Set(valued.filter((r) => r.price === null).map((r) => r.asset))].join(','),
  );

  // Quick actions beside the total, each going to a real room.
  const actions = page.getByTestId('assets-actions');
  for (const [name, href] of [
    ['Trade', /^\/trade\/spot\//],
    ['Fund your venue account', /^\/wallet\/venue$/],
    ['Activity', /^\/money\/activity$/],
  ])
    await expect(actions.locator('a').filter({ hasText: new RegExp(`^${name}$`) })).toHaveAttribute('href', href);
  await actions
    .locator('a')
    .filter({ hasText: /^Fund your venue account$/ })
    .click();
  await expect(page).toHaveURL(/\/wallet\/venue$/);

  // INTAFACED holds none of it: the ledger holds nothing for this person and posted nothing.
  expect(await (await api(who)).balances()).toEqual(ledgerStart);
});

/** Places #3's TEST limit sell of BTC on the desk, signed in the wallet; returns the venue's order. */
async function sellOnDesk(page, owner) {
  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.getByTestId('venue-wallet-address').filter({ hasText: new RegExp(owner, 'i') }));
  await page
    .locator('[role=tab]', { hasText: /^Limit$/ })
    .first()
    .click();
  await page.getByRole('textbox', { name: 'Price', exact: true }).nth(1).fill(SELL.price);
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).nth(1).fill(SELL.amount);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: 'Sell BTC', exact: true }).click();
  // A sell carries the builder fee: the review asks the wallet to approve it first, and Confirm sell waits for that.
  const sheet = reviewSheet(page);
  await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
  await continueInWallet(page);
  await expect(sheet.locator('[data-line="builder-fee"]')).not.toContainText('Not signed', { timeout: 20_000 });
  await confirm(page, 'sell');
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText('Open on the venue.');
  const sold = (await openOrders(owner)).find((o) => o.side === 'sell' && o.symbol === SYMBOL);
  expect(sold?.status).toBe('open');
  return sold;
}

test(`${J} #3 places a TEST limit order on the venue, then opens the balance breakdown: the venue's free falls and its locked by open orders rises by the order's hold, and the parts add to the venue's total`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  await openAssets(page);
  const before = await venueRowAgrees(page, owner, 'BTC');
  const beforeSplit = await splitShown(before.row);

  const sold = await sellOnDesk(page, owner);
  // The desk keeps the business key of each order it placed for this browser tab (sessionStorage); #5 opens a new tab
  // as the same browser, so it carries them, and Cancel there names this order as the desk's own.
  const deskKeys = await page.evaluate((name) => sessionStorage.getItem(name), deskKeysName(owner));
  expect(deskKeys, "the desk's own key for the sell").toContain(sold.venueClientOrderId);
  run.write({ sold: sold.venueClientOrderId, deskKeys });
  expect(sold.lockedAsset).toBe('BTC');
  const hold = units(sold.locked);
  expect(hold).toBe(units(SELL.amount));

  await openAssets(page, { fresh: false });
  const after = await venueRowAgrees(page, owner, 'BTC');
  // Free falls by the hold, locked by open orders rises by it, and the total is unchanged: the venue's own figures.
  expect(units(after.venue.free)).toBe(units(before.venue.free) - hold);
  expect(units(after.venue.locked)).toBe(units(before.venue.locked) + hold);
  expect(units(after.venue.total)).toBe(units(before.venue.total));
  const split = await splitShown(after.row);
  expect(split.inOrders).toBe(beforeSplit.inOrders + hold);
  expect(split.inOrders).toBe(units(after.venue.lockedBy.inOrders));
  expect(split.words.inOrders).toBe(`In orders ${shown(decimal(split.inOrders))}`);
  // The lock names the order behind it.
  await expect(after.row.locator(`li[data-order="${sold.venueClientOrderId}"]`)).toContainText(
    `(sell ${SYMBOL}) locks ${shown(sold.locked)} BTC`,
  );
  // The parts add to the venue's total exactly, as shown: free + in orders + collateral + stake.
  expect(units(await cell(after.row, 'free')) + split.inOrders + split.collateral + split.stake).toBe(
    units(await cell(after.row, 'total')),
  );
  expect(units(await cell(after.row, 'locked'))).toBe(split.inOrders + split.collateral + split.stake);
});

test(`${J} #4 reads stake and collateral separately: a TEST stake and a TEST futures margin sit under Locked, not under In orders`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, walletKey } = state();
  // TEST, inside the step: a stake of USDC on the venue, and an isolated perpetual long whose posted margin is collateral.
  const staked = await testVenue('/test/stake', {
    account: await venueAccount(owner),
    asset: 'USDC',
    amount: STAKE,
    stakeRef: `stake:${owner}:pf1`,
  });
  expect(staked.status, JSON.stringify(staked.body)).toBe(200);
  await signedOnVenue(walletKey, { kind: 'update_leverage', symbol: PERP, leverageBps: LONG.leverageBps, marginMode: 'isolated' });
  await signedOnVenue(walletKey, { ...order(owner, 'buy', 'limit', LONG, 'IOC', 'long'), symbol: PERP });
  let positions;
  await expect.poll(async () => (positions = (await venueRecord(owner, '/positions')).value).length, { timeout: 20_000 }).toBe(1);
  const margin = sum(positions.map((p) => units(p.margin)));
  expect(margin).toBeGreaterThan(0n);
  const orders = await openOrders(owner);

  await openAssets(page);
  const { row, venue } = await venueRowAgrees(page, owner, 'USDC');
  const split = await splitShown(row);
  // Stake and collateral are read apart, each as the venue reports it, and both sit under Locked.
  expect(split.stake).toBe(units(STAKE));
  expect(split.collateral).toBe(margin);
  expect(split.words.stake).toBe(`Stake ${shown(STAKE)}`);
  expect(split.words.collateral).toBe(`Collateral ${shown(decimal(margin))}`);
  expect(units(venue.locked)).toBe(split.inOrders + split.collateral + split.stake);
  expect(units(await cell(row, 'locked'))).toBe(units(venue.locked));
  // Not under In orders: that part is the open orders' locks alone, and the order list names only orders.
  expect(split.inOrders).toBe(lockOn(orders, 'USDC'));
  await expect(row.getByTestId('source-venue-locks').locator('li')).toHaveCount(orders.filter((o) => o.lockedAsset === 'USDC').length);
  for (const li of await row.getByTestId('source-venue-locks').locator('li').all()) await expect(li).toContainText('Open order');
  // Free is what is left: the venue's total less every lock.
  expect(units(await cell(row, 'free'))).toBe(units(venue.total) - units(venue.locked));
});

test(`${J} #5 cancels the order: the venue's lock returns to free and the locked list is empty`, async ({ page }) => {
  test.setTimeout(240_000);
  const { owner, sold, deskKeys } = state();
  expect(sold, "#3's order").toBeTruthy();
  expect(deskKeys, "#3's desk keys").toBeTruthy();
  await page.addInitScript(
    ([name, keys]) => {
      if (!sessionStorage.getItem(name)) sessionStorage.setItem(name, keys);
    },
    [deskKeysName(owner), deskKeys],
  );
  await openAssets(page);
  const before = await venueRowAgrees(page, owner, 'BTC');
  const held = (await openOrders(owner)).find((o) => o.venueClientOrderId === sold);
  expect(held?.status).toBe('open');

  await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  const address = page.getByTestId('venue-wallet-address').filter({ hasText: new RegExp(owner, 'i') });
  await connectWhenAsked(page, address);
  await expect(address).toBeVisible({ timeout: 30_000 });
  await page
    .getByTestId('venue-open-orders')
    .locator(`tr[data-client-order-id="${sold}"]`)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await continueInWallet(page);
  await expect(page.getByTestId('venue-bottom').getByTestId('venue-outcome')).toContainText(
    'Cancelled on the venue; its lock is released.',
  );
  await expect.poll(async () => (await openOrders(owner)).some((o) => o.venueClientOrderId === sold)).toBe(false);

  await openAssets(page, { fresh: false });
  const after = await venueRowAgrees(page, owner, 'BTC');
  // The lock is back in free, as the venue reports: free rises by it, locked falls to nothing, the total is the same.
  expect(units(after.venue.free)).toBe(units(before.venue.free) + units(held.locked));
  expect(units(after.venue.locked)).toBe(0n);
  expect(units(after.venue.total)).toBe(units(before.venue.total));
  await expect(after.row.locator('[data-cell="locked"]')).toHaveText(/^0\b/);
  // The locked list is empty: no order lock, and every part of the split is 0.
  await expect(after.row.getByTestId('source-venue-locks')).toHaveCount(0);
  const split = await splitShown(after.row);
  expect([split.inOrders, split.collateral, split.stake]).toEqual([0n, 0n, 0n]);
  await expect(after.row.locator('[data-cell="withdrawable"]')).toHaveText(shown(after.venue.total));
});

test(`${J} #6 opens what makes a number: the source records behind it (chain transactions, venue fills, partner lines), newest first, each with its reference`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { account: who, owner, txHash } = state();
  // Each source's own records for one figure on Assets.
  const chain = (await indexedTransfers(who, owner)).flatMap((row) =>
    row.transfers
      .filter((t) => t.direction !== 'self' && t.token.symbol === 'TESTUSD')
      .map(() => ({ ref: row.hash.toLowerCase(), at: row.timestamp * 1000 })),
  );
  expect(chain.map((r) => r.ref)).toContain(txHash);
  const fills = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value
    // Every fill whose bought or sold coin is BTC: the spot buy, and #4's perpetual long.
    .filter((f) => f.symbol.split('-')[0] === 'BTC')
    .map((f) => ({ ref: f.fillId, at: Date.parse(f.filledAt) }));
  expect(fills.length).toBeGreaterThan(0);
  const partner = (await partnerLines(who))
    .filter((item) => item.asset === 'USDT' || item.assetId === 'USDT')
    .map((item) => ({ ref: item.txId, at: Date.parse(item.postedAt ?? item.at) }));
  expect(partner.length).toBeGreaterThan(0);
  const newestFirst = (rows) => [...rows].sort((a, b) => b.at - a.at || a.ref.localeCompare(b.ref)).map((r) => r.ref);

  await openAssets(page);
  for (const [source, section, asset, records, kind] of [
    ['wallet', 'source-wallet', 'TESTUSD', chain, 'chain transactions'],
    ['venue', 'source-venue', 'BTC', fills, 'venue fills'],
    ['partner', 'source-partner', 'USDT', partner, 'partner lines'],
  ]) {
    await page.goto('/money');
    await connectWhenAsked(page, page.locator(`[data-testid="source-wallet"][data-address="${owner}"]`));
    const link = page.getByTestId(section).locator(`tr[data-asset="${asset}"]`).getByTestId('source-entries-link');
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/money/balance/${asset}\\?source=${source}$`));
    await expect(page.getByTestId('source-records-title')).toHaveAttribute('data-source', source);
    const list = page.getByTestId('activity-by-source');
    const rows = list.getByTestId('money-act');
    // Exactly the source's own records for this asset, every one from that source, newest first.
    await expect(rows, kind).toHaveCount(records.length, { timeout: 30_000 });
    await expect(list.locator(`[data-testid="money-act"]:not([data-source="${source}"])`)).toHaveCount(0);
    const refs = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-ref')));
    expect(refs, `${kind}, newest first`).toEqual(newestFirst(records));
    const times = await rows
      .locator('[data-testid="money-act__time"] time')
      .evaluateAll((els) => els.map((el) => Date.parse(el.getAttribute('datetime'))));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Each with its own reference, in words.
    for (const [i, ref] of refs.entries()) await expect(rows.nth(i).getByTestId('money-act__ref')).toHaveText(`Reference ${ref}`);
  }
});
