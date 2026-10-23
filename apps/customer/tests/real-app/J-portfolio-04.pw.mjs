import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, bestPrices, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, reviewLimit, signIn } from './desk.mjs';

// J-portfolio-04, in the running app (docs/roadmap/journeys.json): "I control how my cost basis is worked out". One test
// per step, titled "J-portfolio-04 #<n>", run in order on one TEST account funded with TEST 1000 USDT. Every figure is
// checked against a hand count from the ledger balances and the public candles, never against the lot book itself.
const J = 'J-portfolio-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units) {
  const abs = units < 0n ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  return `${units < 0n && rounded !== 0n ? '−' : ''}$${(rounded / 10n ** BigInt(places)).toLocaleString('en-US')}.${frac}`;
}

const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');
const priceAt = (decimal, percent) => fromUnits(((toUnits(decimal) * BigInt(percent)) / 100n / 10n ** 16n) * 10n ** 16n);

/** One limit buy over the best ask: it takes the maker's asks and fills at once. Returns what it cost and what arrived. */
async function buyNow(page, who, amount) {
  const before = await (await api(who)).balances();
  await page.goto(deskPath('BTC/USDT'));
  const { ask } = await bestPrices('BTC/USDT');
  await reviewLimit(page, 'buy', priceAt(ask, 101), amount);
  await confirm(page, 'buy');
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
  const after = await (await api(who)).balances();
  return { cost: total(before, 'USDT') - total(after, 'USDT'), qty: total(after, 'BTC') - total(before, 'BTC') };
}

async function lotsPage(page, asset = 'BTC') {
  await page.goto(`/money/pnl?asset=${asset}`);
  const lots = page.getByRole('region', { name: 'Lots' });
  await expect(lots).toBeVisible();
  return lots;
}

test(`${J} #1 opens the lots list for BTC: each lot with acquired date, quantity, basis and source`, async ({ page }) => {
  const who = await fundedTrader(page, 'pf4', '1000');
  run.reset({ account: who });
  await signIn(page, who);
  // Two TEST buys a little apart, so the maker's quotes (and so the prices) move between them.
  const first = await buyNow(page, who, '0.002');
  await page.waitForTimeout(6_000);
  const second = await buyNow(page, who, '0.003');
  run.write({ buys: [first, second].map((b) => ({ cost: fromUnits(b.cost), qty: fromUnits(b.qty) })) });

  const lots = await lotsPage(page);
  const rows = lots.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  for (const [i, b] of [first, second].entries()) {
    const row = rows.nth(i);
    await expect(row.locator('[data-col="source"]')).toHaveText('Bought');
    await expect(row.locator('[data-col="qty"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="left"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="cost"]')).toHaveText(usd(b.cost));
    await expect(row.locator('[data-col="days"]')).toHaveText('0');
    // The acquired column is a date and time, oldest first.
    await expect(row.locator('th')).not.toHaveText('');
  }
  // The term rule is not published, so only days held is shown and the screen says so.
  await expect(lots).toContainText('Short or long term is not shown');
});

test(`${J} #3 reads a deposit: valued at the time it arrived, with the price source named, and no cost until one is entered`, async ({
  page,
}) => {
  const who = account();
  // TEST 0.004 BTC arrives by deposit through the real ledger, at a moment the BTC/USDT book has traded.
  const before = Date.now();
  expect(fund(who.email, 'BTC', '0.004').tx).toBeTruthy();
  const after = Date.now();
  await signIn(page, who);
  const lots = await lotsPage(page);
  const row = lots.locator('tbody tr[data-source="deposit"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-col="qty"]')).toHaveText('0.004');
  // The TEST owner policy is "customer": a deposit's cost is unknown until the customer gives one, never zero.
  await expect(row.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect(row.locator('[data-col="price-source"]')).toContainText('at the BTC/USDT price, one-minute candle from');

  // Hand count from the public one-minute candles: 0.004 times the close of the last candle that started at or before the
  // arrival. The arrival is posted between `before` and `after`, so the price is the one for either moment.
  const res = await fetch(
    `${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&since=${Math.floor(before / 60_000) * 60_000 - 3_600_000}&limit=720`,
    { headers: { origin: ORIGIN } },
  );
  expect(res.status).toBe(200);
  const candles = await res.json();
  const lastAt = (t) => candles.filter((c) => c[0] <= t).at(-1)?.[4];
  const values = [...new Set([lastAt(before), lastAt(after)].filter(Boolean))].map((close) =>
    usd((toUnits('0.004') * toUnits(close) + ONE / 2n) / ONE),
  );
  expect(values.length).toBeGreaterThan(0);
  const shown = (await row.locator('[data-col="arrival"]').innerText()).split('\n')[0].trim();
  expect(values).toContain(shown.split(' ')[0]);

  // The bought lots keep their cost, and the asset's open cost is now unknown on Open positions: one lot has no cost.
  await expect(lots.locator('tbody tr[data-source="trade"] [data-col="cost"]').first()).not.toHaveText('Cost unknown');
  await expect(page.locator('tr[data-asset="BTC"] [data-col="cost"]')).toHaveText('Not known');
});
