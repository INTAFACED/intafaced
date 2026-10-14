import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Exchange, scaled } from '../desk.fixtures.mjs';

const shots = process.env.TICKET_SHOTS ?? join(tmpdir(), 'intafaced-ticket-shots');
mkdirSync(shots, { recursive: true });
const USER = '00000000-0000-4000-8000-000000000001';
const PAIR = '/trade/spot/BTC-USDT';

/** The desk's exchange stand-in plus the two doors ticket v2 uses: POST /orders/batch and DELETE /orders. */
class TicketExchange extends Exchange {
  constructor() {
    super();
    // 'ok' | 'abort' (all taken, answer lost) | 'lose' (none arrived, answer lost) | { refuse: [indexes] } | { unknown: [indexes] }
    // | { turnedAway: 429 } (the whole request is refused before any order is looked at)
    this.opts.batchMode = 'ok';
    this.opts.cancelAllMode = 'ok'; // 'ok' | 'abort' (cancelled, answer lost)
  }
  wireOrder(draft, extra) {
    return super.wireOrder(draft, { postOnly: draft.postOnly === true, ...extra });
  }
  /** Like the engine: a post-only order that would cross the book is rejected, though the request itself succeeds. */
  commit(draft) {
    if (draft.postOnly && draft.type === 'limit') {
      const price = scaled(draft.price);
      const crosses = draft.side === 'buy' ? price >= scaled(this.opts.book.asks[0][0]) : price <= scaled(this.opts.book.bids[0][0]);
      const existing = [...this.open, ...this.closed].find((order) => order.clientOrderId === draft.clientOrderId);
      if (existing) return existing;
      if (crosses) {
        const order = this.wireOrder(draft, { status: 'rejected' });
        this.closed.unshift(order);
        return order;
      }
    }
    return super.commit(draft);
  }
  handle(request) {
    const { method, path, body, query } = request;
    const json = (value, status = 200) => ({ status, json: value });
    if (path === 'orders/batch' && method === 'POST') {
      this.requests.push({ method, path, body });
      const mode = this.opts.batchMode;
      if (mode === 'lose') return 'abort';
      if (typeof mode === 'object' && mode.turnedAway)
        return json(
          { statusCode: mode.turnedAway, code: 'rate_limited', error: 'Too Many Requests', message: 'slow down' },
          mode.turnedAway,
        );
      if (mode === 'abort') {
        for (const draft of body.orders) this.commit(draft);
        return 'abort';
      }
      const refuse = typeof mode === 'object' && mode.refuse ? mode.refuse : [];
      const unknown = typeof mode === 'object' && mode.unknown ? mode.unknown : [];
      const results = body.orders.map((draft, index) => {
        const base = { index, clientOrderId: draft.clientOrderId };
        if (refuse.includes(index))
          return {
            ...base,
            status: 'refused',
            error: { code: 'InvalidOrder', message: 'raw words', intafacedCode: 'trade.invalid_price' },
          };
        if (unknown.includes(index))
          return { ...base, status: 'unknown', error: { code: 'ExchangeError', intafacedCode: 'trade.batch_outcome_unknown' } };
        return { ...base, status: 'success', order: this.commit(draft) };
      });
      return json({ results });
    }
    if (path === 'orders' && method === 'DELETE') {
      this.requests.push({ method, path, body, query });
      const scope = query?.symbol;
      const mine = this.open.filter((order) => scope === undefined || order.symbol === scope);
      const out = [];
      for (const order of mine) {
        this.open.splice(this.open.indexOf(order), 1);
        const cancelled = { ...order, status: 'canceled' };
        this.closed.unshift(cancelled);
        this.releaseHold(order);
        out.push(cancelled);
      }
      if (this.opts.cancelAllMode === 'abort') return 'abort';
      return json(out);
    }
    return super.handle(request);
  }
  /** An order already resting in the book, as if placed earlier. */
  seed(symbol, price, amount) {
    const order = this.wireOrder(
      { symbol, side: 'buy', type: 'limit', amount, price, timeInForce: 'GTC', postOnly: false, clientOrderId: `seed-${this.nextId}` },
      {},
    );
    this.open.unshift(order);
    return order;
  }
}

async function mount(page, exchange = new TicketExchange(), { hold = [], url = PAIR } = {}) {
  const held = new Set(hold);
  const waiting = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on(
    'console',
    (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && errors.push(message.text()),
  );
  const answer = async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const path = target.pathname.replace(/^\/api\/v1\//, '');
    const result = exchange.handle({
      method: request.method(),
      path,
      query: Object.fromEntries(target.searchParams),
      body:
        request.method() === 'GET' || request.method() === 'DELETE'
          ? undefined
          : request.postData() === null
            ? null
            : request.postDataJSON(),
      headers: request.headers(),
    });
    if (result === 'abort') return route.abort('connectionreset');
    return route.fulfill(result);
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1\//, '');
    if (held.has(path.split('/')[0])) return void waiting.push(route);
    return answer(route);
  });
  await page.goto(url);
  return {
    exchange,
    errors,
    release: async () => {
      held.clear();
      for (const route of waiting.splice(0)) await answer(route);
    },
    requests: (method, path) => exchange.requests.filter((r) => r.method === method && r.path === path),
  };
}
const ready = async (page) => {
  await page.locator('.dk-ticker .dk-pair').waitFor();
  await page.locator('.dk-bk-row[data-side="bid"]').first().waitFor();
};
const shot = async (page, name, { full = false } = {}) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
};
const buyForm = (page) => page.locator('form.dk-form[data-side="buy"]');
const sellForm = (page) => page.locator('form.dk-form[data-side="sell"]');
const field = (form, name) => form.getByRole('textbox', { name, exact: true });
const slot = (page) => page.evaluate((id) => localStorage.getItem(`trade-pending:${id}`), USER);
const scaleMarker = (page) => page.evaluate((id) => localStorage.getItem(`trade-scale:${id}`), USER);
const itemName = (name) => new RegExp(`^${name.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')}\\s*Preview$`);
const forbidden = /trade\.|ledger\.|undefined|NaN|\[object|Failed to fetch|raw words/;

async function fillScale(page, { from = '64000', to = '64400', count = '5', total = '0.001' } = {}) {
  await page.getByRole('tab', { name: 'Scale' }).click();
  const form = buyForm(page);
  await field(form, 'First price').fill(from);
  await field(form, 'Last price').fill(to);
  await field(form, 'Number of orders').fill(count);
  await field(form, 'Total amount').fill(total);
  return form;
}

test('time in force and post-only: tooltips, IOC locks post-only, the review and the order carry the choice', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const form = buyForm(page);
  await expect(form.getByText('Time in force')).toBeVisible();
  await expect(form.getByLabel('Time in force').first()).toBeVisible();
  // One-line tooltips for both choices (also in the page for screen readers).
  await expect(form.locator('.tk-sr').first()).toHaveText('Stays open until it fills or you cancel it.');
  await form.getByRole('button', { name: 'About time in force' }).hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText('Stays open until it fills or you cancel it.');
  await shot(page, 'ticket-limit-options');

  await field(form, 'Price').fill('63999.9');
  await field(form, 'Amount').fill('0.0001');
  // Post-only on, then IOC: post-only switches off and locks, with the reason.
  await form.getByRole('switch', { name: 'Post-only' }).click();
  await expect(form.getByRole('switch', { name: 'Post-only' })).toBeChecked();
  await form.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: 'Immediate or cancel' }).click();
  await expect(form.getByRole('switch', { name: 'Post-only' })).not.toBeChecked();
  await expect(form.getByRole('switch', { name: 'Post-only' })).toBeDisabled();
  await expect(form.locator('.tk-sr').nth(1)).toHaveText('Post-only works with Good till cancelled only.');
  await expect(form.getByRole('button', { name: 'Buy BTC' })).toBeEnabled();
  await form.getByRole('button', { name: 'Buy BTC' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Time in force');
  await expect(dialog).toContainText('Immediate or cancel');
  await shot(page, 'ticket-review-ioc');
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(dialog).toHaveCount(0);
  const ioc = m.requests('POST', 'orders')[0].body;
  expect(ioc).toMatchObject({ timeInForce: 'IOC', postOnly: false, type: 'limit' });
  expect(m.requests('POST', 'orders/preview').every((r) => r.body.timeInForce === 'IOC' || r.body.timeInForce === 'GTC')).toBe(true);

  // Post-only with GTC: the review says so and the order carries postOnly.
  await form.getByRole('combobox', { name: 'Time in force' }).click();
  await page.getByRole('option', { name: 'Good till cancelled' }).click();
  await form.getByRole('switch', { name: 'Post-only' }).click();
  await field(form, 'Price').fill('63990');
  await field(form, 'Amount').fill('0.0001');
  await form.getByRole('button', { name: 'Buy BTC' }).click();
  await expect(dialog).toContainText('Post-only');
  await expect(dialog).toContainText('On');
  await dialog.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(dialog).toHaveCount(0);
  const po = m.requests('POST', 'orders')[1].body;
  expect(po).toMatchObject({ timeInForce: 'GTC', postOnly: true, price: '63990' });
  const resting = m.exchange.open.find((order) => order.price === '63990');
  expect(resting.postOnly).toBe(true);

  // A market order has no such choices and keeps GTC / not post-only.
  await page.getByRole('tab', { name: 'Market' }).click();
  await expect(buyForm(page).getByText('Time in force')).toHaveCount(0);
  expect(m.errors).toEqual([]);
});

test('scale order: the exact list, total held and total fee are shown first; one batch; every order is reported', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const form = await fillScale(page);
  // The plan is visible while typing: 5 orders, 64,000 to 64,400 in equal steps, even sizes adding up to the total.
  await expect(form.locator('.tk-plan tbody tr')).toHaveCount(5);
  await expect(form.locator('.tk-plan tbody tr').first()).toContainText('64,000.00');
  await expect(form.locator('.tk-plan tbody tr').last()).toContainText('64,400.00');
  await expect(form.locator('.tk-plan')).toContainText('0.0002');
  await expect(form.locator('.tk-plan')).toContainText('64.2'); // total value: 0.0002 x (64,000 + 64,100 + 64,200 + 64,300 + 64,400)
  await shot(page, 'ticket-scale-filled');
  expect(m.requests('POST', 'orders/preview')).toHaveLength(0); // typing asks nothing

  await form.getByRole('button', { name: 'Review buy orders' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Review 5 buy orders');
  await expect(dialog.locator('.tk-list tbody tr')).toHaveCount(5);
  await expect(dialog).toContainText('Total amount');
  await expect(dialog).toContainText('0.001 BTC');
  await expect(dialog).toContainText('Total held');
  await expect(dialog).toContainText('Total fee');
  await expect(dialog).toContainText('up to 0.10%');
  // The totals are the sum of the service's own answers for the five orders.
  const holds = m.requests('POST', 'orders/preview').map((r) => m.exchange.preview(r.body));
  expect(holds).toHaveLength(5);
  expect(m.requests('POST', 'orders/batch')).toHaveLength(0); // nothing is sent until the click
  await shot(page, 'ticket-scale-review');
  await dialog.getByRole('button', { name: 'Place 5 buy orders' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(form).toContainText('All 5 orders are in.');
  expect(m.requests('POST', 'orders/batch')).toHaveLength(1);
  expect(m.requests('POST', 'orders')).toHaveLength(0);
  const sent = m.requests('POST', 'orders/batch')[0].body.orders;
  expect(sent.map((o) => o.price)).toEqual(['64000', '64100', '64200', '64300', '64400']);
  expect(sent.every((o) => o.amount === '0.0002' && o.type === 'limit' && o.timeInForce === 'GTC' && o.postOnly === false)).toBe(true);
  expect(new Set(sent.map((o) => o.clientOrderId)).size).toBe(5);
  expect(sent.every((o) => /^desk:scale:[0-9a-f-]{36}:\d+$/.test(o.clientOrderId) && o.clientOrderId.length <= 64)).toBe(true);
  expect(await slot(page)).toBeNull();
  expect(await scaleMarker(page)).toBeNull();
  await shot(page, 'ticket-scale-done');
  await expect(page.locator('.dk-bottom-body tbody tr')).toHaveCount(5);
  expect(await page.locator('main').innerText()).not.toMatch(forbidden);
  expect(m.errors).toEqual([]);
});

test('scale order: the service refuses one order; the others stay in and the screen says which', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.batchMode = { refuse: [1] };
  const m = await mount(page, exchange);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place 5 buy orders' }).click();
  await expect(form).toContainText('4 of 5 orders are in.');
  await expect(form).toContainText('1 were refused.');
  await expect(form.locator('.dk-note tbody tr').nth(1)).not.toContainText('In');
  await shot(page, 'ticket-scale-partial');
  expect(await slot(page)).toBeNull(); // every order's outcome is known, so the slot is free
  expect(await form.innerText()).not.toMatch(forbidden);
  expect(m.errors).toEqual([]);
});

test('scale order: a lost answer where the orders DID arrive is found by their own numbers, never sent again', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.batchMode = 'abort';
  const m = await mount(page, exchange);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place 5 buy orders' }).click();
  // The answer is lost, so the account is held until the lookup finds all five.
  await expect.poll(() => m.requests('POST', 'orders/batch').length).toBe(1);
  await expect.poll(async () => (await slot(page)) === null && m.requests('GET', 'orders/open').length > 1, { timeout: 15000 }).toBe(true);
  expect(await scaleMarker(page)).toBeNull();
  expect(m.requests('POST', 'orders/batch')).toHaveLength(1); // never sent a second time by itself
  await expect(page.locator('.dk-bottom-body tbody tr')).toHaveCount(5);
  expect(m.errors).toEqual([]);
});

test('scale order: a lost answer where nothing arrived blocks new orders, then the missing ones are sent again once, under the same numbers', async ({
  page,
}) => {
  const exchange = new TicketExchange();
  exchange.opts.batchMode = 'lose';
  const m = await mount(page, exchange);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place 5 buy orders' }).click();
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toBeVisible();
  await expect(note).toContainText('5 orders are not confirmed yet');
  expect(await slot(page)).toContain('scale:');
  expect(await scaleMarker(page)).not.toBeNull();
  await shot(page, 'ticket-scale-recovery');
  // New orders wait: Buy on the Limit tab cannot be pressed.
  await page.getByRole('tab', { name: 'Limit' }).click();
  await field(buyForm(page), 'Price').fill('63999.9');
  await field(buyForm(page), 'Amount').fill('0.0001');
  await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Scale' }).click();

  m.exchange.opts.batchMode = 'ok';
  const before = m.requests('POST', 'orders/batch')[0].body.orders.map((o) => o.clientOrderId);
  await note.getByRole('button', { name: 'Send the missing again' }).click();
  await expect.poll(() => slot(page), { timeout: 15000 }).toBeNull();
  expect(await scaleMarker(page)).toBeNull();
  const again = m.requests('POST', 'orders/batch')[1].body.orders.map((o) => o.clientOrderId);
  expect(again).toEqual(before); // the same numbers, so an order that had arrived could never be doubled
  expect(m.exchange.open.length).toBe(5);
  expect(m.errors).toEqual([]);
});

test('scale order: the service changing its numbers at confirm shows the new totals and sends nothing', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Review 5 buy orders');
  m.exchange.opts.feeBps = 20n; // the fee changes between the review and the click
  await dialog.getByRole('button', { name: 'Place 5 buy orders' }).click();
  await expect(dialog).toContainText('Nothing was sent.');
  await expect(dialog).toContainText('up to 0.20%');
  expect(m.requests('POST', 'orders/batch')).toHaveLength(0);
  expect(await slot(page)).toBeNull();
  await shot(page, 'ticket-scale-changed');
  await dialog.getByRole('button', { name: 'Place 5 buy orders' }).click();
  await expect(form).toContainText('All 5 orders are in.');
  expect(m.requests('POST', 'orders/batch')).toHaveLength(1);
});

test('scale order: bad input is explained in words and nothing is asked or sent; a refused order stops the review', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const form = await fillScale(page, { from: '64000', to: '64000.01', count: '5', total: '0.001' });
  await expect(form).toContainText('The range is too narrow for 5 orders');
  await expect(form.getByRole('button', { name: 'Review buy orders' })).toBeDisabled();
  await field(form, 'Last price').fill('64400');
  await field(form, 'Number of orders').fill('1');
  await expect(form).toContainText('Enter a whole number of orders from 2 to 20');
  await field(form, 'Number of orders').fill('5');
  await field(form, 'Total amount').fill('0.00004');
  await expect(form).toContainText('too small');
  await field(form, 'Total amount').fill('1'); // 64,000 USDT of buys against a 4,100 balance
  await expect(form).toContainText('You don’t have enough USDT for all of these orders.');
  await expect(form.getByRole('button', { name: 'Review buy orders' })).toBeDisabled();
  await shot(page, 'ticket-scale-error');
  expect(m.requests('POST', 'orders/preview')).toHaveLength(0);
  expect(m.requests('POST', 'orders/batch')).toHaveLength(0);

  // The service refusing an order in the review stops everything, in words.
  m.exchange.opts.refusal = { code: 'tier.insufficient', message: 'raw words from the service' };
  await field(form, 'Total amount').fill('0.001');
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await expect(form.locator('.dk-note--bad')).toContainText('Verify your identity first');
  await expect(form).toContainText('Nothing was sent.');
  expect(m.requests('POST', 'orders/batch')).toHaveLength(0);
  expect(await form.innerText()).not.toMatch(forbidden);
});

test('scale order: weighted sizes, post-only, and a warning for orders that would fill at once', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const form = await fillScale(page, { from: '64990', to: '65010', count: '3', total: '0.0006' });
  await form.getByRole('button', { name: 'Weighted' }).click();
  await expect(form.locator('.tk-plan tbody tr').nth(0)).toContainText('0.0001');
  await expect(form.locator('.tk-plan tbody tr').nth(1)).toContainText('0.0002');
  await expect(form.locator('.tk-plan tbody tr').nth(2)).toContainText('0.0003');
  await form.getByRole('switch', { name: 'Post-only' }).click();
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('would fill right away, so post-only will refuse them');
  await shot(page, 'ticket-scale-weighted-warning');
  await dialog.getByRole('button', { name: 'Place 3 buy orders' }).click();
  // The engine turns the crossing order down: the request succeeded, the order was NOT placed. It must not read "In".
  await expect(form).toContainText('2 of 3 orders are in.');
  await expect(form).not.toContainText('All 3 orders are in');
  await expect(form).toContainText('1 were rejected by the market');
  await expect(form.locator('.dk-note tbody tr').nth(2)).toContainText('Refused: would have filled at once');
  await expect(form.locator('.dk-note tbody tr').nth(0)).toContainText('In');
  await shot(page, 'ticket-scale-post-only-rejected');
  expect(await slot(page)).toBeNull(); // the rejected order's outcome is known, so nothing is left in doubt
  const sent = m.requests('POST', 'orders/batch')[0].body.orders;
  expect(sent.map((o) => o.amount)).toEqual(['0.0001', '0.0002', '0.0003']);
  expect(sent.every((o) => o.postOnly === true)).toBe(true);
});

test('Advanced: every type is a Preview; submitting shows "nothing was sent" and never reaches the service', async ({ page }) => {
  const m = await mount(page);
  await ready(page);
  const before = m.exchange.requests.length;
  await page.getByRole('tab', { name: 'Advanced order types' }).click();
  const names = ['Stop', 'Stop-limit', 'TP/SL', 'Trailing stop', 'OCO', 'Iceberg', 'TWAP'];
  for (const name of names) await expect(page.getByRole('menuitem', { name: itemName(name) })).toBeVisible();
  await shot(page, 'ticket-advanced-menu');
  await page.getByRole('menuitem', { name: itemName('Stop-limit') }).click();
  const form = buyForm(page);
  await expect(page.locator('.tk-preview')).toContainText('Preview only');
  await expect(page.locator('.tk-preview .tk-chip').first()).toHaveText('Preview');
  await field(form, 'Trigger price').fill('60000');
  await field(form, 'Limit price').fill('59900');
  await field(form, 'Amount').fill('0.001');
  await shot(page, 'ticket-advanced-stop-limit');
  await form.getByRole('button', { name: 'Preview buy BTC' }).click();
  const sheet = page.getByRole('alertdialog');
  await expect(sheet).toContainText('Preview: this order type isn’t live yet');
  await expect(sheet).toContainText('Nothing was sent.');
  await shot(page, 'ticket-advanced-sheet');
  await sheet.getByRole('button', { name: 'Got it' }).click();
  await expect(sheet).toHaveCount(0);
  // Walk every type: the form is there and submit only opens the sheet.
  for (const name of names) {
    await page.getByRole('tab', { name: 'Advanced order types' }).click();
    await page.getByRole('menuitem', { name: itemName(name) }).click();
    await sellForm(page).getByRole('button', { name: 'Preview sell BTC' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Nothing was sent.');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Got it' }).click();
  }
  // Not one request about an order: no preview, no place, no batch.
  const orderCalls = m.exchange.requests.slice(before).filter((r) => r.method !== 'GET' || /orders\/(preview|batch)/.test(r.path));
  expect(orderCalls).toEqual([]);
  expect(await slot(page)).toBeNull();
  expect(m.errors).toEqual([]);
});

test('Cancel all: this market or all markets, behind a confirmation that counts the orders', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.seed('BTC/USDT', '60000', '0.0002');
  exchange.seed('BTC/USDT', '60100', '0.0002');
  exchange.seed('ETH/USDT', '3000', '0.01');
  const m = await mount(page, exchange);
  await ready(page);
  const rows = page.locator('.dk-bottom-body tbody tr');
  await expect(rows).toHaveCount(3);
  await shot(page, 'ticket-orders-cancel-all-button');
  await page.getByRole('button', { name: 'Cancel all open orders' }).click();
  await expect(page.getByRole('menuitem', { name: /This market \(BTC\/USDT\)/ })).toContainText('2 open');
  await expect(page.getByRole('menuitem', { name: /All markets/ })).toContainText('3 open');
  await page.getByRole('menuitem', { name: /This market/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Cancel 2 open orders?');
  await expect(dialog).toContainText('Every open order in BTC/USDT');
  await shot(page, 'ticket-cancel-all-market');
  await dialog.getByRole('button', { name: 'Keep my orders' }).click();
  expect(m.requests('DELETE', 'orders')).toHaveLength(0); // nothing without the confirmation
  await page.getByRole('button', { name: 'Cancel all open orders' }).click();
  await page.getByRole('menuitem', { name: /This market/ }).click();
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(page.locator('.tk-cancelall-note')).toHaveText('2 orders cancelled.');
  expect(m.requests('DELETE', 'orders')).toHaveLength(1);
  expect(m.requests('DELETE', 'orders')[0].query).toEqual({ symbol: 'BTC/USDT' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('ETH/USDT');

  await page.getByRole('button', { name: 'Cancel all open orders' }).click();
  await expect(page.getByRole('menuitem', { name: /This market/ })).toBeDisabled();
  await page.getByRole('menuitem', { name: /All markets/ }).click();
  await expect(dialog).toContainText('Cancel 1 open order?');
  await expect(dialog).toContainText('ETH/USDT: 1');
  await dialog.getByRole('button', { name: 'Cancel orders' }).click();
  await expect(page.locator('.tk-cancelall-note')).toHaveText('1 order cancelled.');
  expect(m.requests('DELETE', 'orders')[1].query).toEqual({});
  await expect(page.getByText('No open orders.')).toBeVisible();
  expect(m.errors).toEqual([]);
});

test('Cancel all: a lost answer says "not sure" and reads Open orders again; empty list has no button', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.cancelAllMode = 'abort';
  exchange.seed('BTC/USDT', '60000', '0.0002');
  const m = await mount(page, exchange);
  await ready(page);
  await page.getByRole('button', { name: 'Cancel all open orders' }).click();
  await page.getByRole('menuitem', { name: /All markets/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel orders' }).click();
  await expect(page.locator('.tk-cancelall-note')).toContainText('couldn’t confirm every cancel');
  await shot(page, 'ticket-cancel-all-unsure');
  expect(m.requests('DELETE', 'orders')).toHaveLength(1);
  await expect(page.getByText('No open orders.')).toBeVisible(); // the refreshed list is the truth
  await expect(page.getByRole('button', { name: 'Cancel all open orders' })).toHaveCount(0);
  await shot(page, 'ticket-orders-empty');
});

test('states: loading balances, signed out, market closed', async ({ page, browser }) => {
  const m = await mount(page, new TicketExchange(), { hold: ['account'] });
  await page.locator('.dk-ticker .dk-pair').waitFor();
  await page.getByRole('tab', { name: 'Scale' }).click();
  await expect(page.locator('.dk-order [aria-busy="true"]')).toBeVisible();
  await shot(page, 'ticket-scale-loading');
  await m.release();
  await expect(buyForm(page)).toBeVisible();

  const out = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await mount(out, new TicketExchange(), { url: `${PAIR}?signedout=1` });
  await out.locator('.dk-ticker .dk-pair').waitFor();
  await out.getByRole('tab', { name: 'Scale' }).click();
  await expect(out.getByRole('link', { name: 'Log in to trade' }).first()).toBeVisible();
  await shot(out, 'ticket-scale-signed-out');
  await out.context().close();
});

test('recovery: a re-send the service turns away (rate limit, sign-in, kill switch) never clears the block', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.batchMode = 'lose';
  const m = await mount(page, exchange);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place 5 buy orders' }).click();
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toContainText('5 orders are not confirmed yet');
  // The first batch may have gone in. The re-send is turned away.
  m.exchange.opts.batchMode = { turnedAway: 429 };
  await note.getByRole('button', { name: 'Send the missing again' }).click();
  await expect(note).toContainText('nothing was cleared');
  await expect(note).not.toContainText('accounted for');
  expect(await slot(page)).toContain('scale:');
  expect(JSON.parse(await scaleMarker(page)).drafts).toHaveLength(5);
  await shot(page, 'ticket-scale-recovery-resend-refused');
  // New orders still wait.
  await page.getByRole('tab', { name: 'Limit' }).click();
  await field(buyForm(page), 'Price').fill('63999.9');
  await field(buyForm(page), 'Amount').fill('0.0001');
  await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Scale' }).click();
  // Only when the orders are really accepted again does the block clear.
  m.exchange.opts.batchMode = 'ok';
  await note.getByRole('button', { name: 'Send the missing again' }).click();
  await expect.poll(() => slot(page), { timeout: 15000 }).toBeNull();
  expect(m.exchange.open).toHaveLength(5);
});

test('recovery: orders refused on the re-send clear only after a lookup finds nothing, and say they were refused', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.batchMode = 'lose';
  const m = await mount(page, exchange);
  await ready(page);
  const form = await fillScale(page);
  await form.getByRole('button', { name: 'Review buy orders' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Place 5 buy orders' }).click();
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toBeVisible();
  m.exchange.opts.batchMode = { refuse: [0, 1, 2, 3, 4] };
  const before = m.requests('GET', 'orders/open').length;
  await note.getByRole('button', { name: 'Send the missing again' }).click();
  await expect.poll(() => slot(page), { timeout: 15000 }).toBeNull();
  expect(m.requests('GET', 'orders/open').length).toBeGreaterThan(before); // the lookup ran
  await expect(page.getByText('5 orders were refused and are not placed.')).toBeVisible();
  await expect(page.getByText('All orders are accounted for.')).toHaveCount(0);
});

const seedSlot = async (page, { startedAt, batch = 'abc' }) => {
  await page.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [`trade-pending:${USER}`, JSON.stringify({ kind: 'place', symbol: 'BTC/USDT', id: `scale:${batch}`, startedAt })],
  );
};
const scaleOrder = (exchange, batch, n, patch = {}) =>
  exchange.wireOrder(
    {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '0.0002',
      price: String(60000 + n),
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: `desk:scale:${batch}:${n}`,
    },
    patch,
  );

test('recovery without a saved list: the batch is looked up by its number in Open orders AND Order history, and clearing waits', async ({
  page,
}) => {
  const exchange = new TicketExchange();
  // One order still resting, one that filled (it is only in history), one from another batch.
  exchange.open.push(scaleOrder(exchange, 'abc', 0));
  exchange.closed.push(scaleOrder(exchange, 'abc', 1, { status: 'closed', filled: '0.0002', remaining: '0' }));
  exchange.open.push(scaleOrder(exchange, 'zzz', 0));
  await seedSlot(page, { startedAt: Date.now() - 5000 });
  const m = await mount(page, exchange);
  await ready(page);
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toContainText('2 orders of this batch were found');
  await expect(note.locator('tbody tr')).toHaveCount(2);
  await expect(note).toContainText('Filled');
  await expect(note).toContainText('In');
  expect(m.requests('GET', 'orders/closed').length).toBeGreaterThan(0);
  const clear = note.getByRole('button', { name: /clear this/ });
  await expect(clear).toBeDisabled(); // looked up, but sent only seconds ago
  await expect(note).toContainText('You can clear this in');
  await shot(page, 'ticket-scale-recovery-no-list');
  expect(await slot(page)).toContain('scale:abc');
});

test('recovery without a saved list: after the wait and a successful lookup, clearing frees the account', async ({ page }) => {
  const exchange = new TicketExchange();
  await seedSlot(page, { startedAt: Date.now() - 5 * 60_000 });
  await mount(page, exchange);
  await ready(page);
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toContainText('No order of this batch was found');
  const clear = note.getByRole('button', { name: /clear this/ });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(note).toHaveCount(0);
  expect(await slot(page)).toBeNull();
});

test('recovery without a saved list: a failed lookup never allows clearing, however long ago it was sent', async ({ page }) => {
  const exchange = new TicketExchange();
  exchange.opts.fail = { orders: 500 };
  await seedSlot(page, { startedAt: Date.now() - 60 * 60_000 });
  await mount(page, exchange);
  await page.locator('.dk-ticker .dk-pair').waitFor();
  const note = page.locator('.dk-note--warn', { hasText: 'Checking your scale orders' });
  await expect(note).toContainText('couldn’t look up your orders');
  await expect(note.getByRole('button', { name: /clear this/ })).toBeDisabled();
  await shot(page, 'ticket-scale-recovery-lookup-failed');
  expect(await slot(page)).toContain('scale:abc');
});
