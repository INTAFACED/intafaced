import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, journeyState, otherTrader, signOutBrowser, toUnits, tool } from './stack.mjs';
import { awayBid, confirm, deskPath, fundedTrader, held, openOrders, reviewLimit, signIn, signUp, verify } from './desk.mjs';

// J-portfolio-03, in the running app (docs/roadmap/journeys.json): "I find any movement of my money, open its detail, and
// annotate it". One test per step, titled "J-portfolio-03 #<n>", run in order on one TEST account funded with TEST 1000
// USDT. Every row is checked against the bank's own activity read and the ledger balances, never against fixtures.
//
// The kinds this stack can make: a deposit (the TEST welcome funds), a trade, an order set aside, a cancelled order and a
// move to one of the person's own spaces. Earn has no rate configured on the stack (`earn.pools` refuses, a blank setting
// stays blank), and a withdrawal is refused before anything is held (J-cex-spot-01 #12), so neither leaves a line to show.
const J = 'J-portfolio-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ZONE = 'Pacific/Auckland';
const SPACE = 'Rent TEST';
const SAVED = '30';
const WITHDRAWN = '10';

test.describe.configure({ mode: 'default' });
// A zone far from UTC, so a time shown in UTC would not pass for local time.
test.use({ timezoneId: ZONE });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const priceAt = (decimal, percent) => fromUnits(((toUnits(decimal) * BigInt(percent)) / 100n / 10n ** 16n) * 10n ** 16n);
const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');

/** A decimal string rounded half-up to `places`, in units (fills are never negative). */
const roundedUnits = (decimal, places) => {
  const step = 10n ** BigInt(18 - places);
  return ((toUnits(decimal) + step / 2n) / step) * step;
};
const number = (text) => text.replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0] ?? '';

/**
 * What is wrong with one Activity trade row (cells: time, what, price, total, fee) against the service's fill, by the
 * room's own rules: a fill's price is on the market's tick, so it shows exactly; the total has the quote's fixed places
 * (6 for dollar coins, 8 for others), half-up; the fee has up to 8 places, half-up, and a non-zero fee never reads as zero;
 * an all-zero fee reads "Zero fee" and no fee reads "—". Returns "" when the row shows the fill.
 */
function rowMismatch(fill, cells) {
  if (!cells) return `fill ${fill.id}: no row`;
  const [, , price, total, fee] = cells;
  const quote = fill.symbol.split('/')[1] ?? '';
  const quotePlaces = ['USDT', 'USDC', 'USD'].includes(quote) ? 6 : 8;
  const shownPrice = number(price);
  if (!shownPrice || toUnits(shownPrice) !== toUnits(fill.price)) return `fill ${fill.id}: price "${price}", service ${fill.price}`;
  const shownTotal = number(total);
  if (
    (shownTotal.split('.')[1] ?? '').length !== quotePlaces ||
    toUnits(shownTotal) !== roundedUnits(fill.cost, quotePlaces) ||
    !total.includes(quote)
  )
    return `fill ${fill.id}: total "${total}", service ${fill.cost} ${quote}`;
  if (fill.fee === null) return fee.trim() === '—' ? '' : `fill ${fill.id}: fee "${fee}", service has none`;
  if (/^0+(\.0+)?$/.test(fill.fee.cost)) return fee.includes('Zero fee') ? '' : `fill ${fill.id}: fee "${fee}", service 0`;
  const eight = roundedUnits(fill.fee.cost, 8);
  const want = eight === 0n ? toUnits(fill.fee.cost) : eight;
  const shownFee = number(fee);
  if (!shownFee || toUnits(shownFee) !== want || !fee.includes(fill.fee.currency))
    return `fill ${fill.id}: fee "${fee}", service ${fill.fee.cost} ${fill.fee.currency}`;
  return '';
}

/** "24 Oct, 23:35" in the browser's zone, as the activity list writes a time this year. */
function local(iso) {
  const text = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: ZONE,
  })
    .format(Date.parse(iso))
    .replace(',', '');
  return `${text.slice(0, text.lastIndexOf(' '))}, ${text.slice(text.lastIndexOf(' ') + 1)}`;
}

/** A bank tRPC read as `who`. */
async function bankRead(who, path, input = {}) {
  const { status, body } = await (await api(who)).get(`/api/bank/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  return { status, body, data: body?.result?.data };
}

/** Every activity line the bank has for `who`, all pages. */
async function allLines(who, input = {}) {
  const lines = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const { status, data, body } = await bankRead(who, 'activity.list', { ...input, ...(cursor ? { cursor } : {}) });
    if (status !== 200) throw new Error(`activity.list refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    lines.push(...data.items);
    if (!data.nextCursor) return lines;
    cursor = data.nextCursor;
  }
  throw new Error('activity.list did not end in 20 pages');
}

const activity = (page) => page.getByRole('region', { name: 'Activity' }).last();
const rows = (page) => activity(page).locator('tbody tr[data-testid="money-act"]');

async function openActivity(page, query = '') {
  await page.goto(`/money/activity${query}`);
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
}

/** One limit buy over the best ask: it takes the maker's asks and fills at once. */
async function buyNow(page, who, amount) {
  await page.goto(deskPath('BTC/USDT'));
  const { ask } = await bestPrices('BTC/USDT');
  await reviewLimit(page, 'buy', priceAt(ask, 101), amount);
  await confirm(page, 'buy');
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
}

/** A limit buy far under the market: it rests, and its USDT is set aside. Returns the order. */
async function restBuy(page, who, percent, amount) {
  const before = new Set((await openOrders(who)).map((o) => o.id));
  await page.goto(deskPath('BTC/USDT'));
  await reviewLimit(page, 'buy', await awayBid(percent), amount);
  await confirm(page, 'buy');
  let order;
  await expect
    .poll(
      async () => {
        order = (await openOrders(who)).find((o) => !before.has(o.id));
        return Boolean(order);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return order;
}

test(`${J} #1 opens /money/activity: every kind of movement in one list, in plain words, with signed amounts and local time`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await fundedTrader(page, 'pf3', '1000');
  run.reset({ account: who });
  await signIn(page, who);

  // TEST movements of every kind this stack can make.
  await buyNow(page, who, '0.004');
  const resting = await restBuy(page, who, 80, '0.001');
  const cancelled = await restBuy(page, who, 85, '0.001');
  const cancel = await (await api(who)).delete(`/api/v1/orders/${cancelled.id}?symbol=${encodeURIComponent('BTC/USDT')}`);
  expect(cancel.status).toBe(200);

  // A move of TEST 20 USDT from the main account to a space of the person's own, made in the app.
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await dialog.getByLabel('Space name').fill(SPACE);
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible();
  const spaces = (await bankRead(who, 'spaces.list', { limit: 50 })).data;
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
  const space = spaces.find((s) => s.kind === 'named' && s.name === SPACE);
  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main.id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const move = page.getByRole('dialog');
  await move.getByLabel('To which of your accounts').selectOption(space.id);
  await move.getByLabel(/Amount/).fill('20');
  await move.getByRole('button', { name: 'Review' }).click();
  await move.getByRole('button', { name: 'Confirm' }).click();
  await expect(move.getByText(/ledger/i).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // TEST 30 USDT into the stack's instant-access savings, made in the app: an earn line.
  const pools = (await bankRead(who, 'earn.pools', { limit: 50 })).data;
  const pool = pools.find((row) => row.assetId === 'USDT' && row.kind === 'flexible');
  expect(pool, 'the stack seeds a TEST instant-access USDT pool').toBeTruthy();
  await page.goto('/bank/spaces');
  await page
    .getByTestId('instant-savings')
    .locator(`[data-testid="instant-savings-pool"][data-pool="${pool.id}"]`)
    .getByRole('button', { name: 'Open instant-access savings', exact: true })
    .click();
  const save = page.getByRole('dialog');
  await save.getByLabel('Amount (USDT)').fill(SAVED);
  await save.getByRole('button', { name: 'Review' }).click();
  await save.getByRole('button', { name: 'Open instant-access savings' }).click();
  await expect
    .poll(async () => (await bankRead(who, 'earn.positions', { limit: 50 })).data.filter((p) => p.poolId === pool.id).length)
    .toBe(1);
  await page.keyboard.press('Escape');

  // A TEST withdrawal of 10 USDT, held: sending out is switched off on this stack, so the stack books the hold through the
  // ledger's own recipe exactly as svc-pay's withdraw does (local-test-stack.mjs seed-withdrawal, as J-wallet-06 does).
  const seeded = tool(
    'local-test-stack.mjs',
    'seed-withdrawal',
    who.email,
    'USDT',
    WITHDRAWN,
    '--state',
    'held',
    '--ref',
    `${J}-${Date.now()}`,
  );
  expect(seeded).toMatch(/withdrawal\s+[0-9a-f-]{36}/);
  run.write({ resting: resting.id, cancelled: cancelled.id, space: space.id });

  // The bank's lines add up to the ledger: per coin, what came in less what went out is what the main account holds.
  const lines = await allLines(who);
  const balances = await (await api(who)).balances();
  for (const asset of ['USDT', 'BTC']) {
    const sum = lines
      .filter((l) => l.asset === asset && !l.spaceName)
      .reduce((s, l) => s + (l.direction === 'in' ? toUnits(l.amount) : -toUnits(l.amount)), 0n);
    expect(sum, `${asset}: the lines sum to what is available`).toBe(total(balances, asset) - held(balances, asset));
  }

  await openActivity(page);
  const list = rows(page);
  // Each movement is one row, in plain words.
  await expect(list.filter({ hasText: 'Welcome test funds' })).toHaveCount(1);
  await expect(list.filter({ hasText: /^Trade/ })).toHaveCount(1);
  await expect(list.filter({ hasText: 'Set aside for an order' })).toHaveCount(1);
  await expect(list.filter({ hasText: 'Order cancelled · nothing spent' })).toHaveCount(1);
  await expect(list.filter({ hasText: /Transfer|Moved/ })).not.toHaveCount(0);
  // Earn and withdrawal, each in its own words with its signed amount, as the bank's lines hold them.
  const earned = lines.filter((l) => l.kind === 'earn');
  expect(earned.map((l) => [l.direction, l.amount, l.asset])).toEqual([['out', SAVED, 'USDT']]);
  await expect(list.filter({ hasText: 'Moved to savings' })).toHaveCount(1);
  await expect(list.filter({ hasText: 'Moved to savings' }).locator('td').nth(2)).toHaveText(`−${SAVED} USDT`);
  const withdrawn = lines.filter((l) => l.kind === 'withdrawal');
  expect(withdrawn.map((l) => [l.direction, l.amount, l.asset])).toEqual([['out', WITHDRAWN, 'USDT']]);
  await expect(list.filter({ hasText: /^Withdrawal/ })).toHaveCount(1);
  await expect(
    list
      .filter({ hasText: /^Withdrawal/ })
      .locator('td')
      .nth(2),
  ).toHaveText(`−${WITHDRAWN} USDT`);
  // Signed amounts and local time, from the bank's own lines.
  const funds = lines.find((l) => l.kind === 'welcome_funds');
  const fundsRow = list.filter({ hasText: 'Welcome test funds' });
  await expect(fundsRow.locator('td').nth(2)).toHaveText('+1,000 USDT');
  await expect(fundsRow.getByTestId('money-act__time')).toHaveText(local(funds.postedAt));
  const trade = lines.find((l) => l.kind === 'trade' && l.direction === 'in');
  await expect(
    list
      .filter({ hasText: /^Trade/ })
      .locator('td')
      .nth(2),
  ).toHaveText(`+${trade.amount} BTC`);
  await expect(list.filter({ hasText: 'Set aside for an order' }).getByTestId('money-act__status')).toHaveText('Set aside');
  await expect(fundsRow.getByTestId('money-act__status')).toHaveText('Completed');
});

// #1's convert part: a conversion settles as ordinary trade fills (svc-trade convert/settle.ts), and the bank's activity has
// no convert kind to tell it from a desk trade. This part goes green when svc-bank lists conversions as their own kind.
test(`${J} #1 a conversion is listed as a convert, not as a desk trade (BLOCKED convert_kind)`, async () => {
  const who = run.read().account;
  expect(who, '#1 made no account').toBeTruthy();
  const res = await bankRead(who, 'activity.list', { kind: ['convert'], limit: 1 });
  expect(res.status, `BLOCKED convert_kind: svc-bank has no convert activity kind (${res.status})`).toBe(200);
});

/** The local calendar day `days` from today, as a date input takes it. */
function dayFromToday(days) {
  const at = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(at);
}

test(`${J} #2 filters by date, asset, type, account, address and year, and sorts: the list narrows`, async ({ page }) => {
  const who = account();
  const { space } = run.read();
  await signIn(page, who);
  await openActivity(page);
  const list = rows(page);
  await expect(list.filter({ hasText: 'Welcome test funds' })).toHaveCount(1);
  const all = await list.count();
  expect(all).toBeGreaterThan(4);

  // Type: the Deposits tab keeps only the deposit; Money out keeps only lines that went out.
  await page.getByRole('tab', { name: 'Deposits' }).click();
  await expect(list).toHaveCount(1);
  await expect(list.first()).toContainText('Welcome test funds');
  await page.getByRole('tab', { name: 'All' }).click();
  await expect(list).toHaveCount(all);
  const bar = page.getByRole('search', { name: 'Search activity' });
  await bar.getByRole('combobox', { name: 'Money in or out' }).selectOption('out');
  await expect(list.filter({ hasText: 'Welcome test funds' })).toHaveCount(0);
  for (const amount of await list.locator('td:nth-child(3)').allInnerTexts()) expect(amount).not.toMatch(/^\+/);
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await expect(list).toHaveCount(all);

  // Date: from tomorrow, nothing; from today, everything.
  await bar.getByLabel('From', { exact: true }).fill(dayFromToday(1));
  await expect(activity(page)).toContainText('Nothing matches');
  await bar.getByLabel('From', { exact: true }).fill(dayFromToday(0));
  await expect(list).toHaveCount(all);
  await bar.getByRole('button', { name: 'Clear filters' }).click();

  // Sort: oldest first puts the deposit at the top.
  await bar.getByRole('combobox', { name: 'Order', exact: true }).selectOption('asc');
  await expect(list.first()).toContainText('Welcome test funds');
  await bar.getByRole('combobox', { name: 'Order', exact: true }).selectOption('desc');
  await expect(list.last()).toContainText('Welcome test funds');

  // Account: the space holds only what was moved into it.
  await bar.getByRole('combobox', { name: 'Account', exact: true }).selectOption(space);
  await expect(list).toHaveCount(1);
  await expect(list.first()).toContainText(`Account: ${SPACE}`);
  await expect(list.first().locator('td').nth(2)).toHaveText('+20 USDT');
  await bar.getByRole('combobox', { name: 'Account', exact: true }).selectOption('');

  // Year: this calendar year holds everything; a tax year cannot be picked because its start date is not published.
  const year = bar.getByRole('combobox', { name: 'Year', exact: true });
  await year.selectOption(String(new Date().getUTCFullYear()));
  await expect(list).toHaveCount(all);
  await expect(year.locator('option', { hasText: 'Tax year (not set up)' })).toHaveAttribute('disabled', '');
  await year.selectOption('');

  // Address: no withdrawal went anywhere, so no line matches an address.
  await bar.getByLabel('Withdrawal address').fill('0xabcdef');
  await expect(activity(page)).toContainText('Nothing matches');
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await expect(list).toHaveCount(all);

  // Asset: a removable chip; a coin the person never held reads as empty, not as an error.
  await openActivity(page, '?tab=all&asset=BTC');
  await expect(list).not.toHaveCount(0);
  for (const amount of await list.locator('td:nth-child(3)').allInnerTexts()) expect(amount).toContain('BTC');
  await page.getByRole('button', { name: 'Remove BTC filter' }).click();
  await expect(page).not.toHaveURL(/asset=/);
  await openActivity(page, '?tab=all&asset=ZZZ');
  await expect(activity(page)).toContainText('No ZZZ activity');
});

test(`${J} #3 reads a traded order: its lines share one row, a cancelled order is one row, a resting order is set aside`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = account();
  await signIn(page, who);
  // TEST: a sell of 0.002 BTC inside the spread rests as the best ask; the stack's other trader buys it in two parts, so
  // one order has two fills.
  const { bid, ask } = await bestPrices('BTC/USDT');
  expect(toUnits(ask) - toUnits(bid)).toBeGreaterThan(toUnits('0.02'));
  const price = fromUnits(((toUnits(ask) - toUnits('0.01')) / 10n ** 16n) * 10n ** 16n);
  await page.goto(deskPath('BTC/USDT'));
  await reviewLimit(page, 'sell', price, '0.002');
  // The sheet closes before the order call answers, so the order is read back from the desk's own answer, by its id.
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/orders' && r.request().method() === 'POST');
  await confirm(page, 'sell');
  const res = await answer;
  expect(res.status(), await res.text()).toBeLessThan(300);
  const placed = await res.json();
  expect(placed).toMatchObject({ side: 'sell', status: 'open', price, amount: '0.002' });
  const sell = (await openOrders(who)).find((o) => o.id === placed.id);
  expect(sell).toMatchObject({ id: placed.id, side: 'sell', price, amount: '0.002' });
  const other = await api(otherTrader());
  const open = async () => (await openOrders(who)).find((o) => o.id === sell.id);
  // Each round buys 0.001 of the sale at its price. The market maker may have quoted asks under it since, and those
  // fill first, so the buy also takes everything offered below the sale's price, as J-cex-spot-01 #8 does with bids.
  for (let part = 1; part <= 6; part++) {
    const before = await open();
    if (!before) break;
    const { body } = await bestPrices('BTC/USDT');
    const ahead = body.asks.filter(([p]) => toUnits(p) < toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    const buy = await other.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: fromUnits(ahead + toUnits('0.001')),
      price,
      timeInForce: 'IOC',
      clientOrderId: `${J}-3-${sell.id}-${part}`,
    });
    expect(buy.status).toBeLessThan(300);
    await expect
      .poll(async () => toUnits((await open())?.filled ?? before.amount) > toUnits(before.filled), { timeout: 10_000 })
      .toBe(true)
      .catch(() => undefined);
  }
  await expect.poll(async () => (await openOrders(who)).some((o) => o.id === sell.id), { timeout: 20_000 }).toBe(false);
  const fills = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body.filter((f) => f.order === sell.id);
  expect(fills.length).toBeGreaterThanOrEqual(2);
  run.write({ partial: sell.id });

  // The bank's lines for the sale: the BTC set aside, and the USDT of each fill, all under the one order.
  const lines = (await allLines(who)).filter((l) => l.orderId === sell.id);
  expect(lines.filter((l) => l.kind === 'trade').length).toBe(fills.length);

  await openActivity(page);
  const list = rows(page);
  // One row for the sale, however many fills and holds it had.
  const sale = list.filter({ hasText: /^Trade/ }).filter({ has: page.locator('td:nth-child(3)', { hasText: /^\+.* USDT$/ }) });
  await expect(sale).toHaveCount(1);
  await expect(list.filter({ hasText: 'Order cancelled · nothing spent' })).toHaveCount(1);
  const resting = list.filter({ hasText: 'Set aside for an order' });
  await expect(resting).toHaveCount(1);
  await expect(resting.getByTestId('money-act__status')).toHaveText('Set aside');
});

test(`${J} #4 opens an entry: its linked lines as one group with the shared reference, and from a purchase a link to the coin`, async ({
  page,
}) => {
  const who = account();
  await signIn(page, who);
  const lines = await allLines(who);
  const bought = lines.find((l) => l.kind === 'trade' && l.direction === 'in' && l.asset === 'BTC');
  const group = lines.filter((l) => l.orderId === bought.orderId);
  expect(group.map((l) => l.kind).sort()).toEqual(['order_hold', 'order_release', 'trade']);

  await openActivity(page);
  await rows(page)
    .filter({ hasText: `+${bought.amount} BTC` })
    .getByRole('link')
    .click();
  await expect(page).toHaveURL(/\/money\/activity\//);
  const parts = page.getByRole('region', { name: 'Parts of this transaction' });
  await expect(parts.locator('tbody tr')).toHaveCount(group.length);
  // The reference every part shares: the order.
  await expect(parts).toContainText(`Order reference ${bought.orderId}`);
  for (const line of group)
    await expect(parts.locator('tbody')).toContainText(`${line.amount.replace(/0+$/, '').replace(/\.$/, '')} ${line.asset}`);
  await page.getByText('See BTC history').click();
  await expect(page).toHaveURL(/\/coin\/BTC/);
});

test(`${J} #5 opens Trades: one row per trade with price, total and fee, and partial fills grouped under their order and its type`, async ({
  page,
}) => {
  const who = account();
  const { partial } = run.read();
  if (!partial) throw new Error(`${J} #3 recorded no partly filled sale, so this step has no order to group fills under`);
  await signIn(page, who);
  const fills = (await (await api(who)).get('/api/v1/account/trades?limit=100')).body;
  const ofSale = fills.filter((f) => f.order === partial);
  await openActivity(page, '?tab=trades');
  const table = activity(page).locator('table[data-testid="dk-table"]');
  // Each fill is a row with its price, total and fee.
  await expect(table.locator('tbody tr[data-fill]')).toHaveCount(fills.length);
  // Each row shows the price, total and fee the service recorded for that fill, read in one pass and retried until the
  // rows settle.
  await expect
    .poll(async () => {
      const shown = Object.fromEntries(
        await table
          .locator('tbody tr[data-fill]')
          .evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-fill'), [...tr.querySelectorAll('td')].map((td) => td.innerText)])),
      );
      return fills.map((fill) => rowMismatch(fill, shown[fill.id])).filter(Boolean);
    })
    .toEqual([]);
  // One row per fill (the read above keys rows by fill id, so it would hide a repeat), and its fee cell names the
  // fee's currency or shows none.
  for (const fill of fills) {
    const row = table.locator(`tbody tr[data-fill="${fill.id}"]`);
    await expect(row, `fill ${fill.id}`).toHaveCount(1);
    await expect(row.locator('td').nth(4)).toContainText(fill.fee === null ? '—' : fill.fee.currency);
  }
  // The sale's fills sit together under one order row that names the order type.
  const order = table.locator(`tbody tr[data-order="${partial}"]`);
  await expect(order).toHaveCount(1);
  await expect(order).toContainText('Limit');
  await expect(order).toContainText(`${ofSale.length} fills`);
  await expect(table.locator(`tbody tr[data-fill][data-of="${partial}"]`)).toHaveCount(ofSale.length);
});

test(`${J} #6 adds a note to an entry and presses save twice: one note, shown on reload and in the notes filter`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const lines = await allLines(who);
  const funds = lines.find((l) => l.kind === 'welcome_funds');
  await openActivity(page);
  await rows(page).filter({ hasText: 'Welcome test funds' }).getByRole('link').click();
  const note = page.getByLabel('Your note');
  const save = page.locator('form[data-testid="money-note-form"]').first().getByRole('button');
  // Whitespace alone cannot be sent.
  await note.fill('   ');
  await expect(save).toBeDisabled();
  const sent = [];
  page.on('request', (r) => {
    if (r.url().includes('activity.note.set')) sent.push(r.postData());
  });
  await note.fill('TEST note: first funds');
  await save.dblclick();
  await expect(page.getByText('Note saved.')).toBeVisible();
  expect(sent.length).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Your note')).toHaveValue('TEST note: first funds');
  // The bank keeps one note on the line.
  const after = (await allLines(who)).find((l) => l.id === funds.id);
  expect(after.privateNote).toBe('TEST note: first funds');

  await openActivity(page);
  const bar = page.getByRole('search', { name: 'Search activity' });
  await bar.getByText('Only lines with a note').click();
  await expect(bar.getByLabel('Only lines with a note')).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Welcome test funds');
});

test(`${J} #7 groups activity by tax effect: refused in words while the owner has not set what each type means`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  const refused = await bankRead(who, 'activity.taxEffects');
  expect(refused.status).toBe(412);
  expect(JSON.stringify(refused.body)).toContain('portfolio.tax_effect_map_unset');
  await openActivity(page);
  await page.getByRole('button', { name: 'Group by tax effect' }).click();
  const block = page.locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(block).toBeVisible();
  await expect(block).not.toContainText('portfolio.tax_effect_map_unset');
  // Nothing is shown as taxable while the map is blank, and the list stays.
  await expect(page.getByText(/taxable/i)).toHaveCount(0);
  await expect(rows(page)).not.toHaveCount(0);
});

test(`${J} #8 opens activity when it is empty, fails or is refused: a way forward, Try again, or words with a reference`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Refused: a new TEST account that is not verified yet is told so in words, with a reference and the way through.
  const fresh = await signUp(page, 'pf3e');
  await openActivity(page);
  const refused = activity(page).locator('[data-slot="state-block"][data-kind="refused"]');
  await expect(refused).toContainText('Verify your identity first');
  await expect(refused).toContainText(/Ref [A-Z]+-\d+/);
  await expect(refused.getByRole('link', { name: 'Verify now' }).or(refused.getByRole('button', { name: 'Verify now' }))).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  // Empty: once verified, with nothing yet, it is offered a way forward.
  await verify(page, fresh);
  await signIn(page, fresh);
  await openActivity(page);
  const empty = activity(page).locator('[data-slot="state-block"][data-kind="empty"]');
  await expect(empty).toContainText('No activity yet');
  await expect(empty.getByRole('link').or(empty.getByRole('button'))).not.toHaveCount(0);
  await signOutBrowser(page.context());

  const who = account();
  await signIn(page, who);
  await openActivity(page);
  await expect(rows(page).filter({ hasText: 'Welcome test funds' })).toHaveCount(1);
  const all = await rows(page).count();
  // Failed: with the bank stopped the list says so and offers Try again; once it is back, Try again shows the rows.
  try {
    tool('local-test-stack.mjs', 'stop', 'bank');
    await openActivity(page);
    const failed = activity(page).locator('[data-slot="state-block"][data-kind="error"]');
    await expect(failed).toContainText('Couldn’t load your activity.', { timeout: 30_000 });
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'bank');
  }
  await activity(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(all, { timeout: 30_000 });
});
