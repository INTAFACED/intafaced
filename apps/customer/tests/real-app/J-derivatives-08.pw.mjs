// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { ledgerUntouched, ledgerView, signedOnVenue, venueAt, venueNow, walletOwner } from './venue-door.mjs';
import { openVenueDesk, venueForThisFile } from './venue.mjs';

// J-derivatives-08, "I see the funding rate and what I paid or received", on the person's own venue account (the launch
// money model: the venue charges or pays funding, the app shows each payment as the venue reports it, our ledger holds
// none of it), in the running app against the stack's TEST venue simulator (packages/venue-sim). One test per step,
// titled "J-derivatives-08 #<n>", run in order on one TEST account.
//
// The Starts line, made at the start of #1 straight on the TEST venue with the person's own key: a TEST isolated long of
// 2 XFND-PERP at 5x, taken from the TEST makers' ladder. XFND-PERP is the TEST perpetual whose TEST venue builds its
// funding rate from its mark and index and settles it; only this journey trades it, and only this journey closes its
// periods (`/test/settle-funding`, the TEST venue closing a period early on its own clock). Every figure the page shows
// is checked against the TEST venue's own record, read straight from the venue, never through our door; the ledger is
// read before and after to show it posts nothing. Every figure is TEST.
const J = 'J-derivatives-08';
const DESK = '/trade/futures';
const SYMBOL = 'XFND-PERP';
const FUNDS = '1000';
const SIZE = '2';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

// ── the TEST venue, read and changed directly ──

const accountOf = (venue, owner) => ({ venueId: venue.id, owner, subAccount: null });
const record = async (venue, owner, path, extra = {}) => (await venueAt(path, { account: accountOf(venue, owner), ...extra })).value;
const positionOn = async (venue, owner) => (await record(venue, owner, '/positions')).find((p) => p.symbol === SYMBOL);
const marketOn = async () => (await venueAt('/markets', {})).value.find((m) => m.symbol === SYMBOL);
/** The venue's own funding payments on the person's account since the journey's start, oldest first. */
const paymentsOn = async (venue, s) => record(venue, s.owner, '/funding-payments', { since: s.since });
/** The TEST venue's mark and index back where the journey found them, its funding and index published. */
async function marketAtStart() {
  await venueAt('/test/funding-published', { symbol: SYMBOL, published: true });
  await venueAt('/test/index-published', { symbol: SYMBOL, published: true });
  await venueAt('/test/set-index', { symbol: SYMBOL, price: '100' });
  await venueAt('/test/set-mark', { symbol: SYMBOL, price: '100' });
}

// ── the person and the page ──

const state = () => walletOwner(run, `${J} #1`);
const sum = (amounts) => fromUnits(amounts.reduce((total, a) => total + toUnits(a), 0n));
const unsigned = (a) => (a.startsWith('-') ? a.slice(1) : a);
/** A fraction as the page draws it in percent: times 100, to its last digit. */
const percent = (fraction) => `${fromUnits(toUnits(fraction) * 100n)}%`;

/** Opens the futures desk as the person, picks XFND-PERP and opens the blotter's Funding tab. */
async function fundingTab(page, s) {
  const venue = await venueNow();
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  const pick = page.getByTestId('venue-contract-list').getByRole('button', { name: `${SYMBOL} · ${venue.name}`, exact: true });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'Funding', exact: true }).click();
  const tab = page.getByTestId('venue-funding-tab');
  await expect(tab).toBeVisible({ timeout: 20_000 });
  return tab;
}
const line = (tab, name) => tab.getByTestId('venue-funding-now').locator(`[data-line="${name}"]`);

/** TEST setup, not a step (the Starts line): a verified account, its wallet, TEST USDC on the venue and an isolated long. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    await marketAtStart();
    const account = await signUp(page, 'jd8');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const venue = await venueNow();
    await venueAt('/test/deposit', {
      account: accountOf(venue, owner),
      asset: 'USDC',
      amount: FUNDS,
      depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
    });
    const tag = randomBytes(4).toString('hex');
    await signedOnVenue(venue, key, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' });
    await signedOnVenue(venue, key, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: SIZE,
      price: '100.5',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:jd8:${tag}:open`,
      builderFee: null,
    });
    const p = await positionOn(venue, owner);
    expect(p).toMatchObject({ side: 'long', marginMode: 'isolated', size: SIZE });
    run.reset({
      account,
      walletKey,
      tag,
      since: new Date(Date.now() - 60_000).toISOString(),
      marginAtStart: p.margin,
      ledger: await ledgerView(account),
    });
  } finally {
    await page.close();
  }
}

test(`${J} #1 reads the contract strip and Funding tab: current rate, countdown, premium, interest component, cap and the mark and index it was built from`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const tab = await fundingTab(page, s);
  const m = await marketOn();
  expect(m.funding.known).toBe(true);
  const f = m.funding.value;
  expect(f.inputs.known).toBe(true);
  const inputs = f.inputs.value;
  // The strip shows the venue's rate, every interval, and its next period.
  const strip = page.getByTestId('venue-contract-strip');
  await expect(strip.getByRole('heading')).toContainText(SYMBOL);
  await expect(strip.getByTestId('venue-funding')).toHaveAttribute('data-rate', f.rate);
  await expect(strip.getByTestId('venue-funding-next')).toHaveAttribute('dateTime', f.nextFundingAt);

  // The Funding tab: each figure the venue's own, digit for digit.
  await expect(line(tab, 'rate')).toHaveAttribute('data-value', f.rate);
  await expect(line(tab, 'rate')).toHaveText(`${percent(f.rate)} every 1h`);
  // Mark 100, index 100: no premium, so the rate is the venue's interest component alone, inside its cap.
  expect(inputs).toMatchObject({ premium: '0', markPrice: '100', indexPrice: '100' });
  expect(f.rate).toBe(fromUnits(toUnits(inputs.premium) + toUnits(inputs.interestRate)));
  expect(toUnits(f.rate)).toBeLessThanOrEqual(toUnits(inputs.rateCap));
  await expect(line(tab, 'premium')).toHaveAttribute('data-value', inputs.premium);
  await expect(line(tab, 'interest')).toHaveAttribute('data-value', inputs.interestRate);
  await expect(line(tab, 'interest')).toHaveText(percent(inputs.interestRate));
  await expect(line(tab, 'cap')).toHaveAttribute('data-value', inputs.rateCap);
  await expect(line(tab, 'cap')).toHaveText(`${percent(inputs.rateCap)} either way`);
  await expect(line(tab, 'mark')).toHaveText(inputs.markPrice);
  await expect(line(tab, 'index')).toHaveText(inputs.indexPrice);
  await expect(line(tab, 'rule')).toHaveText(inputs.rule.value);
  // The countdown is to the venue's next period, in hours and minutes.
  await expect(line(tab, 'countdown').locator('time')).toHaveAttribute('dateTime', f.nextFundingAt);
  const left = Date.parse(f.nextFundingAt) - Date.now();
  expect(left).toBeGreaterThan(0);
  await expect(line(tab, 'countdown')).toHaveText(/^in (\d+h )?\d+m$/);
  await expect(tab.getByTestId('venue-test').first()).toHaveText('TEST');
  await ledgerUntouched(s);
});

test(`${J} #2 the venue publishes no rate for the period: "not published by this venue"; nothing is shown as paid or charged`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const margin = (await positionOn(venue, s.owner)).margin;
  await venueAt('/test/funding-published', { symbol: SYMBOL, published: false });
  try {
    expect((await marketOn()).funding).toEqual({ known: false });
    const tab = await fundingTab(page, s);
    await expect(page.getByTestId('venue-contract-strip').getByTestId('venue-funding')).toHaveText('not published by this venue');
    await expect(tab.getByTestId('venue-funding-unpublished')).toHaveText(
      'Funding rate: not published by this venue. Nothing is shown as paid or charged.',
    );
    await expect(line(tab, 'rate')).toHaveCount(0);
    // The venue closes the period with no rate: it books nothing, and the page shows nothing paid or charged.
    const closed = await venueAt('/test/settle-funding', { symbol: SYMBOL });
    expect(closed).toMatchObject({ rate: null, payments: 0 });
    expect(await paymentsOn(venue, s)).toEqual([]);
    expect((await positionOn(venue, s.owner)).margin).toBe(margin);
    await expect(tab.getByTestId('venue-funding-none')).toHaveText('No funding has been paid or charged on your positions.', {
      timeout: 20_000,
    });
    await expect(tab.locator('tr[data-payment]')).toHaveCount(0);
    await expect(tab.getByTestId('venue-funding-statement')).toHaveCount(0);
  } finally {
    await venueAt('/test/funding-published', { symbol: SYMBOL, published: true });
  }
  await ledgerUntouched(s);
});

test(`${J} #3 a period closes: one payment per position in the payments list, as the venue reports it, with the venue's period`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const tab = await fundingTab(page, s);
  const before = await positionOn(venue, s.owner);
  const closed = await venueAt('/test/settle-funding', { symbol: SYMBOL });
  expect(closed.rate).not.toBeNull();
  const payments = await paymentsOn(venue, s);
  // One payment on the person's one position, for the period the venue closed.
  expect(payments).toHaveLength(1);
  const [p] = payments;
  expect(p).toMatchObject({ symbol: SYMBOL, side: 'long', size: SIZE, rate: closed.rate, asset: 'USDC', periodAt: closed.periodAt });
  // The venue booked it on the position's margin.
  expect((await positionOn(venue, s.owner)).margin).toBe(fromUnits(toUnits(before.margin) + toUnits(p.amount)));

  const rows = tab.locator('tr[data-payment]');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  const row = rows.first();
  await expect(row).toHaveAttribute('data-payment', p.paymentId);
  await expect(row).toHaveAttribute('data-period', p.periodAt);
  await expect(row.locator('[data-cell="period"] time')).toHaveAttribute('dateTime', p.periodAt);
  await expect(row.locator('[data-cell="position"]')).toHaveText(`Long ${p.size}`);
  await expect(row.locator('[data-cell="mark"]')).toHaveText(p.markPrice);
  await expect(row.locator('[data-cell="rate"]')).toHaveText(percent(p.rate));
  // A positive rate: the long paid it.
  expect(toUnits(p.rate)).toBeGreaterThan(0n);
  await expect(row.locator('[data-cell="direction"]')).toHaveText('Paid');
  await expect(row.locator('[data-cell="amount"]')).toHaveText(`${unsigned(p.amount)} ${p.asset}`);
  await expect(row).toHaveAttribute('data-amount', p.amount);
  await ledgerUntouched(s);
});

test(`${J} #4 checks the legs: what the venue charged or paid on each position, the payer flipping on a negative rate; we don't recompute the market's net`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  // TEST: the index moves above the mark, so the venue's premium, and its rate, turn negative.
  await venueAt('/test/set-index', { symbol: SYMBOL, price: '100.5' });
  try {
    const m = await marketOn();
    expect(toUnits(m.funding.value.rate)).toBeLessThan(0n);
    const tab = await fundingTab(page, s);
    await expect(line(tab, 'rate')).toHaveAttribute('data-value', m.funding.value.rate, { timeout: 20_000 });
    await expect(line(tab, 'premium')).toHaveAttribute('data-value', m.funding.value.inputs.value.premium);
    await expect(line(tab, 'index')).toHaveText('100.5');
    const closed = await venueAt('/test/settle-funding', { symbol: SYMBOL });
    expect(closed.rate).toBe(m.funding.value.rate);
    const payments = await paymentsOn(venue, s);
    expect(payments).toHaveLength(2);
    const flipped = payments.find((x) => x.periodAt === closed.periodAt);
    // The long received it this time: the venue's own amount, positive.
    expect(toUnits(flipped.amount)).toBeGreaterThan(0n);
    const rows = tab.locator('tr[data-payment]');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    // Each leg as the venue booked it, digit for digit, with who paid.
    for (const x of payments) {
      const row = tab.locator(`tr[data-payment="${x.paymentId}"]`);
      await expect(row.locator('[data-cell="rate"]')).toHaveText(percent(x.rate));
      await expect(row.locator('[data-cell="amount"]')).toHaveText(`${unsigned(x.amount)} ${x.asset}`);
      await expect(row.locator('[data-cell="direction"]')).toHaveText(toUnits(x.amount) < 0n ? 'Paid' : 'Received');
    }
    await expect(tab.locator(`tr[data-payment="${flipped.paymentId}"] [data-cell="direction"]`)).toHaveText('Received');
    // Nothing on the page is a market-wide net of ours: only the person's own legs, as the venue reports them.
    await expect(tab).not.toContainText(/\bnet\b|open interest/i);
  } finally {
    await venueAt('/test/set-index', { symbol: SYMBOL, price: '100' });
  }
  await ledgerUntouched(s);
});

test(`${J} #5 opens the funding statement: venue funding by position and period, summing to what the venue reports; the ledger holds none of it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const tab = await fundingTab(page, s);
  const payments = await paymentsOn(venue, s);
  expect(payments).toHaveLength(2);
  const statement = tab.getByTestId('venue-funding-statement');
  await expect(statement).toBeVisible({ timeout: 20_000 });
  await expect(statement).toContainText(`Venue funding by position and period, as ${venue.name} reports it. Our ledger holds none of it.`);
  // By position (the one long) and period: one line per period the venue closed, each its own amount.
  const position = `${SYMBOL}:long`;
  const lines = statement.locator(`tr[data-position="${position}"]`);
  await expect(lines).toHaveCount(2);
  for (const x of payments) {
    const l = statement.locator(`tr[data-position="${position}"][data-statement-period="${x.periodAt}"]`);
    await expect(l.locator('[data-cell="amount"]')).toHaveText(`${x.amount} ${x.asset}`);
  }
  // Summing to what the venue reports: its payments, and the margin it moved by them since the position opened.
  const total = sum(payments.map((x) => x.amount));
  await expect(statement.locator(`tr[data-position-total="${position}"] [data-cell="amount"]`)).toHaveText(`${total} USDC`);
  await expect(statement.getByTestId('venue-funding-total')).toHaveAttribute('data-value', total);
  const margin = (await positionOn(venue, s.owner)).margin;
  expect(fromUnits(toUnits(margin) - toUnits(s.marginAtStart))).toBe(total);
  // The ledger holds none of it.
  await ledgerUntouched(s);
});

test(`${J} #6 reads public funding, index and mark history: rate rows with premium and annualised rate, index and mark series; an unpublished index returns null with its reason`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  // Signed out: these are public market data.
  const pub = async (path) => {
    const res = await fetch(`${EDGE}${path}`);
    expect(res.status, path).toBe(200);
    return res.json();
  };
  const since = encodeURIComponent(s.since);
  const history = await pub(`/api/v1/venue/funding-history?base=XFND&since=${since}`);
  const own = (await venueAt('/funding-history', { symbol: SYMBOL, since: s.since })).value;
  expect(history).toMatchObject({ symbol: SYMBOL, intervalSeconds: 3600, test: true });
  // The rows are the venue's own periods (#3 and #4 closed two with a rate), each with its premium and the rate a year.
  expect(history.value.map((r) => [r.fundingAt, r.rate, r.premium])).toEqual(own.map((r) => [r.fundingAt, r.rate, r.premium]));
  expect(history.value.length).toBeGreaterThanOrEqual(2);
  for (const r of history.value) expect(r.annualisedRate).toBe(fromUnits(toUnits(r.rate) * 8760n));

  const all = encodeURIComponent('1970-01-01T00:00:00.000Z');
  for (const kind of ['mark', 'index']) {
    const series = await pub(`/api/v1/venue/price-history?symbol=${SYMBOL}&kind=${kind}&since=${all}`);
    const venueOwn = (await venueAt('/price-history', { symbol: SYMBOL, kind, since: '1970-01-01T00:00:00.000Z' })).value;
    expect(venueOwn.known).toBe(true);
    expect(series).toMatchObject({ symbol: SYMBOL, kind, reason: null, test: true });
    expect(series.series).toEqual(venueOwn.value);
    expect(series.series.length).toBeGreaterThan(0);
  }
  // #4 moved the index to 100.5 and back: the series shows both.
  const index = await pub(`/api/v1/venue/price-history?symbol=${SYMBOL}&kind=index&since=${since}`);
  expect(index.series.map((x) => x.price)).toEqual(expect.arrayContaining(['100.5', '100']));

  // An index the venue does not publish: null, with the venue's reason, never a series of ours.
  const venue = await venueNow();
  await venueAt('/test/index-published', { symbol: SYMBOL, published: false });
  try {
    const unpublished = `/api/v1/venue/price-history?symbol=${SYMBOL}&kind=index&since=${all}`;
    const none = await pub(unpublished);
    expect(none).toMatchObject({ symbol: SYMBOL, kind: 'index', series: null, reason: `${venue.name} publishes no index for ${SYMBOL}` });
    // The same public answer as a reader opens it, signed out, in the browser: null, with the venue's reason.
    const opened = await page.goto(`${EDGE}${unpublished}`);
    expect(opened.status()).toBe(200);
    expect(JSON.parse(await page.locator('body').innerText())).toMatchObject({ series: null, reason: none.reason });
    await expect(page.locator('body')).toContainText(`${venue.name} publishes no index for ${SYMBOL}`);
  } finally {
    await venueAt('/test/index-published', { symbol: SYMBOL, published: true });
  }
  await ledgerUntouched(s);
});
