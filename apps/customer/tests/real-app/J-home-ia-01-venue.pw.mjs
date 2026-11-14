// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState, restartWithSetting } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { CHAIN_ID, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, TEST_WALLET, testWalletKey } from './test-wallet.mjs';
import { setPartner } from './partner.mjs';
import { testDeposit, venueBalance, venueForThisFile, venueRecord } from './venue.mjs';

// J-home-ia-01 #1 #2 #3, in the running app (docs/roadmap/journeys.json): I open the app and see where I stand, on the
// launch model (OWNER 226): INTAFACED holds none of the money. Tests titled "J-home-ia-01 #<n>" prove a whole step; #4 to
// #9 are in J-home-ia-01.pw.mjs.
//
// TEST setup (beforeAll, not a step), the journey's start: one verified TEST person with one TEST browser wallet, funded
// on the stack's TEST chain (`fund <address> venue`: TEST ETH for gas and 100 TEST USD), TEST 500 USDC in their account
// on the TEST venue (its deposit control), and their bank money held at the stack's TEST partner bank
// (`testPartner.set({ custody: 'off' })`) with TEST 50 USDT funded there. svc-trade's user-venue door is on for this
// file (venueForThisFile) and svc-ops publishes its TEST price list (`LOCAL_STACK_VALUATION_PRICES=test`: USDC and USDT
// at 1, nothing for BTC or the TEST chain's tokens), both put back after the file.
//
// Every figure is checked against its own source: the chain's node at the block Assets names, the venue's record, the
// partner's answer and svc-ops' published prices; the total is worked out here from those sources, in exact decimals.
const J = 'J-home-ia-01';
const VENUE_USDC = '500';
const PARTNER_USDT = '50';
/** svc-bank's TEST partner bank's own name (`partner/test-partner.ts`). */
const PARTNER_BANK = 'TEST partner bank';
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

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** svc-ops' published prices, as anyone reads them (the read is public). */
async function publishedPrices() {
  const res = await fetch(`${EDGE}/api/ops/trpc/valuation.prices`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** Exact decimal arithmetic at 18 places, as the app does it: no float touches an amount. */
const SCALE = 10n ** 18n;
function units(decimal) {
  const [whole, frac = ''] = String(decimal).split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(18, '0').slice(0, 18) || '0');
}
function cents(value) {
  const rounded = (value + 5n * 10n ** 15n) / 10n ** 16n;
  const text = rounded.toString().padStart(3, '0');
  const whole = text.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${text.slice(-2)}`;
}

/** What the total must be: each read part's holdings at its published price, summed, then rounded once to cents. */
async function expectedTotal({ owner, partner = true }) {
  const prices = await publishedPrices();
  expect(prices).toMatchObject({ published: true, test: true, source: 'TEST price list' });
  const price = new Map(prices.prices.map((row) => [row.asset, units(row.usd)]));
  expect(price.has('BTC'), 'the TEST price list publishes no BTC price').toBe(false);
  const venue = await venueBalance(owner, 'USDC');
  const parts = {
    venue: (units(venue.total) * price.get('USDC')) / SCALE,
    partner: partner ? (units(PARTNER_USDT) * price.get('USDT')) / SCALE : 0n,
  };
  return { prices, venue, parts, total: cents(parts.venue + parts.partner) };
}

/** Connects the TEST wallet when the page asks for it, until `connected` shows (a page may restore the connection itself). */
async function connectWhenAsked(page, connected) {
  const connect = page.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  await expect
    .poll(
      async () => {
        if (await connected.isVisible().catch(() => false)) return true;
        if (await connect.isVisible().catch(() => false)) await connect.click({ timeout: 2_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
}

/** Signed in with the TEST wallet on the TEST chain in this page. */
async function withWallet(page) {
  const { account: who, walletKey } = state();
  await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  await signIn(page, who);
}

const standingOn = (page) => page.getByTestId('home-standing');
const partOf = (scope, id) => scope.locator(`[data-testid="standing-part"][data-part="${id}"]`);
const spoken = (scope) => scope.getByTestId('standing-figure').locator('[data-slot="hero-number"] [role=img]').getAttribute('aria-label');

/**
 * Balances shown, as the account's own choice (another step may have left them hidden): waits for Home's eye to answer,
 * then shows them if they are hidden.
 */
async function balancesShown(page) {
  const show = page.getByRole('button', { name: 'Show balances' }).first();
  const hide = page.getByRole('button', { name: 'Hide balances' }).first();
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await savedToAccount(page, () => show.click());
  await expect(hide).toBeVisible();
}

/** Home with the wallet connected and every part answered. */
async function openHome(page) {
  await page.goto('/');
  const standing = standingOn(page);
  await connectWhenAsked(page, standing);
  await expect(standing.locator('[data-testid="standing-part"][data-state="reading"]')).toHaveCount(0, { timeout: 30_000 });
  return standing;
}

/** Waits until the page's total is the one worked out from the sources just before or just after it was read. */
async function totalIs(scope, owner, options) {
  await expect
    .poll(
      async () => {
        const before = (await expectedTotal({ owner, ...options })).total;
        const shown = await spoken(scope).catch(() => null);
        const after = (await expectedTotal({ owner, ...options })).total;
        return shown === before || shown === after ? 'same' : `page ${shown}, sources ${before} then ${after}`;
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe('same');
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'hmv');
    await verify(page, who);
    const walletKey = testWalletKey();
    run.reset({ account: who, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(testChain().chain, 'the stack runs its TEST chain').toBe('running');
    fundOnTestChain(owner, 'venue');
    expect(await testDeposit(owner, 'USDC', VENUE_USDC, `${CHAIN_ID}:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    await setPartner(who, { custody: 'off' });
    const session = await api(who);
    const funded = await session.post('/api/bank/trpc/testPartner.fund', {
      fundId: `hm01-${randomBytes(6).toString('hex')}`,
      assetId: 'USDT',
      amount: PARTNER_USDT,
    });
    expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    expect(funded.body.result.data).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: PARTNER_USDT });
    run.write({ ledgerStart: await session.balances() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 Home's total adds what the wallet, the venue account and the partner account report, each with its source and as-of time; a source that can't be read is named and left out; BTC with no BTC price stays in dollars with a note; unpriced assets are named`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { account: who, owner, ledgerStart } = state();
  const venueBefore = Date.parse((await venueRecord(owner, '/balances')).asOf);
  await withWallet(page);
  const standing = await openHome(page);
  await balancesShown(page);

  // The total is the sum of what is priced, worked out here from the venue's and the partner's own figures at svc-ops'
  // published TEST prices, to the cent, and labelled TEST.
  await totalIs(standing, owner);
  const { prices, venue, parts } = await expectedTotal({ owner });
  expect(venue.total).toBe(VENUE_USDC);
  await expect(standing.getByTestId('standing-test')).toHaveText('TEST');
  await expect(standing.getByTestId('standing-prices')).toContainText('Valued at the prices TEST price list states.');
  await expect(standing.getByTestId('standing-prices-as-of')).toHaveAttribute('datetime', prices.asOf);

  // Each part with its source and its own as-of time.
  const wallet = partOf(standing, 'wallet');
  await expect(wallet).toHaveAttribute('data-state', 'read');
  await expect(wallet.getByTestId('standing-part-label')).toHaveText(`Your wallet on Base Sepolia test network`);
  await expect(wallet.getByTestId('standing-part-source')).toHaveText('read from the chain');
  const walletAsOf = Date.parse(await wallet.getByTestId('standing-part-as-of').getAttribute('datetime'));
  expect(walletAsOf).toBeLessThanOrEqual(Date.now());
  // Nothing in the wallet has a published price, so the wallet adds nothing and says so, never $0.
  await expect(wallet).toContainText('Not valued: no published price');
  await expect(wallet).toHaveAttribute('data-value-usd', '');

  const venuePart = partOf(standing, 'venue');
  await expect(venuePart).toHaveAttribute('data-state', 'read');
  await expect(venuePart.getByTestId('standing-part-label')).toHaveText(/^Your venue account on .+/);
  await expect(venuePart.getByTestId('standing-part-source')).toHaveText('the venue’s own figures');
  const venueAsOf = Date.parse(await venuePart.getByTestId('standing-part-as-of').getAttribute('datetime'));
  expect(venueAsOf).toBeGreaterThanOrEqual(venueBefore);
  expect(venueAsOf).toBeLessThanOrEqual(Date.parse((await venueRecord(owner, '/balances')).asOf));
  await expect(venuePart.getByTestId('standing-part-value')).toHaveText(cents(parts.venue));

  const partner = partOf(standing, 'partner');
  await expect(partner).toHaveAttribute('data-state', 'read');
  await expect(partner.getByTestId('standing-part-label')).toHaveText(`Your account at ${PARTNER_BANK}`);
  await expect(partner.getByTestId('standing-part-source')).toHaveText('the partner’s own figures');
  expect(Date.parse(await partner.getByTestId('standing-part-as-of').getAttribute('datetime'))).toBeLessThanOrEqual(Date.now());
  await expect(partner.getByTestId('standing-part-value')).toHaveText(cents(parts.partner));

  // Unpriced assets are named, never counted as zero: the wallet's TEST ETH and TEST USD have no published price.
  const unpriced = standing.getByTestId('standing-unpriced');
  await expect(unpriced).toContainText('Not counted, because no price is published for them:');
  const named = (await unpriced.getAttribute('data-assets')).split(',');
  expect(named).toEqual(expect.arrayContaining(['ETH', 'TESTUSD']));
  for (const asset of named) expect(prices.prices.map((row) => row.asset)).not.toContain(asset);
  await expect(standing.getByTestId('standing-unread')).toHaveCount(0);

  // The partner cannot say what it holds: its part is named as not read and left out of the total, never counted as 0.
  await setPartner(who, { figures: 'unknown' });
  try {
    await page.reload();
    await expect(partner).toHaveAttribute('data-state', 'unread', { timeout: 30_000 });
    await expect(partner.getByTestId('standing-part-unread')).toHaveText('Couldn’t be read, so it is left out of the total.');
    await expect(standing.getByTestId('standing-unread')).toHaveAttribute('data-parts', 'partner');
    await expect(standing.getByTestId('standing-unread')).toContainText(
      'Left out of the total because it couldn’t be read: Your partner account.',
    );
    await totalIs(standing, owner, { partner: false });
  } finally {
    await setPartner(who, { figures: 'live' });
  }

  // The person picks BTC: no BTC price is published, so the total stays in dollars with a note, and nothing errors.
  await page.goto('/view');
  await savedToAccount(page, () => page.getByLabel('Display currency').selectOption('BTC'));
  try {
    const again = await openHome(page);
    await expect(again.getByTestId('standing-figure')).toHaveAttribute('data-unit', 'USD');
    await totalIs(again, owner);
    await expect(again.getByTestId('standing-unit-note')).toHaveText('There is no BTC price right now, so the total is shown in dollars.');
    await expect(page.locator('[data-slot="state-block"][data-kind="error"]')).toHaveCount(0);
  } finally {
    await page.goto('/view');
    await savedToAccount(page, () => page.getByLabel('Display currency').selectOption('USD'));
  }
  // Nothing moved: the ledger holds for this person what it held at the start.
  expect(await (await api(who)).balances()).toEqual(ledgerStart);
});

/** Do `act`, then wait until the change is written to the account's view record (the app waits half a second, then writes). */
async function savedToAccount(page, act) {
  const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST');
  await act();
  expect((await written).status()).toBe(200);
}

test(`${J} #2 the eye turns every amount on Home to bullets and keeps prices, and the choice is the same on another device after sign-in`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await withWallet(page);
  const standing = await openHome(page);
  const amounts = page.locator('main [data-slot="hero-number"], main [data-slot="money"], main [data-slot="amount"]');
  await expect(standing.getByTestId('standing-part-value').first()).toBeVisible();
  await savedToAccount(page, () => page.getByRole('button', { name: 'Hide balances' }).first().click());
  try {
    // Every amount on Home is bullets: the total, each part's value, and Recent activity's amounts.
    await expect(standing.locator('[data-slot="hero-number"]')).toHaveAttribute('data-hidden', 'true');
    await expect(standing.locator('[data-slot="hero-number"]').getByLabel('Hidden')).toBeVisible();
    expect(await amounts.count()).toBeGreaterThan(2);
    for (const amount of await amounts.all()) await expect(amount).toHaveAttribute('data-hidden', 'true');
    await expect(standing.getByTestId('standing-part-value').first()).toHaveText(/^•+$/);
    // Prices are not amounts: the price source line and Home's market prices still show, none of them masked.
    await expect(standing.getByTestId('standing-prices')).toContainText('Valued at the prices TEST price list states.');
    const markets = page.locator('section[aria-labelledby="home-markets-title"], [data-testid="hp-markets"]').first();
    await expect(markets).toContainText(/\d/);
    await expect(markets.locator('[data-hidden]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show balances' }).first()).toBeVisible();

    // A second device: a fresh browser with nothing stored, the same person signed in with the same wallet.
    const other = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
    try {
      const second = await other.newPage();
      await withWallet(second);
      const there = await openHome(second);
      await expect(there.locator('[data-slot="hero-number"]')).toHaveAttribute('data-hidden', 'true');
      await expect(there.getByTestId('standing-part-value').first()).toHaveText(/^•+$/);
      await expect(second.getByRole('button', { name: 'Show balances' }).first()).toBeVisible();
    } finally {
      await other.close();
    }
  } finally {
    await openHome(page);
    await balancesShown(page);
  }
});

test(`${J} #3 the total's Assets link opens Assets with the same total and the same holdings, grouped by where each sits`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner } = state();
  await withWallet(page);
  const home = await openHome(page);
  await balancesShown(page);
  await totalIs(home, owner);
  const onHome = {
    total: await spoken(home),
    parts: Object.fromEntries(
      await Promise.all(['wallet', 'venue', 'partner'].map(async (id) => [id, await partOf(home, id).getAttribute('data-value-usd')])),
    ),
  };
  // The total's own link, not the Money door in the top bar.
  await page.locator('[data-testid="home-label"], [data-testid="hp-label"]').getByRole('link', { name: 'Assets', exact: true }).click();
  await expect(page).toHaveURL(/\/money(\?|#|$)/);
  await connectWhenAsked(page, page.locator(`[data-testid="source-wallet"][data-address="${owner}"]`));
  const assets = page.getByTestId('assets-total');
  await expect(assets.locator('[data-testid="standing-part"][data-state="reading"]')).toHaveCount(0, { timeout: 30_000 });
  // The same total and the same value for each part as Home showed, or a newer reading of the same sources.
  await totalIs(assets, owner);
  expect([onHome.total, (await expectedTotal({ owner })).total]).toContain(await spoken(assets));
  for (const [id, value] of Object.entries(onHome.parts)) await expect(partOf(assets, id)).toHaveAttribute('data-value-usd', value);

  // The same holdings, grouped by where each sits, each amount as its source reports it.
  await expect(page.getByRole('heading', { name: 'In your wallet' })).toBeVisible();
  const block = await page.getByTestId('source-wallet-block').getAttribute('data-block');
  const tag = `0x${BigInt(block).toString(16)}`;
  const rpc = async (method, params) => {
    const res = await fetch(testChain().gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()).result;
  };
  const usd = BigInt(
    await rpc('eth_call', [
      { to: '0x000000000000000000000000000000000000d011', data: `0x70a08231${owner.slice(2).padStart(64, '0')}` },
      tag,
    ]),
  );
  expect(usd).toBe(100_000_000n);
  await expect(page.getByTestId('source-wallet').locator('tr[data-asset="TESTUSD"] [data-cell="amount"]')).toHaveText('100');
  await expect(page.getByTestId('source-wallet').locator('tr[data-asset="TESTUSD"] [data-cell="value"]')).toHaveText('No price published');
  const venueRow = page.getByTestId('source-venue').locator('tr[data-asset="USDC"]');
  await expect(venueRow.locator('[data-cell="total"]')).toHaveText((await venueBalance(owner, 'USDC')).total.replace(/\.0+$/, ''));
  await expect(venueRow.locator('[data-cell="value"]')).toHaveText('$500.00');
  await expect(page.getByRole('heading', { name: `In your account at ${PARTNER_BANK}` })).toBeVisible();
  const partnerRow = page.getByTestId('source-partner').locator('tr[data-asset="USDT"]');
  await expect(partnerRow.locator('[data-cell="amount"]')).toHaveText(PARTNER_USDT);
  await expect(partnerRow.locator('[data-cell="value"]')).toHaveText('$50.00');
  await expect(page.locator('main').first()).not.toContainText(/INTAFACED balance/i);
});
