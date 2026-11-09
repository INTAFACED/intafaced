// World: book, restart, gates, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import path from 'node:path';
import { api, bestPrices, fromUnits, journeyState, ROOT, signUpInBrowser, toUnits, signOutBrowser, restartWith } from './stack.mjs';
import { confirm, free, held, openDesk, openOrders, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { installTestWallet, testWalletKey, TEST_WALLET } from './test-wallet.mjs';
import { CHAIN_ID, testChain } from './dex.mjs';
import {
  otherVenueTrader,
  testVenue,
  testVenueId,
  venueBalance,
  venueBook,
  venueFills,
  venueOff,
  venueOn,
  venueOpenOrders,
  venueOrder,
  venueRead,
  venueStatus,
  VENUE_SPOT,
} from './venue.mjs';

// J-cex-spot-01, in the running app (docs/roadmap/journeys.json). One test per step, titled "J-cex-spot-01 #<n>", run in
// order on one TEST account. Every number here is a TEST number on the local stack. The person's venue account (its
// balances, locks, orders, fills and withdrawals) is read from the venue (venue.mjs), never from our ledger or engine;
// the ledger is read only where a step says it posts nothing.
const J = 'J-cex-spot-01';
const DESK = '/trade/spot/BTC-USDT';
/** The venue's TEST market the Starts line names, BTC/USDC, as the desk names it. */
const DESK_SYMBOL = 'BTC/USDC';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/**
 * A dollar figure as the app writes one (fmtUsd in apps/customer/src/data/format.ts): two decimals; under $1 up to four,
 * so a figure under $1 can read "$0.8094"; and "<$0.0001" for a non-zero figure below that.
 */
const DOLLARS = String.raw`(?:\$[\d,]+\.\d{2}|\$0\.\d{3,4}|<\$0\.0001)`;

test.describe.configure({ mode: 'default' });

// The venue's own figures need the user-venue door on, in front of the LOCAL TEST venue (venue.mjs); it is put back
// off after the file, as every other journey expects it.
test.beforeAll(() => venueOn());
test.afterAll(() => venueOff());

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function desk(page) {
  await openDesk(page, account());
}

/** A number as the room draws it ("65,000.10", "60.12 USDT", "$1.20"), as scaled units, so it compares to the service's. */
function shownUnits(text) {
  const found = /[+−-]?[\d,]+(\.\d+)?/.exec(text.replace(/\$/g, ''));
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, '').replace('−', '-').replace('+', ''));
}

/** A decimal the service sent, as scaled units; money on the wire is a decimal string, never a JSON number. */
function wireUnits(value) {
  if (typeof value !== 'string') throw new Error(`not a decimal string on the wire: ${JSON.stringify(value)}`);
  return toUnits(value);
}

/** A dollar figure from the service as the app shows it (fmtUsd): half up to the cent, or to 0.0001 under $1. */
function asShownUsd(value) {
  const units = wireUnits(value);
  const abs = units < 0n ? -units : units;
  const one = toUnits('1');
  const unit = one / 10n ** (abs < one ? 4n : 2n);
  let rounded = (abs / unit + ((abs % unit) * 2n >= unit ? 1n : 0n)) * unit;
  // A non-zero figure that rounds to nothing reads "<$0.0001", which shownUnits reads as 0.0001.
  if (rounded === 0n && abs !== 0n) rounded = unit;
  return units < 0n ? -rounded : rounded;
}

/**
 * A rate the service sends as a ratio ("0.0008"), as the percent the desk shows to two places ("0.08"), in units: rounded
 * half away from zero, so a rebate (a negative rate) rounds as its size does.
 */
function asPercent(ratio) {
  const cent = toUnits('0.01');
  const percent = wireUnits(ratio) * 100n;
  const size = percent < 0n ? -percent : percent;
  const rounded = ((size + cent / 2n) / cent) * cent;
  return percent < 0n ? -rounded : rounded;
}

/** The pointer leaves the top bar, as a person's does, so a door's hover menu closes over the room. */
async function pointerOff(page) {
  await page.mouse.move(0, 600);
}

/** One percent under the best bid, to the cent: a limit sell there still fills at the bids' own prices when the
 * market maker requotes between the read and the order, which a sell at the old best bid would not. */
async function underBid() {
  const { bid } = await bestPrices();
  const cent = toUnits('0.01');
  return fromUnits(((toUnits(bid) * 99n) / 100n / cent) * cent);
}

test(`${J} #1 signs up with an email and a password`, async ({ page }) => {
  const handle = `jt${Date.now().toString(36)}`;
  // A fresh TEST password per run, kept only in the run file (mode 600).
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  // Sign-up is J-identity-01's own journey: details, then the code the stack mails to its outbox file.
  await signUpInBrowser(page, who);
  await expect(page).not.toHaveURL(/\/register/);
  run.reset({ account: who });
  // An account exists: identity signs the same email and password in on a session of its own, and names its user id.
  const { userId } = await api(who);
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  // This browser is signed in as that account: its account menu names the handle, the account id and an unverified level.
  await page.getByRole('button', { name: 'Account menu' }).click();
  const summary = page.getByTestId('account-summary');
  await expect(summary).toContainText(`@${handle}`);
  await expect(summary).toContainText(`Account ID ${userId.slice(0, 8)}…`);
  await expect(summary).toContainText('Verification: Not verified');
  await page.keyboard.press('Escape');
  // Home, where the app opens, asks for verification where the total would be, with its own Verify now.
  await expect(page.getByRole('main').getByText('Verify your identity first').first()).toBeVisible();
  await expect(
    page
      .getByRole('link', { name: 'Verify now' })
      .or(page.getByRole('button', { name: 'Verify now' }))
      .first(),
  ).toBeVisible();
  // The Trade door, from the top bar, reads "Verify to trade" with the way to Verify, and that way opens Verification.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade', exact: true }).click();
  await expect(page).toHaveURL(/\/trade$/);
  await pointerOff(page);
  const access = page.getByTestId('trade-access');
  await expect(access).toHaveAttribute('data-state', 'verify');
  await expect(access.getByText('Verify to trade', { exact: true })).toBeVisible();
  const way = access.getByRole('link', { name: 'Verify now' });
  await expect(way).toHaveAttribute('href', '/verification');
  await way.click();
  await expect(page).toHaveURL(/\/verification(\?|$)/);
  await expect(page.getByTestId('verification__level-tag')).toContainText('Not verified');
  await expect(page.getByLabel('Level to request')).toBeVisible();
});

test(`${J} #2 tries a TEST limit buy before verifying and is refused in plain words`, async ({ page }) => {
  await desk(page);
  await page.getByRole('textbox', { name: 'Price' }).first().fill('60000.00');
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).toContainText('Verify your identity first');
  await expect(reason).toContainText('Verify now');
  await expect(reason).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code like trade.kyc_required
  expect(await openOrders(account())).toHaveLength(0);
  const balances = await (await api(account())).balances();
  expect(held(balances, 'USDT')).toBe(0n);
});

/** The stack's TEST sanctions list entry a trading check must hold (a TEST name only; never a real person). */
const LISTED = { legalName: 'TEST Listed Person', dateOfBirth: '1970-01-01', country: 'DE' };

/**
 * The trading checks on /verification, as a person passes them: their legal name, and the country they live in
 * confirmed. Nothing asks for an ID document, a selfie or an ID vendor. Returns the request the page sent.
 */
async function tradingChecks(page, { legalName, country }) {
  await page.goto('/verification');
  const checks = page.getByRole('form', { name: /trading checks/i });
  await expect(checks).toBeVisible();
  await checks.getByRole('textbox', { name: /legal name/i }).fill(legalName);
  const where = checks.getByRole('combobox', { name: /country you live in/i });
  await expect(where).toHaveValue(country);
  await checks.getByRole('checkbox', { name: /I live in/i }).check();
  // No ID document, selfie or ID vendor for trading.
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await expect(page.getByText(/selfie|passport|ID document|driving licen[cs]e|identity card/i)).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await checks.getByRole('button', { name: /run the checks|submit|continue/i }).click();
}

test(`${J} #3 passes the trading checks (legal name, country confirmed, sanctions on name, date of birth and country, no ID document, selfie or vendor): verified for trading; a hit reads "under review"; a blank list refuses`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const who = account();
  await signIn(page, who);
  await tradingChecks(page, { legalName: `TEST Trader ${who.handle}`, country: 'DE' });
  // Signs in again, so the session carries the new tier.
  await signOutBrowser(page.context());
  await signIn(page, who);
  // The tier reads verified for trading: on the Trade door and in the account menu.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Trade', exact: true }).click();
  await expect(page).toHaveURL(/\/trade$/);
  await pointerOff(page);
  const access = page.getByTestId('trade-access');
  await expect(access).toHaveAttribute('data-state', 'verified');
  await expect(access.getByText('Verified to trade', { exact: true })).toBeVisible();
  await expect(access.getByText('Verify to trade')).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByTestId('account-summary')).toContainText(/Verification: .*trading/i);
  await page.keyboard.press('Escape');
  // The desk accepts orders: the venue's own order preview for this account is answered, with no refusal on
  // verification (the person has not funded a venue account yet, so the venue's figures are all it can say).
  await venueStatus(who);
  await desk(page);
  await page.getByRole('textbox', { name: 'Price' }).first().fill('1000');
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).not.toContainText('Verify your identity first');
  await expect(reason).not.toContainText('Verify now');

  // A sanctions hit: another TEST person whose name, date of birth and country are on the stack's TEST list passes the
  // same checks and is held behind a neutral "under review" that never mentions screening; the desk keeps refusing.
  const hitContext = await browser.newContext();
  try {
    const hitPage = await hitContext.newPage();
    const handle = `jh${Date.now().toString(36)}`;
    const listed = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
    await signUpInBrowser(hitPage, listed, { country: LISTED.country, dateOfBirth: LISTED.dateOfBirth });
    await tradingChecks(hitPage, LISTED);
    await signOutBrowser(hitContext);
    await signIn(hitPage, listed);
    await hitPage.goto('/verification');
    await expect(hitPage.getByText(/under review/i).first()).toBeVisible();
    await expect(hitPage.locator('main')).not.toContainText(/screen|sanction|watch ?list|list match/i);
    await hitPage.goto('/trade');
    await expect(hitPage.getByTestId('trade-access')).not.toHaveAttribute('data-state', 'verified');
    await openDesk(hitPage, listed, DESK_SYMBOL);
    await hitPage.getByRole('textbox', { name: 'Price' }).first().fill('1000');
    await hitPage.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
    await expect(hitPage.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    await expect(hitPage.locator('#dk-reason-buy')).not.toContainText(/screen|sanction/i);
  } finally {
    await hitContext.close();
  }

  // With the owner's sanctions list blank, the check refuses kyc.screening_list_unset and clears nothing.
  restartWith('identity', 'LOCAL_STACK_IDENTITY_SANCTIONS_LIST', false);
  const blankContext = await browser.newContext();
  try {
    const blankPage = await blankContext.newPage();
    const handle = `jb${Date.now().toString(36)}`;
    const other = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
    await signUpInBrowser(blankPage, other);
    const answered = blankPage.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/identity\//.test(r.url()) && /kyc|verif|check/i.test(r.url()),
    );
    await tradingChecks(blankPage, { legalName: `TEST Trader ${handle}`, country: 'DE' });
    const refused = await (await answered).json();
    expect(JSON.stringify(refused), 'the check refuses with the typed code').toContain('kyc.screening_list_unset');
    await expect(blankPage.locator('[data-code="kyc.screening_list_unset"]')).toBeVisible();
    await signOutBrowser(blankContext);
    await signIn(blankPage, other);
    await blankPage.goto('/trade');
    await expect(blankPage.getByTestId('trade-access')).toHaveAttribute('data-state', 'verify');
  } finally {
    await blankContext.close();
    restartWith('identity', 'LOCAL_STACK_IDENTITY_SANCTIONS_LIST', true);
  }
});

/** The person's TEST wallet in `page`: one TEST key for the whole run, kept in the run file (mode 600), on the TEST chain. */
async function personWallet(page) {
  let { walletKey } = run.read();
  if (!walletKey) {
    walletKey = testWalletKey();
    run.write({ walletKey });
  }
  return installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
}

/** The venue desk for BTC/USDC with the person's TEST wallet connected; returns the wallet and the venue-account panel. */
async function venueDesk(page) {
  const wallet = await personWallet(page);
  await openDesk(page, account(), DESK_SYMBOL);
  const panel = venuePanel(page);
  await expect(panel).toBeVisible();
  const connect = panel.getByRole('button', { name: `Connect ${TEST_WALLET.name}` });
  if (await connect.isVisible()) await connect.click();
  await expect(panel).toContainText(`${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`);
  return { wallet, owner: wallet.address.toLowerCase(), panel };
}

/** The desk's venue-account panel: the person's own venue balances, as the venue reports them. */
const venuePanel = (page) => page.getByRole('region', { name: /venue account/i });

/** The figure the panel lists next to `label` (its dt/dd pair). */
const listed = (scope, label) =>
  scope
    .locator('div', { has: scope.page().locator('dt', { hasText: label }) })
    .locator('dd')
    .first();

/**
 * The panel shows the venue's own USDC figures for `owner`, unit for unit, with the venue's as-of time. Read again
 * until it does (the panel refreshes on its own); returns the venue's read.
 */
async function panelEqualsVenue(page, who, owner) {
  const panel = venuePanel(page);
  let venue;
  await expect(async () => {
    venue = await venueBalance(who, owner, 'USDC');
    expect(shownUnits(await listed(panel, /^Free$/).innerText()), 'free').toBe(wireUnits(venue.free));
    expect(shownUnits(await listed(panel, /^Used$/).innerText()), 'used').toBe(wireUnits(venue.locked));
    await expect(listed(panel, /^As of$/)).toHaveText(/\d{1,2}:\d{2}/, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  return venue;
}

/** Our ledger's view of this account, every asset, for the steps that say the ledger posts nothing. */
async function ledgerOf(who) {
  return (await api(who)).balances();
}

test(`${J} #4 connects a wallet and deposits TEST 1,000 USDC into the venue account, signing in the wallet; a replay adds nothing and the ledger posts nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = account();
  await venueStatus(who);
  const ledgerBefore = await ledgerOf(who);
  const { wallet, owner, panel } = await venueDesk(page);
  run.write({ owner });
  expect(toUnits((await venueBalance(who, owner, 'USDC')).total)).toBe(0n);
  // Deposits from the wallet into the venue account: the wallet is asked, and it signs.
  const asked = wallet.requests.length + wallet.sends.length;
  await panel.getByRole('button', { name: /^Deposit/ }).click();
  const deposit = page.getByRole('dialog', { name: /deposit/i });
  await deposit.getByRole('textbox', { name: /^Amount/ }).fill('1000');
  await expect(deposit).toContainText('USDC');
  await deposit
    .getByRole('button', { name: /deposit|sign/i })
    .last()
    .click();
  await expect.poll(() => wallet.requests.length + wallet.sends.length, { timeout: 30_000 }).toBeGreaterThan(asked);
  // The venue credits 1,000 USDC: free 1,000, used 0, and the desk shows the venue's figures with its as-of time.
  await expect.poll(async () => (await venueBalance(who, owner, 'USDC')).free, { timeout: 120_000 }).toMatch(/^1000(\.0+)?$/);
  const venue = await panelEqualsVenue(page, who, owner);
  expect(wireUnits(venue.free)).toBe(toUnits('1000'));
  expect(wireUnits(venue.locked)).toBe(0n);
  // The same deposit event replayed: the venue keys a deposit by its chain transfer, so it adds nothing.
  const transfer = wallet.sends.at(-1)?.hash;
  expect(transfer, 'the wallet sent the deposit as a chain transfer').toMatch(/^0x[0-9a-f]{64}$/);
  const replay = await testVenue('/test/deposit', {
    account: { venueId: (await venueStatus(who)).venue.id, owner, subAccount: null },
    asset: 'USDC',
    amount: '1000',
    depositRef: transfer,
  });
  expect(replay.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body.credited, 'the replayed deposit is not credited again').toBe(false);
  await page.reload();
  const after = await panelEqualsVenue(page, who, owner);
  expect(wireUnits(after.free)).toBe(toUnits('1000'));
  // The ledger posts nothing: INTAFACED holds none of it.
  expect(await ledgerOf(who)).toEqual(ledgerBefore);
});

test(`${J} #5 opens the spot desk: ticker, book, chart, tape, fees, trading mode and positions`, async ({ page }) => {
  // One signed-in client of the account's own for every service read below (the retries reuse it).
  const client = await api(account());
  await desk(page);
  await expect(page).toHaveURL(new RegExp(`${DESK}$`));
  await expect(page.getByTestId('dk-pair')).toHaveText('BTC/USDT');
  // The ticker's last price is the service's.
  await expect(async () => {
    const { body } = await client.get('/api/v1/ticker/BTC%2FUSDT');
    expect(shownUnits(await page.getByTestId('dk-last').innerText())).toBe(wireUnits(body.last));
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('[role=tab]', { hasText: 'Order book' })).toBeVisible();
  // The book draws real levels on both sides, each at a price the service's book holds.
  await expect(async () => {
    const { body } = await bestPrices();
    for (const [side, levels] of [
      ['bid', body.bids],
      ['ask', body.asks],
    ]) {
      const book = new Set(levels.map(([p]) => toUnits(p)));
      const price = page.locator(`[data-testid=dk-bk-row][data-side=${side}] [data-testid=dk-bk-price]`).first();
      expect(book.has(shownUnits(await price.innerText())), side).toBe(true);
    }
  }).toPass({ timeout: 30_000 });
  // The chart draws the service's candles: on 15m, its legend's close is the close of the service's newest 15m candle.
  // A fresh stack draws its first candle after the TEST market maker's first crossing trade (about a minute).
  await page.getByRole('group', { name: 'Chart intervals' }).getByRole('button', { name: '15m', exact: true }).click();
  await page.mouse.move(0, 0);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90_000 });
  await expect(async () => {
    const { body } = await client.get('/api/v1/ohlcv/BTC%2FUSDT?timeframe=15m&limit=3');
    expect(Array.isArray(body) && body.length > 0, JSON.stringify(body).slice(0, 200)).toBe(true);
    const close = page.getByTestId('pc-legend').locator('.pc-ohlc').nth(3).locator('b');
    expect(shownUnits(await close.innerText())).toBe(wireUnits(body.at(-1)[4]));
  }).toPass({ timeout: 60_000 });
  // The tape draws the service's prints: its newest row's price is among the service's recent trades.
  await page.locator('[role=tab]', { hasText: 'Last trades' }).click();
  await expect(async () => {
    const { body } = await client.get('/api/v1/trades/BTC%2FUSDT?limit=50');
    const prices = new Set(body.map((t) => toUnits(String(t.price))));
    const first = page.locator('[data-testid=dk-bk-row--tape] [data-testid=dk-bk-price]').first();
    expect(prices.has(shownUnits(await first.innerText()))).toBe(true);
  }).toPass({ timeout: 60_000 });
  // The fee line: this account's own maker and taker rates, as the service lists them for BTC/USDT, to the shown 0.01%.
  const { body: fees } = await client.get('/api/v1/account/fees');
  const rates = fees['BTC/USDT'];
  expect(rates, JSON.stringify(fees).slice(0, 300)).toBeTruthy();
  const line = page.getByRole('form', { name: 'Buy BTC' }).getByTestId('dk-fees-mine');
  await expect(line).toHaveText(/^Your rates: maker [−-]?[\d.]+% · taker [−-]?[\d.]+%$/);
  const [, maker, taker] = /maker ([−-]?[\d.]+)% · taker ([−-]?[\d.]+)%/.exec(await line.innerText());
  expect(toUnits(maker.replace('−', '-'))).toBe(asPercent(rates.maker));
  expect(toUnits(taker.replace('−', '-'))).toBe(asPercent(rates.taker));
  // The trading-mode line: cash spot, open, as the service lists the market (orderable, active, session open, OPEN).
  const { body: markets } = await client.get('/api/v1/markets?limit=500');
  const listing = markets.find((m) => m.symbol === 'BTC/USDT');
  expect(listing, 'BTC/USDT is listed').toBeTruthy();
  expect(listing).toMatchObject({ spot: true, active: true, orderable: true, sessionOpen: true });
  // A listing that names no lifecycle state is open by the desk's own rule (market.ts); one that names a state names OPEN.
  expect(listing.lifecycle?.state ?? 'OPEN').toBe('OPEN');
  const mode = page.getByTestId('dk-stats').locator('.dk-stat', { has: page.locator('.dk-stat-label', { hasText: /^Trading mode$/ }) });
  await expect(mode.locator('.dk-stat-value')).toHaveText('Cash spot · Open');
  // The positions tab reads that cash spot holds balances, not positions.
  await page.locator('[role=tab]', { hasText: /^Positions$/ }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
});

/** #6's buy, in the row's own words: TEST 0.1 BTC. */
const VENUE_BUY = '0.1';

/**
 * A TEST top-up of the person's venue account through the venue's own TEST deposit control (never our ledger): a
 * 0.1 BTC buy at the TEST venue's price (about 60,000) locks about 6,000 USDC, more than #4's 1,000.
 */
const VENUE_TOP_UP = '6000';

/** One tick above the venue's best bid: a buy there rests, and is first in line for a crossing sell. */
async function venueTopBid() {
  const { body } = await testVenue('/markets', {});
  const market = body.value.find((m) => m.symbol === VENUE_SPOT);
  expect(market, JSON.stringify(body).slice(0, 300)).toBeTruthy();
  const { bid, ask } = await venueBook(VENUE_SPOT);
  const price = bid + toUnits(market.tickSize);
  expect(price < ask, `no room between bid ${fromUnits(bid)} and ask ${fromUnits(ask)}`).toBe(true);
  return fromUnits(price);
}

test(`${J} #6 types a limit buy of TEST 0.1 BTC and reviews: the venue's lock, the venue's fee, our builder fee as its own line reading none, maker, time in force, the client id held for retry, no builder-fee approval`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = account();
  const { owner } = run.read();
  expect(owner, '#4 connected a wallet').toBeTruthy();
  const top = await testVenue('/test/deposit', {
    account: { venueId: await testVenueId(), owner, subAccount: null },
    asset: 'USDC',
    amount: VENUE_TOP_UP,
    depositRef: `test-top-up:${owner}:${VENUE_TOP_UP}`,
  });
  expect(top.status, JSON.stringify(top.body)).toBe(200);
  const { wallet } = await venueDesk(page);
  await panelEqualsVenue(page, who, owner);
  const price = await venueTopBid();
  const previews = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/preview') previews.push(r.postDataJSON());
  });
  const asked = wallet.requests.length;
  const review = await reviewLimit(page, 'buy', price, VENUE_BUY);
  // The figures are the venue's own preview of this order, line for line.
  expect(previews.length, 'the review asks the venue for its preview').toBeGreaterThan(0);
  const sent = previews.at(-1);
  expect(sent.owner).toBe(owner);
  expect(sent.intent).toMatchObject({ kind: 'place_order', symbol: VENUE_SPOT, side: 'buy', type: 'limit', timeInForce: 'GTC' });
  expect(toUnits(sent.intent.amount)).toBe(toUnits(VENUE_BUY));
  expect(toUnits(sent.intent.price)).toBe(toUnits(price));
  const { status, body: preview } = await (await api(who)).post('/api/v1/venue/preview', sent);
  expect(status, JSON.stringify(preview).slice(0, 300)).toBe(200);
  const lock = listed(review, /lock/i);
  await expect(lock).toContainText(preview.value.lock.asset);
  expect(shownUnits(await lock.innerText())).toBe(wireUnits(preview.value.lock.amount));
  const venueFee = listed(review, /venue.?s fee/i);
  expect(preview.value.venueFee.known).toBe(true);
  expect(shownUnits(await venueFee.innerText())).toBe(wireUnits(preview.value.venueFee.value.amount));
  // Our builder fee is its own line and reads none: the venue charges builder fees only in the quote asset.
  expect(preview.value.builderFee).toMatchObject({ known: true });
  expect(wireUnits(preview.value.builderFee.value.amount)).toBe(0n);
  await expect(listed(review, /builder fee/i)).toHaveText(/none/i);
  await expect(listed(review, 'Fee role')).toContainText('Maker');
  expect(preview.value.role).toBe('maker');
  await expect(listed(review, 'Time in force')).toHaveText('Good till cancelled');
  // The client id, held for retry: the same id after the review is closed and the same order reviewed again.
  const id = (await review.getByTestId('client-order-id').innerText()).trim();
  expect(id).toMatch(/^\S+$/);
  expect(sent.intent.clientOrderKey.endsWith(id), `${sent.intent.clientOrderKey} names ${id}`).toBe(true);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(reviewSheet(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(reviewSheet(page).getByTestId('client-order-id')).toHaveText(id);
  // No builder-fee approval is asked for an order that carries no builder fee, and the review signs nothing.
  await expect(page.getByText(/approve (our |the )?builder fee/i)).toHaveCount(0);
  expect(wallet.requests.length).toBe(asked);
  await reviewSheet(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await venueOpenOrders(who, owner)).toHaveLength(0);
  run.write({ venueBuy: { price, id } });
});

test(`${J} #7 confirms and signs: the order rests on the venue, shows Open, and the locked amount equals the venue's`, async ({ page }) => {
  const who = account();
  const { owner, venueBuy } = run.read();
  expect(venueBuy, '#6 reviewed the buy').toBeTruthy();
  const { wallet } = await venueDesk(page);
  const price = await venueTopBid();
  await reviewLimit(page, 'buy', price, VENUE_BUY);
  const asked = wallet.requests.length;
  await confirm(page, 'buy');
  // The wallet signs the order once.
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  // It rests on the venue.
  await expect.poll(async () => (await venueOpenOrders(who, owner)).length, { timeout: 20_000 }).toBe(1);
  const [order] = await venueOpenOrders(who, owner);
  expect(order).toMatchObject({ symbol: VENUE_SPOT, side: 'buy', type: 'limit', status: 'open' });
  expect(toUnits(order.amount)).toBe(toUnits(VENUE_BUY));
  expect(toUnits(order.price)).toBe(toUnits(price));
  // Open in the Open orders tab, with the venue's lock.
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(price).toLocaleString('en-US') });
  await expect(row).toContainText('Open');
  const heads = (await row.locator('xpath=ancestor::table//th').allInnerTexts()).map((h) => h.trim());
  const cells = await row.locator('td').allInnerTexts();
  const at = heads.findIndex((h) => /^(Locked|Held)$/.test(h));
  expect(at, heads.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(shownUnits(cells[at])).toBe(wireUnits(order.locked));
  // The venue's used balance is that lock, and the panel shows it.
  const venue = await panelEqualsVenue(page, who, owner);
  expect(wireUnits(venue.locked)).toBe(wireUnits(order.locked));
  run.write({ venueBuy: { price, clientOrderId: order.venueClientOrderId } });
});

test(`${J} #8 a TEST sell on the venue fills it: price, size, the venue's fee, no builder fee, maker, read from the venue; the venue balances move by the fill`, async ({
  page,
}) => {
  const who = account();
  const { owner, venueBuy } = run.read();
  expect(venueBuy?.clientOrderId, '#7 placed the buy').toBeTruthy();
  const before = { usdc: await venueBalance(who, owner, 'USDC'), btc: await venueBalance(who, owner, 'BTC') };
  const since = new Date(Date.now() - 1_000);
  // Another TEST trader on the venue sells into the bid.
  const seller = await otherVenueTrader({ BTC: VENUE_BUY });
  await seller.place({
    symbol: VENUE_SPOT,
    side: 'sell',
    amount: VENUE_BUY,
    price: venueBuy.price,
    timeInForce: 'IOC',
    key: `order:test-seller:${owner}:8`,
  });
  await expect.poll(async () => (await venueOrder(who, owner, venueBuy.clientOrderId))?.status, { timeout: 20_000 }).toBe('filled');
  const fills = (await venueFills(who, owner, since)).filter((f) => f.venueClientOrderId === venueBuy.clientOrderId);
  expect(fills.length).toBeGreaterThan(0);
  const filled = fills.reduce((s, f) => s + wireUnits(f.amount), 0n);
  expect(filled).toBe(toUnits(VENUE_BUY));
  for (const f of fills) {
    expect(f).toMatchObject({ side: 'buy', role: 'maker' });
    expect(wireUnits(f.price)).toBe(toUnits(venueBuy.price));
    expect(wireUnits(f.builderFee), 'no builder fee on a spot buy').toBe(0n);
  }
  // The desk shows the fill as the venue reports it.
  await venueDesk(page);
  await page
    .locator('[role=tab]', { hasText: /^(Order history|Trade history|Fills)$/ })
    .first()
    .click();
  const row = page
    .locator('tr', { hasText: Number(venueBuy.price).toLocaleString('en-US') })
    .filter({ hasText: /Filled|Buy/ })
    .first();
  await expect(row).toContainText('Maker');
  const heads = (await row.locator('xpath=ancestor::table//th').allInnerTexts()).map((h) => h.trim());
  const cells = await row.locator('td').allInnerTexts();
  const col = (name) => {
    const i = heads.findIndex((h) => name.test(h));
    expect(i, `${name} in ${heads.join(' | ')}`).toBeGreaterThanOrEqual(0);
    return cells[i];
  };
  expect(shownUnits(col(/^Price$/))).toBe(toUnits(venueBuy.price));
  expect(shownUnits(col(/^(Amount|Size|Filled)$/))).toBe(filled);
  expect(shownUnits(col(/venue.?s fee|^Fee$/i))).toBe(fills.reduce((s, f) => s + wireUnits(f.venueFee), 0n));
  expect(col(/builder fee/i)).toMatch(/none|^0(\.0+)?/i);
  // The venue balances moved by the fill: BTC up by what was bought (less a fee taken in BTC), USDC's lock spent.
  const after = { usdc: await venueBalance(who, owner, 'USDC'), btc: await venueBalance(who, owner, 'BTC') };
  const feeIn = (asset) => fills.filter((f) => f.feeAsset === asset).reduce((s, f) => s + wireUnits(f.venueFee), 0n);
  const cost = fills.reduce((s, f) => s + (wireUnits(f.price) * wireUnits(f.amount)) / toUnits('1'), 0n);
  expect(wireUnits(after.btc.total) - wireUnits(before.btc.total)).toBe(filled - feeIn('BTC'));
  expect(wireUnits(before.usdc.total) - wireUnits(after.usdc.total)).toBe(cost + feeIn('USDC'));
  expect(wireUnits(after.usdc.locked)).toBe(0n);
  await panelEqualsVenue(page, who, owner);
});

test(`${J} #9 places a market buy: it fills on the venue inside its slippage limit and nothing stays locked`, async ({ page }) => {
  const who = account();
  const { owner } = run.read();
  const since = new Date(Date.now() - 1_000);
  const { wallet } = await venueDesk(page);
  const prepares = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/prepare') prepares.push(r.postDataJSON());
  });
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const asked = wallet.requests.length;
  await confirm(page, 'buy');
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  const intent = prepares.at(-1)?.intent;
  expect(intent, 'the market buy was prepared for the venue').toMatchObject({
    kind: 'place_order',
    symbol: VENUE_SPOT,
    side: 'buy',
    type: 'market',
  });
  // The slippage limit is the worst price the order accepts; every fill is at or inside it.
  const limit = toUnits(intent.price);
  const filledAmount = async () => (await venueFills(who, owner, since)).reduce((s, f) => s + wireUnits(f.amount), 0n);
  await expect.poll(filledAmount, { timeout: 20_000 }).toBe(toUnits('0.001'));
  const fills = await venueFills(who, owner, since);
  for (const f of fills) expect(wireUnits(f.price) <= limit, `${f.price} within ${intent.price}`).toBe(true);
  expect(fills.reduce((s, f) => s + wireUnits(f.amount), 0n)).toBe(toUnits('0.001'));
  // Nothing stays locked on the venue.
  expect(await venueOpenOrders(who, owner)).toHaveLength(0);
  const usdc = await panelEqualsVenue(page, who, owner);
  expect(wireUnits(usdc.locked)).toBe(0n);
});

test(`${J} #10 rests a limit away from the market, cancels it, cancels it again: cancelled on the venue, the lock released, the repeat the same`, async ({
  page,
}) => {
  const who = account();
  const { owner } = run.read();
  const { wallet } = await venueDesk(page);
  const before = await venueBalance(who, owner, 'USDC');
  const { bid } = await venueBook(VENUE_SPOT);
  const away = fromUnits((bid / 2n / toUnits('1')) * toUnits('1'));
  await reviewLimit(page, 'buy', away, '0.001');
  await confirm(page, 'buy');
  await expect.poll(async () => (await venueOpenOrders(who, owner)).length, { timeout: 20_000 }).toBe(1);
  const [order] = await venueOpenOrders(who, owner);
  expect(toUnits(order.price)).toBe(toUnits(away));
  expect(wireUnits((await venueBalance(who, owner, 'USDC')).locked)).toBe(wireUnits(before.locked) + wireUnits(order.locked));
  // Cancels it from Open orders: the wallet signs the cancel, and the venue cancels the order.
  const prepared = [];
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/venue/prepare')
      prepared.push({ sent: r.request().postDataJSON(), answer: await r.json().catch(() => null) });
  });
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(away).toLocaleString('en-US') });
  const asked = wallet.requests.length;
  await row.getByRole('button', { name: /^Cancel/ }).click();
  await expect.poll(async () => (await venueOrder(who, owner, order.venueClientOrderId))?.status, { timeout: 20_000 }).toBe('cancelled');
  expect(wallet.requests.length).toBe(asked + 1);
  await expect(page.getByText(/cancelled/i).first()).toBeVisible();
  // The lock is released on the venue, and the panel shows it.
  expect(await venueOpenOrders(who, owner)).toHaveLength(0);
  expect(wireUnits((await panelEqualsVenue(page, who, owner)).locked)).toBe(wireUnits(before.locked));
  // Cancels it again: the same cancel, by the same business key, is the same action with the same outcome; the venue's
  // record and balances do not move.
  const first = prepared.find((p) => p.sent?.intent?.kind === 'cancel_order');
  expect(first, 'the cancel was prepared for the venue').toBeTruthy();
  const repeat = await (await api(who)).post('/api/v1/venue/prepare', first.sent);
  expect(repeat.status, JSON.stringify(repeat.body).slice(0, 300)).toBe(200);
  expect(repeat.body.prepared?.digest ?? repeat.body.digest).toBe(first.answer?.prepared?.digest ?? first.answer?.digest);
  expect((await venueOrder(who, owner, order.venueClientOrderId))?.status).toBe('cancelled');
  expect(wireUnits((await venueBalance(who, owner, 'USDC')).locked)).toBe(wireUnits(before.locked));
});

test(`${J} #11 reads the bought lot on Profit and loss, sells it, and reads the realised result`, async ({ page }) => {
  const who = account();
  const client = await api(who);
  /** Profit and loss as svc-tax works it out for this account (the room's own read), its BTC lots and its realised sum. */
  const lotBook = async () => {
    const { status, body } = await client.get('/api/tax/trpc/lotBook');
    expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
    const book = body.result.data;
    return { book, lots: book.lots.filter((lot) => String(lot.assetId).toUpperCase() === 'BTC') };
  };
  // What the buys cost: every BTC/USDT buy fill of this account (#8's limit buy and #9's market buy), in USDT.
  const { status: read, body: mine } = await client.get('/api/v1/account/trades?symbol=BTC%2FUSDT&limit=500');
  expect(read, JSON.stringify(mine).slice(0, 300)).toBe(200);
  const buys = mine.filter((t) => t.side === 'buy');
  expect(buys.length).toBeGreaterThan(0);
  expect(mine.filter((t) => t.side === 'sell')).toHaveLength(0);
  // Each buy's fee came out of the coins it received (BTC), so what left the account for the coins is its cost alone,
  // which is what svc-tax books as a lot's cost (the quote leg paid out of the order's hold).
  expect(
    buys.every((t) => t.fee?.currency === 'BTC'),
    JSON.stringify(buys.map((t) => t.fee)),
  ).toBe(true);
  const paid = buys.reduce((sum, t) => sum + wireUnits(t.cost), 0n);
  const btc = toUnits((await client.balances()).BTC?.total ?? '0');

  // After the buy: the bought lots are open at their cost. svc-tax holds them as bought (trade), nothing of them sold,
  // still held, together costing what the buys paid and holding the BTC the ledger holds.
  const before = await lotBook();
  expect(before.lots.length).toBeGreaterThan(0);
  for (const lot of before.lots) {
    expect(lot, JSON.stringify(lot)).toMatchObject({ source: 'trade' });
    expect(wireUnits(lot.remaining), JSON.stringify(lot)).toBe(wireUnits(lot.qty));
    expect(lot.daysHeld, JSON.stringify(lot)).not.toBeNull();
    expect(lot.costUsd, JSON.stringify(lot)).not.toBeNull();
  }
  expect(before.lots.reduce((sum, lot) => sum + wireUnits(lot.costUsd), 0n)).toBe(paid);
  expect(before.lots.reduce((sum, lot) => sum + wireUnits(lot.remaining), 0n)).toBe(btc);
  // The room shows each of those lots: what is left, its cost to the shown cent, and a number of days held, not Sold.
  await signIn(page, who);
  await page.goto('/money/pnl?asset=BTC');
  const main = page.locator('main').first();
  const lots = main.locator('tr[data-lot]');
  await expect(lots.first()).toBeVisible({ timeout: 30_000 });
  await expect(lots).toHaveCount(before.lots.length);
  for (const lot of before.lots) {
    const row = main.locator(`tr[data-lot="${lot.id}"]`);
    await expect(row).toHaveCount(1);
    expect(shownUnits(await row.locator('td[data-col=left]').innerText())).toBe(wireUnits(lot.remaining));
    await expect(row.locator('td[data-col=cost]')).toHaveText(new RegExp(`^${DOLLARS}$`));
    expect(shownUnits(await row.locator('td[data-col=cost]').innerText())).toBe(asShownUsd(lot.costUsd));
    await expect(row.locator('td[data-col=days]')).toHaveText(/^\d+$/);
  }

  // Sells the coins on the desk.
  await page.goto(DESK);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page
    .getByRole('textbox', { name: 'Price' })
    .nth(1)
    .fill(await underBid());
  // The sell side's Max: every whole step of the BTC held.
  await previewed(page, () => page.getByRole('button', { name: 'Max' }).last().click());
  await page.getByRole('button', { name: 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'sell');
  // What is left is below the market's amount step (0.00001 BTC).
  await expect.poll(async () => toUnits((await client.balances()).BTC?.total ?? '0'), { timeout: 20_000 }).toBeLessThan(toUnits('0.00001'));

  // After the sale: the realised result shows, as svc-tax works it out, labelled as an indicator.
  // svc-tax books the sale's fills one by one, so its figure is read once every fill is in: a realised sum, and BTC lots
  // whose remaining amount is what the ledger still holds.
  const left = toUnits((await client.balances()).BTC?.total ?? '0');
  let after;
  await expect
    .poll(
      async () => {
        after = await lotBook();
        return after.book.realizedUsd !== null && after.lots.reduce((sum, lot) => sum + wireUnits(lot.remaining), 0n) === left;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.goto('/money/pnl');
  await expect(main.getByTestId('money-label').filter({ hasText: 'Realised' }).first()).toBeVisible();
  const realised = main.locator('[data-testid=money-total][data-figure=realised]');
  // A signed dollar result: the sale and its fees leave a non-zero result, which can be under $1 ("−$0.8094" in run 1123).
  await expect(realised).toHaveText(new RegExp(`^[+−]${DOLLARS}$`));
  expect(shownUnits(await realised.innerText())).toBe(asShownUsd(after.book.realizedUsd));
  expect(after.book.indicator).toBe('indicator_not_tax_advice');
  await expect(main.locator('[data-testid=money-note][data-indicator=true]')).toHaveText(
    'This is an indicator worked out from your own trades. It is not a tax form.',
  );
});

/** #12's TEST wallet on TEST Base, where the stack connects no custody signer (no payout rail), saved in the address book. */
const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code after the last one this run used, so no code is used twice. */
async function freshCode() {
  const state = run.read();
  const { totp } = await totpLib();
  const { code, step } = await nextCode(totp, state.secret, state.step);
  run.write({ step });
  return code;
}

/** Answers the "Confirm it's you" dialog with the next authenticator code. */
async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

test(`${J} #12 withdraws TEST 10 USDC from the venue to the wallet: the wallet signs, pending then done with its fees or "not known"; a session not stepped up is refused before the wallet is asked`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const who = account();
  const { owner } = run.read();
  // A second factor to step up with, from Security.
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  const before = await venueBalance(who, owner, 'USDC');
  expect(wireUnits(before.free) >= toUnits('10')).toBe(true);
  // A session that has not stepped up is refused before the wallet is asked: nothing to sign, nothing withdrawn.
  const { wallet, panel } = await venueDesk(page);
  const asked = wallet.requests.length;
  await panel.getByRole('button', { name: /^Withdraw/ }).click();
  const form = page.getByRole('dialog', { name: /withdraw/i });
  await form.getByRole('textbox', { name: /^Amount/ }).fill('10');
  await expect(form).toContainText(`${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`);
  await form
    .getByRole('button', { name: /withdraw|sign|confirm/i })
    .last()
    .click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(stepUp).toBeVisible();
  await page.keyboard.press('Escape');
  expect(wallet.requests.length, 'the wallet is not asked before the step-up').toBe(asked);
  const unstepped = await (
    await api(who)
  ).post('/api/v1/venue/prepare', {
    owner,
    signer: { role: 'owner', address: owner },
    intent: { kind: 'withdraw', asset: 'USDC', amount: '10', destination: owner, withdrawalKey: `withdraw:${owner}:${J}-12-unstepped` },
  });
  expect(unstepped.status, JSON.stringify(unstepped.body).slice(0, 300)).toBe(403);
  expect(wireUnits((await venueBalance(who, owner, 'USDC')).free)).toBe(wireUnits(before.free));
  // Steps up, and the wallet signs the withdrawal.
  await form
    .getByRole('button', { name: /withdraw|sign|confirm/i })
    .last()
    .click();
  await confirmItsMe(page);
  await expect.poll(() => wallet.requests.length, { timeout: 20_000 }).toBe(asked + 1);
  expect(wallet.requests.at(-1).method).toBe('eth_signTypedData_v4');
  // The venue's withdrawal shows pending, then done, with its fee or "not known".
  const shown = page.getByTestId('venue-withdrawal').first();
  await expect(shown).toContainText(/pending/i, { timeout: 20_000 });
  const fee = shown
    .locator('div', { has: page.locator('dt', { hasText: /fee/i }) })
    .locator('dd')
    .first();
  await expect(fee).toHaveText(/not known|\d/);
  const settled = await testVenue('/test/settle-withdrawals', {});
  expect(settled.status).toBe(200);
  await expect(shown).toContainText(/done/i, { timeout: 30_000 });
  const nonce = await shown.getAttribute('data-nonce');
  expect(nonce, 'the withdrawal names the venue nonce it was signed with').toBeTruthy();
  const record = (await venueRead(who, `withdrawals/${encodeURIComponent(nonce)}`, owner)).value;
  expect(record).toMatchObject({ asset: 'USDC', status: 'done', destination: owner });
  expect(wireUnits(record.amount)).toBe(toUnits('10'));
  if (record.fee.known) expect(shownUnits(await fee.innerText())).toBe(wireUnits(record.fee.value));
  else await expect(fee).toHaveText(/not known/i);
  const after = await venueBalance(who, owner, 'USDC');
  expect(wireUnits(before.total) - wireUnits(after.total)).toBe(toUnits('10') + (record.fee.known ? wireUnits(record.fee.value) : 0n));
  await panelEqualsVenue(page, who, owner);
});
