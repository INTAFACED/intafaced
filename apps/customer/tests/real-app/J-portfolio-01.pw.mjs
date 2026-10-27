import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, fund, journeyState, tool, toUnits } from './stack.mjs';
import { awayBid, confirm, deskPath, fundedTrader, held, openOrders, reviewLimit, signIn } from './desk.mjs';

// J-portfolio-01, in the running app (docs/roadmap/journeys.json): "After I trade, I see what I hold, what is locked and
// what it is worth". One test per step, titled "J-portfolio-01 #<n>", run in order on one TEST account funded with TEST
// USDT, holding TEST BTC and ETH bought on the desk and TEST EUR that no market prices. Amounts are checked against the
// ledger (the customer's own balance read), values against the bank's own valuation read just before and just after the
// page loads (the TEST market maker keeps moving prices), never against what the page itself computed.
const J = 'J-portfolio-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');
const FUTURES = 'BTC/USDT:USDT';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const grouped = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The screen's text for an amount (fmtAmount, round down): at most 8 places, no trailing zeros, grouped. */
function amountText(decimal) {
  const units = toUnits(decimal);
  const step = 10n ** 10n;
  const cut = units === 0n || units >= step ? (units / step) * step : units;
  const [whole, frac] = fromUnits(cut).split('.');
  return `${grouped(whole)}${frac ? `.${frac}` : ''}`;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(decimal) {
  const units = toUnits(decimal);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const whole = grouped((rounded / 10n ** BigInt(places)).toString());
  return `${negative && rounded !== 0n ? '−' : ''}$${whole}.${frac}`;
}

/** A ratio in 18-place units as the screen's percent (fmtPct): half-up to `places`, signed unless asked not to. */
function pct(ratio, places, signed = true) {
  const negative = ratio < 0n;
  const abs = negative ? -ratio : ratio;
  const step = 10n ** BigInt(18 - places - 2);
  const rounded = (abs + step / 2n) / step;
  const scale = 10n ** BigInt(places);
  const text = `${rounded / scale}.${(rounded % scale).toString().padStart(places, '0')}%`;
  return `${rounded === 0n ? '' : negative ? '−' : signed ? '+' : ''}${text}`;
}

const ratio = (a, b) => (a * ONE) / b;

/** The bank's own valuation for this person (`bank.portfolio.summary`), as /money reads it. */
async function bankSummary(who) {
  const { status, body } = await (await api(who)).get('/api/bank/trpc/portfolio.summary');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/**
 * Loads `path` and compares what `read` takes from the page with what `expected` works out from the bank's valuation
 * read just before and just after: the page must match one of the two exactly.
 */
async function matchesBank(page, who, path, read, expected) {
  await expect
    .poll(
      async () => {
        const before = expected(await bankSummary(who));
        await page.goto(path);
        const shown = await read(page);
        const after = expected(await bankSummary(who));
        const same = (a) => JSON.stringify(a) === JSON.stringify(shown);
        return same(before) || same(after)
          ? 'same'
          : `page ${JSON.stringify(shown)}, bank ${JSON.stringify(before)} then ${JSON.stringify(after)}`;
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe('same');
}

const money = (page) => page.getByTestId('if-money').first();
const coinRow = (page, asset) => money(page).locator(`tr[data-testid="money-row"][data-asset="${asset}"]`).first();

async function proLayout(page) {
  await page.goto('/money');
  await page
    .getByRole('radiogroup', { name: 'Simple or Pro layout' })
    .or(page.getByRole('group', { name: 'Simple or Pro layout' }))
    .first()
    .getByText('Pro')
    .click();
  await expect(page.locator('[data-testid="if-money"][data-density="pro"]')).toBeVisible();
}

/** The Pro columns of one coin's row, as the page shows them. */
async function proCells(page, asset) {
  const row = coinRow(page, asset);
  await expect(row.locator('[data-col="available"]')).not.toHaveText('—');
  const cell = async (col) => (await row.locator(`[data-col="${col}"]`).innerText()).trim();
  return {
    available: await cell('available'),
    inOrders: await cell('in-orders'),
    locked: await cell('locked'),
    inSpaces: await cell('in-spaces'),
  };
}

/** Waits until no order of `who` holds any USDT: every order this journey sends to buy crosses the book at once. */
async function settled(who) {
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
}

/** A limit buy 1% over the best ask: it takes the maker's asks at their own prices, and the rest of the hold comes back. */
async function buyNow(page, who, symbol, amount) {
  await page.goto(deskPath(symbol));
  const { ask } = await bestPrices(symbol);
  const step = 10n ** 16n;
  await reviewLimit(page, 'buy', fromUnits(((toUnits(ask) * 101n) / 100n / step) * step), amount, symbol.split('/')[0]);
  await confirm(page, 'buy');
  await settled(who);
}

test(`${J} #1 opens /money: every holding with amount, price, value and share, and the total with its split and quick actions`, async ({
  page,
}) => {
  test.setTimeout(150_000);
  const who = await fundedTrader(page, 'pf1', '1000');
  run.reset({ account: who });
  expect(fund(who.email, 'EUR', '25').tx).toBeTruthy();
  await signIn(page, who);
  await buyNow(page, who, 'BTC/USDT', '0.001');
  await buyNow(page, who, 'ETH/USDT', '0.01');

  // Amounts: exactly what the ledger holds, to the screen's eight places.
  const ledger = await (await api(who)).balances();
  await page.goto('/money');
  for (const asset of ['USDT', 'BTC', 'ETH', 'EUR']) {
    expect(toUnits(ledger[asset].total)).toBeGreaterThan(0n);
    await expect(coinRow(page, asset).getByTestId('money-num__entries')).toHaveText(`${amountText(ledger[asset].total)} ${asset}`);
  }

  // Price, value and share per coin, and the header total with its cash and crypto split, all from the bank's valuation.
  const shownRows = async (p) => {
    await expect(coinRow(p, 'BTC').locator('[data-col="price"]')).toContainText('$');
    const rows = {};
    for (const asset of ['USDT', 'BTC', 'ETH', 'EUR']) {
      const row = coinRow(p, asset);
      rows[asset] = {
        price: (await row.locator('[data-col="price"]').innerText()).trim(),
        value: (await row.locator('[data-col="value"]').innerText()).trim(),
        share: (await row.locator('[data-col="share"]').count()) ? (await row.locator('[data-col="share"]').innerText()).trim() : null,
      };
    }
    const total = await money(p)
      .getByTestId('money-total')
      .locator('[data-slot="hero-number"] [role=img]')
      .first()
      .getAttribute('aria-label');
    const split = (await p.getByTestId('total-split').innerText()).replace(/\s+/g, ' ').trim();
    return { rows, total, split };
  };
  const fromBank = (summary) => {
    const counted = summary.priced.reduce((sum, row) => sum + toUnits(row.valueUsd), 0n);
    const rows = {};
    for (const row of summary.priced)
      rows[row.asset] = {
        price: usd(row.priceUsd),
        value: usd(row.valueUsd),
        share: `· ${pct(ratio(toUnits(row.valueUsd), counted), 1, false)}`,
      };
    // A coin no market prices shows a dash for its price and value, and no share: never a zero.
    for (const row of summary.unpriced) rows[row.asset] = { price: '—', value: '—', share: null };
    return {
      rows: Object.fromEntries(['USDT', 'BTC', 'ETH', 'EUR'].map((asset) => [asset, rows[asset]])),
      total: `$${grouped(summary.totalUsd.split('.')[0])}.${summary.totalUsd.split('.')[1]}`,
      split: `Cash ${usd(summary.cashUsd)} · Crypto ${usd(summary.cryptoUsd)}`,
    };
  };
  await matchesBank(page, who, '/money', shownRows, fromBank);

  // The quick actions sit beside the total, each going somewhere real.
  const actions = page.getByTestId('money-actions');
  for (const action of ['Buy', 'Sell', 'Convert', 'Send', 'Receive'])
    await expect(actions.locator('a').filter({ hasText: new RegExp(`^${action}$`) })).toHaveAttribute('href', /^\//);
});

test(`${J} #2 reads the valuation note: the market and price behind each coin, the refresh, dollar coins at exactly 1, EUR not counted`, async ({
  page,
}) => {
  const who = account();
  await signIn(page, who);
  const note = (p) => p.getByRole('region', { name: 'How these values are worked out' });
  const shown = async (p) => {
    await expect(note(p).locator('tr[data-coin="BTC"] [data-col="price"]')).toContainText('$');
    const rows = {};
    for (const asset of ['USDT', 'BTC', 'ETH', 'EUR']) {
      const row = note(p).locator(`tr[data-coin="${asset}"]`);
      rows[asset] = [
        (await row.locator('[data-col="source"]').innerText()).trim(),
        (await row.locator('[data-col="price"]').innerText()).trim(),
      ];
    }
    return rows;
  };
  await matchesBank(page, who, '/money', shown, (summary) => {
    const rows = {};
    for (const row of summary.priced)
      rows[row.asset] = [row.pair ? `Last trade on ${row.pair}` : 'Counted at exactly $1', usd(row.priceUsd)];
    for (const row of summary.unpriced)
      rows[row.asset] = [
        row.reason === 'no_market' ? 'Not counted: no USDT or USDC market' : 'Not counted: its market has no last price',
        'Not counted',
      ];
    return Object.fromEntries(['USDT', 'BTC', 'ETH', 'EUR'].map((asset) => [asset, rows[asset]]));
  });
  const summary = await bankSummary(who);
  expect(summary.priced.find((row) => row.asset === 'USDT')).toMatchObject({ priceUsd: '1', pair: null });
  expect(summary.unpriced).toEqual([expect.objectContaining({ asset: 'EUR', reason: 'no_market' })]);
  await expect(note(page).getByTestId('valuation-time')).toHaveText(
    /^Valued at \d{2}:\d{2}\. This page asks for new prices every 30 seconds\.$/,
  );
  await expect(note(page)).toContainText('USDT, USDC and USD count as exactly $1.');
  await expect(note(page)).toContainText('never as zero');
  // The total names what it left out.
  await expect(money(page).getByText('Excludes 1 coin (no USD price)')).toBeVisible();
});

test(`${J} #3 places a TEST limit order, then reads the breakdown: available falls, in orders rises, and the parts add to the ledger total`, async ({
  page,
}) => {
  const who = account();
  await signIn(page, who);
  const before = (await (await api(who)).balances()).USDT;
  expect(toUnits(before.used)).toBe(0n);
  await page.goto(deskPath('BTC/USDT'));
  await reviewLimit(page, 'buy', await awayBid(90), '0.001');
  await confirm(page, 'buy');
  const [order] = await openOrders(who);
  expect(order).toBeTruthy();
  const after = (await (await api(who)).balances()).USDT;
  const hold = toUnits(after.used);
  expect(hold).toBeGreaterThan(0n);
  expect(toUnits(before.free) - toUnits(after.free)).toBe(hold);
  expect(toUnits(after.total)).toBe(toUnits(before.total));
  run.write({ orderId: order.id, hold: fromUnits(hold) });

  await proLayout(page);
  const cells = await proCells(page, 'USDT');
  expect(cells).toEqual({ available: amountText(after.free), inOrders: amountText(after.used), locked: '0', inSpaces: '0' });
  // The parts add to the ledger total, and the row's own amount is that total.
  expect(toUnits(after.free) + toUnits(after.used)).toBe(toUnits(after.total));
  await expect(coinRow(page, 'USDT').getByTestId('money-num__entries')).toHaveText(`${amountText(after.total)} USDT`);
  await expect(page.getByTestId('held-note')).toHaveCount(0);
  await expect(coinRow(page, 'USDT').locator('[data-col="in-orders"]')).toHaveAttribute(
    'title',
    new RegExp(`^Open order .+: ${fromUnits(hold).replace('.', '\\.')}`),
  );
});

const futuresAccess = (page) => page.getByTestId('futures-access');

/** The futures desk, open for this account: no agreement, quiz or notice gates it (owner decision 2026-10-27). */
async function openFuturesAccess(page) {
  await page.goto('/trade/futures');
  await expect(page.getByRole('button', { name: 'Open long' })).toBeVisible();
  await expect(futuresAccess(page).getByText('Open for your account')).toBeVisible();
}

async function positionsOf(who) {
  const { status, body } = await (await api(who)).get('/api/v1/positions');
  expect(status).toBe(200);
  return body;
}

test(`${J} #4 reads collateral apart: a TEST futures margin sits under Locked, not under In orders`, async ({ page }) => {
  test.setTimeout(150_000);
  const who = account();
  const { hold } = run.read();
  await signIn(page, who);
  await openFuturesAccess(page);
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill('0.001');
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill('5');
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Open long' }).click();
  const dialog = page.getByRole('alertdialog');
  const tier = dialog.getByRole('region', { name: 'New margin tier' });
  if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: 'Confirm open long' }).click();
  const filled = page.getByText('Order filled');
  await expect(filled.or(dialog.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  if (!(await filled.isVisible())) {
    if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
    await dialog.getByRole('button', { name: 'Confirm open long' }).click();
  }
  await expect(filled).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await positionsOf(who)).length, { timeout: 20_000 }).toBe(1);
  const [position] = await positionsOf(who);
  const collateral = toUnits(position.collateral);
  expect(collateral).toBeGreaterThan(0n);

  try {
    const now = (await (await api(who)).balances()).USDT;
    // The ledger's "used" is every lock: the order's hold plus the position's collateral.
    expect(toUnits(now.used)).toBe(toUnits(hold) + collateral);
    await page.goto('/money');
    await expect(page.locator('[data-testid="if-money"][data-density="pro"]')).toBeVisible();
    const cells = await proCells(page, 'USDT');
    expect(cells).toEqual({
      available: amountText(now.free),
      inOrders: amountText(hold),
      locked: amountText(fromUnits(collateral)),
      inSpaces: '0',
    });
    await expect(coinRow(page, 'USDT').locator('[data-col="locked"]')).toHaveAttribute('title', `Collateral: ${fromUnits(collateral)}`);
    await expect(page.getByTestId('held-note')).toHaveCount(0);
    // The coin's own page lists the same two claims under Set aside, each by what it is for.
    await page.goto('/money/balance/USDT');
    const aside = page.getByTestId('set-aside');
    await expect(aside.getByRole('row').filter({ hasText: 'Collateral' })).toContainText(amountText(fromUnits(collateral)));
    await expect(aside.getByRole('row').filter({ hasText: 'Open order' })).toContainText(amountText(hold));
  } finally {
    // Close the TEST position, so the next step starts with the order hold alone.
    await page.goto('/trade/futures');
    const row = page.getByRole('row').filter({ hasText: FUTURES }).first();
    await row.getByRole('button', { name: `Close, ${FUTURES}` }).click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).first().getByRole('button', { name: 'Close position' }).click();
    await expect.poll(async () => (await positionsOf(who)).length, { timeout: 20_000 }).toBe(0);
  }
});

test(`${J} #5 cancels the order: the hold returns to available and nothing is set aside`, async ({ page }) => {
  const who = account();
  const { orderId } = run.read();
  await signIn(page, who);
  await page.goto(deskPath('BTC/USDT'));
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page
    .locator('tr')
    .filter({ has: page.getByRole('button', { name: 'Cancel' }) })
    .first();
  await row.getByRole('button', { name: 'Cancel' }).click();
  const sure = page.getByRole('dialog').getByRole('button', { name: /cancel order|yes|confirm/i });
  if (await sure.count()) await sure.first().click();
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(0);
  const status = await (await api(who)).get(`/api/v1/orders/${orderId}?symbol=BTC%2FUSDT`);
  expect(status.body.status).toBe('canceled');

  const now = (await (await api(who)).balances()).USDT;
  expect(toUnits(now.used)).toBe(0n);
  expect(toUnits(now.free)).toBe(toUnits(now.total));
  await page.goto('/money');
  await expect(page.locator('[data-testid="if-money"][data-density="pro"]')).toBeVisible();
  expect(await proCells(page, 'USDT')).toEqual({ available: amountText(now.free), inOrders: '0', locked: '0', inSpaces: '0' });
  await page.goto('/money/balance/USDT');
  await expect(page.getByText('Nothing of your USDT is set aside right now.')).toBeVisible();
});

test(`${J} #6 opens the entries behind the USDT balance: every ledger entry, newest first, each with its reference`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const now = (await (await api(who)).balances()).USDT;
  await coinRowLink(page);
  await expect(page).toHaveURL(/\/money\/balance\/USDT$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('USDT');
  // The bank's own sum check: the entries add up to the spendable balance, to the last digit.
  await expect(page.getByRole('status').filter({ hasText: 'Balance check' })).toContainText(
    `to your balance: ${amountText(now.free)} USDT.`,
  );
  const table = page.getByRole('region', { name: /USDT/ }).locator('table');
  const rows = table.locator('tbody tr');
  // At least the TEST funding in and what the two buys paid out.
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  // Every entry the check counted is listed (one page is enough for this account).
  const check = await page.getByRole('status').filter({ hasText: 'Balance check' }).innerText();
  expect(await page.getByRole('button', { name: 'Load more' }).count()).toBe(0);
  expect(await rows.count()).toBe(Number(/All (\d+) entries/.exec(check)?.[1]));
  const times = await rows.locator('time').evaluateAll((list) => list.map((node) => Date.parse(node.getAttribute('datetime'))));
  expect(times.every((t, i) => i === 0 || times[i - 1] >= t)).toBe(true);
  for (const ref of await rows.locator('code').allInnerTexts()) expect(ref.trim()).toMatch(/\S{8,}/);
  // The oldest line is the TEST funding that started the journey.
  await expect(rows.last()).toContainText('+1,000');
});

async function coinRowLink(page) {
  await page.goto('/money');
  await coinRow(page, 'USDT').getByTestId('money-num__entries').click();
}

test(`${J} #7 reads best and worst movers: the coins that moved most today, from the same valuation as the total`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const movers = (p) => p.getByRole('region', { name: 'Best and worst today' });
  await matchesBank(
    page,
    who,
    '/money',
    async (p) => {
      await expect(movers(p)).toBeVisible();
      const side = async (name) =>
        await movers(p)
          .locator(`[data-side="${name}"] li`)
          .evaluateAll((items) => items.map((li) => `${li.getAttribute('data-asset')} ${li.innerText.replace(/\s+/g, ' ').trim()}`));
      const line = async (id) => ((await movers(p).getByTestId(id).count()) ? (await movers(p).getByTestId(id).innerText()).trim() : null);
      return {
        best: await side('best'),
        worst: await side('worst'),
        flat: await line('movers-flat'),
        unranked: await line('movers-unranked'),
      };
    },
    (summary) => {
      const ranked = [];
      const unranked = [];
      for (const row of summary.priced) {
        if (row.pair === null) continue;
        if (row.change24hUsd === null) {
          unranked.push(row.asset);
          continue;
        }
        const change = toUnits(row.change24hUsd);
        const before = toUnits(row.valueUsd) - change;
        if (before <= 0n) unranked.push(row.asset);
        else ranked.push({ asset: row.asset, change, move: ratio(change, before) });
      }
      ranked.sort((a, b) => (a.move === b.move ? 0 : a.move > b.move ? -1 : 1));
      // The direction is said by a glyph as well as the sign: never by colour alone.
      const text = (r) => `${r.asset} ${r.asset} ${r.move > 0n ? '▲' : '▼'} ${usdSigned(r.change)} (${pct(r.move, 2)})`;
      return {
        best: ranked
          .filter((r) => r.move > 0n)
          .slice(0, 3)
          .map(text),
        worst: ranked
          .filter((r) => r.move < 0n)
          .reverse()
          .slice(0, 3)
          .map(text),
        flat: ranked.some((r) => r.move === 0n)
          ? `No move: ${ranked
              .filter((r) => r.move === 0n)
              .map((r) => r.asset)
              .join(', ')}`
          : null,
        unranked: unranked.length ? `No 24-hour price to compare, so not ranked: ${unranked.join(', ')}` : null,
      };
    },
  );
  // Both coins bought on the desk are on the list, somewhere: best, worst, flat or named as not ranked.
  await expect(movers(page)).toContainText('BTC');
  await expect(movers(page)).toContainText('ETH');
  await expect(movers(page)).toContainText('Not profit and loss.');
});

function usdSigned(units) {
  const text = usd(fromUnits(units < 0n ? -units : units));
  return units < 0n ? `−${text}` : units > 0n ? `+${text}` : text;
}

test(`${J} #8 opens /money while prices cannot be read: the refusal in plain words with a reference, and no guessed total`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = account();
  await signIn(page, who);
  try {
    // svc-trade publishes the prices the bank values with; with it stopped, the bank refuses rather than guess.
    tool('local-test-stack.mjs', 'stop', 'trade');
    const refused = await (await api(who)).get('/api/bank/trpc/portfolio.summary');
    expect(JSON.stringify(refused.body)).toContain('bank.prices_unavailable');
    await page.goto('/money');
    const block = money(page).locator('[data-slot="state-block"][data-kind="refused"]');
    await expect(block).toContainText("Prices can't be loaded right now.");
    await expect(block).not.toContainText('bank.prices_unavailable');
    await expect(block).toContainText('Ref PRC-1');
    await expect(money(page).getByTestId('money-total').locator('[data-slot="hero-number"]')).toHaveCount(0);
    await expect(money(page).locator('tr[data-testid="money-row"]')).toHaveCount(0);
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'trade');
  }
  await page.goto('/money');
  await expect(coinRow(page, 'BTC').locator('[data-col="price"]')).toContainText('$', { timeout: 30_000 });
});
