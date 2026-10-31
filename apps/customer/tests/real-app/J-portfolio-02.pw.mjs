import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api, bestPrices, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';

// J-portfolio-02, in the running app (docs/roadmap/journeys.json): "I see what my trades made or lost". One test per
// step, titled "J-portfolio-02 #<n>", run in order on one TEST account funded with TEST 500 USDT. Every figure the
// screen shows is checked against a hand count from the ledger balances (what left and what arrived), never against
// the lot book the screen itself reads.
const J = 'J-portfolio-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units, signed = false) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const whole = (rounded / 10n ** BigInt(places)).toLocaleString('en-US');
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${whole}.${frac}`;
}

const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');
/** `decimal` moved by `percent`, cut to `places` decimals (BTC/USDT steps in cents; ETH/BTC in 0.00001 BTC). */
const priceAt = (decimal, percent, places = 2) => {
  const step = 10n ** BigInt(18 - places);
  return fromUnits(((toUnits(decimal) * BigInt(percent)) / 100n / step) * step);
};

async function pnl(page, query = '') {
  await page.goto(`/money/pnl${query}`);
  const main = page.locator('main').first();
  await expect(main.getByRole('heading', { name: 'Profit and loss', level: 1 })).toBeVisible();
  return main;
}

/** Waits until no order of `who` holds anything: every order this journey sends crosses the book and fills at once. */
async function settled(who) {
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
}

test(`${J} #1 buys TEST BTC on the desk, then reads the open lot: quantity, average price and cost with the fee inside`, async ({
  page,
}) => {
  const who = await fundedTrader(page, 'pf2', '2000');
  run.reset({ account: who });
  await signIn(page, who);
  await page.goto(deskPath('BTC/USDT'));
  // A limit buy 1% over the best ask takes the maker's asks at their own prices; the rest of the hold comes back.
  const { ask } = await bestPrices('BTC/USDT');
  // 0.01 BTC less the 0.10% taker fee taken in BTC is 0.00999 BTC: whole steps of 0.00001, so #3 can sell all of it.
  await reviewLimit(page, 'buy', priceAt(ask, 101), '0.01');
  await confirm(page, 'buy');
  await settled(who);
  const after = await (await api(who)).balances();
  const qty = total(after, 'BTC');
  const cost = toUnits('2000') - total(after, 'USDT');
  expect(qty).toBeGreaterThan(0n);
  expect(cost).toBeGreaterThan(0n);
  run.write({ qty: fromUnits(qty), cost: fromUnits(cost) });

  const main = await pnl(page);
  const row = main.locator('tr[data-asset="BTC"]');
  await expect(row).toBeVisible();
  await expect(row.locator('td').first()).toHaveText(fromUnits(qty));
  await expect(row.locator('[data-col="cost"]')).toHaveText(usd(cost));
  // The fee came out of the coins received, so the price per coin is what was paid over what arrived.
  await expect(row.locator('[data-col="average"]')).toHaveText(usd((cost * ONE) / qty));
  await expect(main).toContainText('The fee on a buy is inside the cost');
});

test(`${J} #2 reads unrealised profit and loss for BTC, as an amount and a percent of the cost`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const main = await pnl(page);
  const row = main.locator('tr[data-asset="BTC"]');
  const cell = row.locator('[data-col="unrealised"]');
  await expect(cell).toHaveText(/^[+−]?\$[\d,]+\.\d{2,4} \([+−]?[\d.]+%\)$/);
  // Worth now less cost, as shown (each figure is rounded to the cent on screen, so the check allows one cent).
  const dollars = (text) => Number(text.replace(/[^\d.−-]/g, '').replace('−', '-'));
  // The row refreshes live, so its worth, cost and unrealised cell are read in one go, from one render.
  const [worthText, costText, cellText] = await row.evaluate((tr) => [
    tr.querySelectorAll('td')[3].innerText,
    tr.querySelector('[data-col="cost"]').innerText,
    tr.querySelector('[data-col="unrealised"]').innerText,
  ]);
  const worth = dollars(worthText);
  const cost = dollars(costText);
  const unrealised = dollars(cellText.split(' (')[0]);
  expect(Math.abs(worth - cost - unrealised)).toBeLessThanOrEqual(0.011);
  // The percent is the unrealised amount over the cost. Allowed: half a unit in the percent's last shown place, plus what
  // the two cent-rounded figures can move it (a cent on each over the cost).
  const percentText = cellText.match(/\(([+−]?)([\d,.]+)%\)$/);
  expect(percentText, `a percent in ${cellText}`).not.toBeNull();
  const digits = percentText[2].replace(/,/g, '');
  const percent = Number(digits) * (percentText[1] === '−' ? -1 : 1);
  const places = (digits.split('.')[1] ?? '').length;
  expect(cost).toBeGreaterThan(0);
  expect(Math.abs(percent - (unrealised / cost) * 100)).toBeLessThanOrEqual(0.5 * 10 ** -places + (0.02 / cost) * 100);
  // Worth now is the coins at today's book: inside the best bid and ask for the quantity held.
  const { bid, ask } = await bestPrices('BTC/USDT');
  const qty = Number(run.read().qty);
  expect(worth).toBeGreaterThanOrEqual(Math.floor(qty * Number(bid) * 0.98 * 100) / 100);
  expect(worth).toBeLessThanOrEqual(Math.ceil(qty * Number(ask) * 1.02 * 100) / 100);
  await expect(main.locator('[data-figure="unrealised"]')).toHaveText(/^[+−]?\$[\d,]+\.\d{2,4}$/);
});

test(`${J} #3 sells the coins: a sale row with what was received, the cost of the lot it used and the realised result`, async ({
  page,
}) => {
  const who = account();
  const { qty, cost } = run.read();
  await signIn(page, who);
  const before = await (await api(who)).balances();
  await page.goto(deskPath('BTC/USDT'));
  const { bid } = await bestPrices('BTC/USDT');
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price' }).nth(1).fill(priceAt(bid, 99));
  // The sell side's Max: every whole step of the BTC held (the market's step is 0.00001 BTC).
  await previewed(page, () => page.getByRole('button', { name: 'Max' }).last().click());
  await page.getByRole('button', { name: 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'sell');
  await expect.poll(async () => total(await (await api(who)).balances(), 'BTC'), { timeout: 20_000 }).toBeLessThan(toUnits('0.00001'));
  await settled(who);
  const after = await (await api(who)).balances();
  const sold = toUnits(qty) - total(after, 'BTC');
  const proceeds = total(after, 'USDT') - total(before, 'USDT');
  // One lot: the sale takes its share of the lot's cost, cut the way the ledger's 18 places allow.
  const costSold = sold === toUnits(qty) ? toUnits(cost) : (toUnits(cost) * sold) / toUnits(qty);
  const realised = proceeds - costSold;
  run.write({ sold: fromUnits(sold), proceeds: fromUnits(proceeds), realised: fromUnits(realised) });

  const main = await pnl(page);
  const sale = main.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first();
  await expect(sale).toBeVisible();
  await expect(sale.locator('td').nth(0)).toHaveText(fromUnits(sold));
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText(usd(costSold));
  await expect(sale.locator('[data-col="result"]')).toHaveText(usd(realised, true));
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(realised, true));
  // Every coin of the lot was sold: the lot is closed and no open BTC row is left.
  expect(total(after, 'BTC')).toBe(0n);
  expect(sold).toBe(toUnits(qty));
  await expect(main.locator('tr[data-asset="BTC"]')).toHaveCount(0);
});

test(`${J} #4 reads the label: an indicator, not a tax form, with the method FIFO and what it means`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const main = await pnl(page);
  await expect(main.locator('[data-indicator="true"]')).toHaveText(/indicator .* not a tax form/i);
  const methods = main.getByRole('group', { name: 'Matching method' });
  await expect(methods.getByRole('button', { name: 'FIFO: oldest first' })).toHaveAttribute('aria-pressed', 'true');
  await expect(main).toContainText('Each sale is matched against the lots you bought, one lot at a time, using the method you pick.');
});

test(`${J} #5 switches to LIFO (one lot: the same result), then asks for an unknown method and is refused`, async ({ page }) => {
  const who = account();
  const { realised } = run.read();
  await signIn(page, who);
  const main = await pnl(page);
  const methods = main.getByRole('group', { name: 'Matching method' });
  await methods.getByRole('button', { name: 'LIFO: newest first' }).click();
  await expect(methods.getByRole('button', { name: 'LIFO: newest first' })).toHaveAttribute('aria-pressed', 'true');
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(toUnits(realised), true));

  // An unknown method in the link: nothing is worked out, the refusal is in words with the service's code.
  const refused = await pnl(page, '?method=LOFO');
  await expect(refused).toContainText('That matching method isn’t offered');
  await expect(page).toHaveURL(/method=LOFO/);
  await expect(refused.locator('[data-figure="realised"]')).toHaveCount(0);
  // The service refuses the same method on its own door, so the screen is not the only guard.
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${JSON.stringify(login).slice(0, 300)}`);
  const res = await fetch(`${EDGE}/api/tax/trpc/lotBook?input=${encodeURIComponent(JSON.stringify({ method: 'LOFO' }))}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
  // Picking a method again brings the figures back.
  await refused.getByRole('group', { name: 'Matching method' }).getByRole('button', { name: 'FIFO: oldest first' }).click();
  await expect(page).toHaveURL(/method=FIFO/);
  await expect(refused.locator('[data-figure="realised"]')).toHaveText(usd(toUnits(realised), true));
});

test(`${J} #6 sells coins that arrived by deposit: the sale reaches no lot, its cost is unknown and the total stays blank`, async ({
  page,
}) => {
  const who = account();
  // TEST 0.05 ETH arrives by deposit through the real ledger: no trade, so no cost is known.
  expect(fund(who.email, 'ETH', '0.05').tx).toBeTruthy();
  await signIn(page, who);
  await page.goto(deskPath('ETH/USDT'));
  const { bid } = await bestPrices('ETH/USDT');
  await reviewLimit(page, 'sell', priceAt(bid, 99), '0.02', 'ETH');
  await confirm(page, 'sell');
  await expect.poll(async () => total(await (await api(who)).balances(), 'ETH'), { timeout: 20_000 }).toBe(toUnits('0.03'));

  const main = await pnl(page);
  const sale = main.locator('tr[data-sale]').filter({ hasText: 'ETH' }).first();
  await expect(sale).toBeVisible();
  await expect(sale.locator('td').nth(0)).toHaveText('0.02');
  await expect(sale.locator('td').nth(2)).toHaveText('Not known');
  // The deposit is a lot with no cost and the whole sale drew on it: the result is unknown and all 0.02 is named as sold
  // with no cost (Missing cost, PF-cost-basis-04).
  await expect(sale.locator('[data-col="result"]')).toHaveText('Cost unknown Unknown share: 0.02 ETH sold with no cost');
  await expect(sale.locator('[data-col="result"] [data-effect="unknown-share"]')).toHaveCount(1);
  // Never a made-up cost: the realised total is blank as soon as one sale's result is unknown.
  await expect(main.locator('[data-figure="realised"]')).toHaveText('Not known');
  await expect(main.getByRole('list', { name: 'Why some figures are not known' })).toBeVisible();
  // The ETH still held has no recorded cost either.
  const eth = main.locator('tr[data-asset="ETH"]');
  if (await eth.count()) await expect(eth.locator('[data-col="cost"]')).toHaveText('Not known');

  // With balances hidden (the eye on Money) the quantity inside that sentence is masked too, as every figure on the page is.
  const eye = async (name) => {
    await page.goto('/money');
    const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST');
    await page.getByRole('button', { name }).first().click();
    expect((await written).status()).toBe(200);
  };
  await eye('Hide balances');
  try {
    const hidden = await pnl(page);
    await expect(hidden.locator('tr[data-sale]').filter({ hasText: 'ETH' }).first().locator('[data-effect="unknown-share"]')).toHaveText(
      'Unknown share: •••• ETH sold with no cost',
    );
  } finally {
    await eye('Show balances');
  }
});

test(`${J} #7 trades between two non-dollar coins: no dollar figure on either side where none is known`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  // TEST: buy BTC with USDT first, so the BTC that pays for the ETH has a known cost.
  await page.goto(deskPath('BTC/USDT'));
  const btcAsk = (await bestPrices('BTC/USDT')).ask;
  await reviewLimit(page, 'buy', priceAt(btcAsk, 101), '0.002');
  await confirm(page, 'buy');
  await settled(who);
  // Then TEST ETH bought on the ETH/BTC book, paid in BTC: neither leg is in dollars.
  const before = await (await api(who)).balances();
  await page.goto(deskPath('ETH/BTC'));
  const { ask } = await bestPrices('ETH/BTC');
  await reviewLimit(page, 'buy', priceAt(ask, 101, 5), '0.02', 'ETH');
  await confirm(page, 'buy');
  await expect.poll(async () => held(await (await api(who)).balances(), 'BTC'), { timeout: 20_000 }).toBe(0n);
  const after = await (await api(who)).balances();
  const paid = total(before, 'BTC') - total(after, 'BTC');
  const got = total(after, 'ETH') - total(before, 'ETH');
  expect(paid).toBeGreaterThan(0n);
  expect(got).toBeGreaterThan(0n);

  const main = await pnl(page);
  // The BTC that paid is a sale with no dollar proceeds, so its result is not known; never a made-up price.
  const sale = main.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first();
  await expect(sale.locator('td').nth(0)).toHaveText(fromUnits(paid));
  await expect(sale.locator('td').nth(1)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).not.toContainText('$');
  // The ETH that arrived is a bought lot with no dollar cost.
  await page.goto('/money/pnl?asset=ETH');
  const lots = page.getByRole('region', { name: 'Lots' });
  const lot = lots.locator('tbody tr[data-source="trade"]');
  await expect(lot).toHaveCount(1);
  await expect(lot.locator('[data-col="qty"]')).toHaveText(fromUnits(got));
  await expect(lot.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect(page.locator('tr[data-asset="ETH"] [data-col="cost"]')).toHaveText('Not known');
});
