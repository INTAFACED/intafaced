import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, bestPrices, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, reviewLimit, signIn } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-portfolio-05, in the running app (docs/roadmap/journeys.json): "I see my profit and loss over time". One test per
// step, titled "J-portfolio-05 #<n>", run in order on one TEST account. Step 1 builds the starting state through the real
// product: TEST 1000 USDT, a buy of 0.01 BTC and the sale of all that arrived, a TEST deposit of 0.003 BTC whose price the person enters, and
// a cash-out of 0.001 BTC through the stack's TEST payout stand-in (BANK_PAYOUT_PARTNER=payout-sim, which pays nobody; its
// signed calls verify the account and say paid, as a partner would). Every figure is checked against a hand count from
// the ledger balances, the price entered and the public candles, never against the lot book itself. The fee each fill
// took is worked out from the balances too: the buy's is what did not arrive, which gives the rate, and the sale's is that
// rate on what it grossed. Steps 4 to 7 (the chart, the breakdown, the change-in-value bridge and value over time) are
// not built yet.
const J = 'J-portfolio-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');
// TEST: the price the person says they paid for the deposited coins, per BTC.
const PRICE = '61000.5';
// TEST: the standard example IBAN, not a customer's account.
const IBAN = 'GB82 WEST 1234 5698 7654 32';

test.describe.configure({ mode: 'default' });

function state() {
  const now = run.read();
  if (!now.who || !now.secret) throw new Error(`${J} #1 set up no account, so this step has no one to act as`);
  return now;
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
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${(rounded / 10n ** BigInt(places)).toLocaleString('en-US')}.${frac}`;
}

/** Dollars on screen ("+$1,234.56", "−$0.0123") back to units, exact to what is shown. */
function dollars(text) {
  const m = /([+−-]?)\$([\d,]+\.\d+)/.exec(text);
  if (!m) throw new Error(`no dollar figure in "${text}"`);
  const units = toUnits(m[2].replaceAll(',', ''));
  return m[1] === '−' || m[1] === '-' ? -units : units;
}

const CENT = toUnits('0.01');
const near = (a, b, slack = CENT) => (a > b ? a - b : b - a) <= slack;
const times = (a, b) => (a * b) / ONE;
const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');
const priceAt = (decimal, percent) => fromUnits(((toUnits(decimal) * BigInt(percent)) / 100n / 10n ** 16n) * 10n ** 16n);

/** One limit order across the spread: it takes the maker's quotes and fills at once. Returns what moved each way. */
async function trade(page, who, side, amount) {
  const before = await (await api(who)).balances();
  await page.goto(deskPath('BTC/USDT'));
  const { ask, bid } = await bestPrices('BTC/USDT');
  await reviewLimit(page, side, side === 'buy' ? priceAt(ask, 101) : priceAt(bid, 99), amount);
  await confirm(page, side);
  const pot = side === 'buy' ? 'USDT' : 'BTC';
  await expect.poll(async () => held(await (await api(who)).balances(), pot), { timeout: 20_000 }).toBe(0n);
  const after = await (await api(who)).balances();
  return { usdt: total(after, 'USDT') - total(before, 'USDT'), btc: total(after, 'BTC') - total(before, 'BTC') };
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The next authenticator code, keeping its step so no code is used twice. */
async function code() {
  const now = state();
  const { totp } = await totpLib();
  const next = await nextCode(totp, now.secret, now.step);
  run.write({ step: next.step });
  return next.code;
}

/** With an authenticator on, signing in takes a code. */
async function signInWithCode(page) {
  const { who } = state();
  const totpCode = await code();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function confirmItsMe(page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0);
}

let jobCtx;
/** One call of the TEST payout partner's signed job door, as the partner would make it. */
async function partner(what, body) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/payout-sim/${what}`, {
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
  if (res.status !== 200) throw new Error(`payout-sim/${what} refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/** The person's own bank API through Edge, signed in with a code (the authenticator is on by then). */
async function bank() {
  const { who } = state();
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceKey: DEVICE_KEY,
      identifier: who.email,
      password: who.password,
      totpCode: await code(),
    }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  return {
    query: async (procedure, input) => {
      const res = await fetch(
        `${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        {
          headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(`${procedure} refused: ${res.status}`);
      return body.result.data;
    },
  };
}

/** What `qty` BTC was worth at each of the moments it may have been posted at: the close of the last one-minute candle that
 * started at or before it (the price-at-time rule), from the public candles. */
async function valuesAt(qty, moments) {
  const since = Math.floor(Math.min(...moments) / 60_000) * 60_000 - 3_600_000;
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent('BTC/USDT')}?timeframe=1m&since=${since}&limit=720`, {
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  const candles = await res.json();
  const closes = moments.map((t) => candles.filter((c) => c[0] <= t).at(-1)?.[4]).filter(Boolean);
  expect(closes.length).toBeGreaterThan(0);
  return [...new Set(closes)].map((close) => times(qty, toUnits(close)));
}

async function pnl(page, query = '') {
  await page.goto(`/money/pnl${query}`);
  await expect(page.getByRole('heading', { name: 'Profit and loss', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your result' })).toBeVisible();
  return page;
}

/** Everything one view shows, read in one go so the price under it cannot move between the reads. */
async function snapshot(page, view) {
  const result = page.getByRole('region', { name: 'Your result' });
  await result.getByRole('group', { name: 'Show the result as' }).getByRole('button', { name: view, exact: true }).click();
  await expect(result.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed', 'true');
  return page
    .locator('main')
    .first()
    .evaluate((main) => {
      const text = (sel) => main.querySelector(sel)?.textContent?.trim() ?? null;
      return {
        view: text('[data-figure="view"]'),
        viewName: main.querySelector('[data-figure="view"]')?.getAttribute('data-view') ?? null,
        realised: text('[data-figure="realised"]'),
        unrealised: text('[data-figure="unrealised"]'),
        worth: main.querySelector('tr[data-asset="BTC"]')?.querySelectorAll('td')[3]?.textContent?.trim() ?? null,
        last: text('[data-label="last-trade"]'),
        saleFees: text('[data-figure="sale-fees"]'),
      };
    });
}

/** The hand count, from what step 1 recorded. */
function handCount() {
  const s = state();
  const saleResult = toUnits(s.proceeds) - toUnits(s.cost);
  const depositCost = times(toUnits('0.001'), toUnits(PRICE));
  // The withdrawal's value is one of the candidate prices around its moment; each gives one realised figure.
  const withdrawals = s.withdrawn.map(toUnits);
  return {
    saleResult,
    depositCost,
    openCost: times(toUnits('0.002'), toUnits(PRICE)),
    withdrawals,
    realised: withdrawals.map((w) => saleResult + (w - depositCost)),
  };
}

test(`${J} #1 switches between all time, realised, unrealised, last transaction and 24 hours: each matches a hand count`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  // The starting state, through the product. A buy of 0.01 BTC and the sale of what arrived: the bought lot is used up.
  const who = await fundedTrader(page, 'pf5', '1000');
  run.reset({ who });
  await signIn(page, who);
  const buy = await trade(page, who, 'buy', '0.01');
  // The buy's fee is what did not arrive, in BTC; it gives the taker rate in basis points, which the sale pays too.
  const buyFee = toUnits('0.01') - buy.btc;
  expect((buyFee * 10_000n) % toUnits('0.01')).toBe(0n);
  const bps = (buyFee * 10_000n) / toUnits('0.01');
  // All that arrived is sold, so no bought coin is left for the withdrawal to draw on (the desk's amount step is 0.00001).
  expect(buy.btc % toUnits('0.00001')).toBe(0n);
  await page.waitForTimeout(2_000);
  const sale = await trade(page, who, 'sell', fromUnits(buy.btc));
  expect(sale.btc).toBe(-buy.btc);
  run.write({ cost: fromUnits(-buy.usdt), proceeds: fromUnits(sale.usdt), buyFee: fromUnits(buyFee), bps: String(bps) });

  // An outside deposit of TEST 0.003 BTC through the real ledger, and the price the person paid for it.
  expect(fund(who.email, 'BTC', '0.003').tx).toBeTruthy();
  await pnl(page, '?asset=BTC');
  const missing = page.getByRole('region', { name: 'Missing cost' });
  await missing.getByRole('button', { name: 'Enter a cost' }).click();
  const form = missing.getByRole('form', { name: 'Enter a cost for this lot' });
  await form.getByLabel('Price you paid per BTC, in USD').fill(PRICE);
  await form.getByLabel('Where this price comes from').fill('TEST receipt from an outside purchase');
  await form.getByRole('button', { name: 'Save price' }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');

  // A withdrawal of 0.001 BTC: a cash-out to a linked TEST bank account, confirmed with a fresh check.
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  await page.goto('/bank/ramps/accounts');
  const link = page.getByRole('form', { name: 'Link a bank account' });
  await link.getByLabel('Name for this account').fill('TEST salary account');
  await link.getByLabel('Account holder').fill('TEST Holder');
  await link.getByLabel('IBAN', { exact: true }).fill(IBAN);
  await link.getByRole('button', { name: 'Link account' }).click();
  await confirmItsMe(page);
  await expect(link).toContainText('Linked TEST salary account.');
  const account = (await (await bank()).query('linkedAccounts.list', undefined)).accounts[0];
  expect(await partner('verify', { accountId: account.accountId })).toMatchObject({ state: 'verified' });
  expect(tool('local-test-stack.mjs', 'age-linked-accounts', who.email, '25')).toContain('1 linked account(s)');
  await page.goto('/bank/ramps/cash-out');
  await page.getByLabel('Currency to cash out').selectOption('BTC');
  await page.getByLabel('Amount').fill('0.001');
  await page.getByLabel('Bank account to pay into').selectOption({ label: 'TEST salary account (GB82 •••• 5432)' });
  await page.getByRole('button', { name: 'See what you get' }).click();
  await expect(page.getByTestId('cash-out-blocker')).toHaveCount(0);
  const leftFrom = Date.now();
  await page.getByRole('button', { name: 'Cash out', exact: true }).click();
  await confirmItsMe(page);
  await expect(page.getByTestId('cash-out-sent')).toContainText('Your cash-out is on its way');
  const leftBy = Date.now();
  const [taken] = await (await bank()).query('cashOut.requests', { limit: 10 });
  expect(taken).toMatchObject({ amount: '0.001', assetId: 'BTC', status: 'processing' });
  expect(await partner('paid', { cashOutId: taken.requestId })).toMatchObject({ status: 'completed' });
  const withdrawn = await valuesAt(toUnits('0.001'), [leftFrom, leftBy]);
  run.write({ withdrawn: withdrawn.map(fromUnits) });

  // The book, read by hand: the sale is what arrived less what the buy cost; the withdrawal moved out 0.001 of the
  // deposit (FIFO: the bought lot was used up) at its value when it left, less the price entered for it.
  const hand = handCount();
  await pnl(page, '?asset=BTC');
  const sales = page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]');
  await expect(sales).toHaveCount(2);
  const out = sales.filter({ has: page.locator('th[data-kind="moved_out"]') });
  await expect(out.locator('th')).toContainText('Moved out');
  expect(hand.withdrawals.map((w) => usd(w))).toContain((await out.locator('td').nth(1).innerText()).trim());
  await expect(out.locator('td').nth(2)).toHaveText(usd(hand.depositCost));
  const sold = sales.filter({ has: page.locator('th[data-kind="sale"]') });
  await expect(sold.locator('td').nth(1)).toHaveText(usd(toUnits(state().proceeds)));
  await expect(sold.locator('[data-col="result"]')).toHaveText(usd(hand.saleResult, true));

  // Realised: the sale and the withdrawal, by hand.
  const realised = await snapshot(page, 'Realised');
  expect(realised.viewName).toBe('realised');
  expect(hand.realised.map((r) => usd(r, true))).toContain(realised.view);
  expect(realised.view).toBe(realised.realised);
  await expect(page).toHaveURL(/view=realised/);

  // Unrealised: the 0.002 BTC still open from the deposit, worth what Money says now, less 0.002 at the price entered.
  const unrealised = await snapshot(page, 'Unrealised');
  expect(near(dollars(unrealised.view), dollars(unrealised.worth) - hand.openCost)).toBe(true);
  expect(unrealised.view).toBe(unrealised.unrealised);

  // All time is realised plus unrealised, on the same price.
  const all = await snapshot(page, 'All time');
  expect(near(dollars(all.view), dollars(all.realised) + dollars(all.unrealised))).toBe(true);
  expect(hand.realised.map((r) => usd(r, true))).toContain(all.realised);
  await expect(page).not.toHaveURL(/view=/);

  // Last transaction: the newest trade is the sale (the deposit and the withdrawal are not trades), and its result.
  const last = await snapshot(page, 'Last trade');
  expect(last.view).toBe(usd(hand.saleResult, true));
  expect(last.last).toMatch(/^Sale of BTC on /);

  // 24 hours: everything open arrived inside the 24 hours, so it counts from its cost: the same as unrealised now.
  const day = await snapshot(page, '24 hours');
  expect(day.view).toBe(day.unrealised);
  await expect(page.getByRole('region', { name: 'Your result' })).toContainText(
    'A coin bought inside the 24 hours counts from what it cost',
  );

  // A copied link opens on the same view.
  await page.goto('/money/pnl?view=last');
  await expect(page.locator('[data-figure="view"]')).toHaveText(usd(hand.saleResult, true));
});

test(`${J} #2 turns "include transfers" off: the deposit and the withdrawal stop counting as gain or loss`, async ({ page }) => {
  test.setTimeout(240_000);
  const hand = handCount();
  await signInWithCode(page);
  await pnl(page, '?asset=BTC');
  const transfers = page.getByRole('region', { name: 'Deposits and withdrawals' });
  const toggle = transfers.getByRole('switch', { name: 'Count deposits and withdrawals' });
  // On is where step 1 left it; an earlier attempt of this step may have stopped with it off, so it goes back on first.
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
    await expect(toggle).toBeChecked();
  }
  await toggle.click();
  await expect(transfers.getByRole('status')).toHaveText('Saved. The figures above use it.');
  await expect(toggle).not.toBeChecked();
  await expect(transfers).toContainText('Off: coins you deposit and coins you withdraw are left out of every result here.');

  // Only the trade counts now: realised is the sale alone, nothing open is counted, and all time is the sale.
  await expect(page.locator('[data-figure="realised"]')).toHaveText(usd(hand.saleResult, true));
  expect((await snapshot(page, 'Realised')).view).toBe(usd(hand.saleResult, true));
  expect((await snapshot(page, 'Unrealised')).view).toBe('Nothing open to measure');
  expect((await snapshot(page, 'All time')).view).toBe(usd(hand.saleResult, true));
  expect((await snapshot(page, '24 hours')).view).toBe('Nothing open to measure');

  // They stay listed, marked: the deposit's lot and the withdrawal are not counted.
  const lots = page.getByRole('region', { name: 'Lots' });
  await expect(lots.locator('tbody tr[data-source="deposit"] [data-col="source"]')).toHaveText('Deposit Not counted');
  await expect(lots.locator('tbody tr[data-source="trade"] [data-col="source"]')).toHaveText('Bought');
  const out = page
    .getByRole('region', { name: 'Sales' })
    .locator('tr[data-sale]')
    .filter({ has: page.locator('th[data-kind="moved_out"]') });
  await expect(out.locator('th [data-label="not-counted"]')).toHaveText('Not counted');
  // The deposited coins still held are listed, named as not counted, with no unrealised figure.
  const held = page.locator('tr[data-asset="BTC"]');
  await expect(held.locator('[data-col="unrealised"]')).toHaveText('Not counted');
  await expect(held.locator('th [data-label="not-counted"]')).toHaveText('+ 0.002 BTC that arrived by deposit or transfer, not counted');

  // The choice is saved: a reload keeps it.
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Count deposits and withdrawals' })).not.toBeChecked();
  await expect(page.locator('[data-figure="realised"]')).toHaveText(usd(hand.saleResult, true));

  // On again, the deposit and the withdrawal count again.
  await page.getByRole('switch', { name: 'Count deposits and withdrawals' }).click();
  await expect(page.getByRole('switch', { name: 'Count deposits and withdrawals' })).toBeChecked();
  await expect
    .poll(async () => hand.realised.map((r) => usd(r, true)).includes(await page.locator('[data-figure="realised"]').innerText()))
    .toBe(true);
  await expect(out.locator('th [data-label="not-counted"]')).toHaveCount(0);
});

/** A decimal shown on screen, with any grouping commas, back to units. */
const shownUnits = (text) => toUnits(text.replaceAll(',', ''));

test(`${J} #3 reads a sale's fee: inside the realised result, and on its own line`, async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const hand = handCount();
  // By hand: the sale received its gross less the fee, and the fee is the rate on the gross, so fee = net * bps / (10000 - bps).
  const bps = BigInt(s.bps);
  const saleFee = (toUnits(s.proceeds) * bps) / (10_000n - bps);
  // The buy's fee in dollars: its share of what was paid (fee / what the buy grossed in BTC, 0.01).
  const buyFeeUsd = (toUnits(s.buyFee) * toUnits(s.cost)) / toUnits('0.01');
  await signInWithCode(page);
  await pnl(page, '?asset=BTC');
  const sales = page.getByRole('region', { name: 'Sales' });
  await expect(sales.getByRole('columnheader', { name: 'Fee' })).toBeVisible();
  const sold = sales.locator('tr[data-sale]').filter({ has: page.locator('th[data-kind="sale"]') });
  // The fee the fill took, in the coin it was taken in (to 8 places on screen) and in dollars.
  const feeText = (await sold.locator('[data-col="fee"] [data-fee="known"]').innerText()).replace(/\s+/g, ' ').trim();
  const [, feeAmount, feeUsd] = /^([\d.,]+) USDT (\$[\d.,]+)$/.exec(feeText) ?? [];
  expect(feeAmount, `fee cell "${feeText}"`).toBeTruthy();
  expect(near(shownUnits(feeAmount), saleFee, toUnits('0.000000006'))).toBe(true);
  expect(near(dollars(feeUsd), saleFee, toUnits('0.0001'))).toBe(true);
  if (bps > 0n) expect(saleFee).toBeGreaterThan(0n);
  // Inside the result: what was received is what reached the balance after the fee, and the result is that less the cost.
  await expect(sold.locator('td').nth(1)).toHaveText(usd(toUnits(s.proceeds)));
  await expect(sold.locator('td').nth(2)).toHaveText(usd(toUnits(s.cost)));
  await expect(sold.locator('[data-col="result"]')).toHaveText(usd(hand.saleResult, true));
  // A withdrawal is not a fill: no trading fee.
  const out = sales.locator('tr[data-sale]').filter({ has: page.locator('th[data-kind="moved_out"]') });
  await expect(out.locator('[data-col="fee"]')).toHaveText('None');

  // On its own line: the sales' fees inside realised, and every trading fee paid, each said to be inside already.
  const realised = await snapshot(page, 'Realised');
  expect(realised.saleFees).toMatch(/^Fees on your sales, already taken out of this result: \$[\d.,]+$/);
  expect(near(dollars(realised.saleFees), saleFee, toUnits('0.0001'))).toBe(true);
  const fees = page.locator('[data-figure="fees"]');
  await expect(fees).toContainText(
    'Already inside the results: a buy’s fee is part of its cost, and a sale’s fee comes off what it received.',
  );
  expect(near(dollars(await fees.innerText()), saleFee + buyFeeUsd)).toBe(true);
  await expect(page.locator('[data-figure="realised"]')).toHaveText(realised.view);
});
