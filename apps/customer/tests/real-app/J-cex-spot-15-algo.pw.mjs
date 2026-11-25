// World: book, market
import { test, expect } from './journey.mjs';
import { bestPrices, fund, journeyState, toUnits } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-cex-spot-15 #6, in the running app (docs/roadmap/journeys.json): a developer's bot places an algo order through the
// algo order API (/api/v1/algo/orders), amends it, cancels it and queries it, and every answer carries one of the states
// /developers/order-types documents. The start is made once, as TEST setup: a verified TEST account with a passkey and
// TEST 2000 USDT makes a live Trade key; from then on every call goes straight to Edge with that key. The order is a
// TWAP on the TEST BTC/USDT book whose trigger price sits far above the book, so it waits and places nothing: no fill,
// no hold, and the balance reads the same before and after. Every figure is TEST.
const J = 'J-cex-spot-15';
const run = journeyState(`${J}-algo-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');
/** The states the algo order API answers, in the order the developer page lists them (SP-conditional-algo-04). */
const DOCUMENTED = ['live', 'effective', 'partially_effective', 'canceled', 'order_failed'];

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 15_000 });

/** TEST setup, not a journey step (the journey's Starts): a verified passkey account with TEST USDT and a live Trade key. */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().key) return;
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'cs15g');
  try {
    expect(fund(who.email, 'USDT', '2000').tx).toBeTruthy();
    const key = await makeKey(page, { name: 'algo-bot' });
    expect(key).toBeTruthy();
    run.reset({ who, key });
  } finally {
    await page.context().close();
  }
});

function key() {
  const k = run.read().key;
  if (!k) throw new Error(`${J}'s TEST setup made no key, so there is no bot`);
  return k;
}

const call = (method, path, body) => withKey(key(), { method, path, body });
const said = (res) => JSON.stringify(res.body).slice(0, 300);

/** The key holder's USDT, from the API's own balance read: total and free. */
async function usdt() {
  const res = await call('GET', '/api/v1/account/balance');
  expect(res.status, said(res)).toBe(200);
  const row = res.body.balances?.USDT ?? {};
  return { total: row.total ?? '0', free: row.free ?? '0' };
}

test(`${J} #6 places an algo order through the algo API: created, amended, cancelled and queried with documented states`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const before = await usdt();
  expect(toUnits(before.total), 'the TEST setup funded USDT').toBeGreaterThan(0n);
  // A buy whose trigger price is twice today's TEST ask: it waits, placing nothing, for as long as this step runs. Its
  // limit sits 1% over the trigger, as a trigger parent's slice band is measured from its trigger.
  const { ask } = await bestPrices();
  const trigger = (toUnits(ask) * 2n) / ONE;
  const body = {
    kind: 'twap',
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.0012',
    durationMs: 3_600_000,
    sliceIntervalMs: 600_000,
    triggerPrice: String(trigger),
    limitPrice: String((trigger * 101n) / 100n + 1n),
    clientAlgoId: `${J}-6-${Date.now().toString(36)}`,
  };

  // Created: the order, waiting for its trigger, state live.
  const made = await call('POST', '/api/v1/algo/orders', body);
  expect(made.status, said(made)).toBe(200);
  const id = made.body.id;
  run.write({ algoId: id });
  try {
    expect(made.body).toMatchObject({
      kind: 'twap',
      side: 'buy',
      totalQty: '0.0012',
      triggerPrice: body.triggerPrice,
      awaitingTrigger: true,
      childrenEmitted: 0,
      state: 'live',
    });
    expect(made.body.filledQty).toMatch(/^0(\.0+)?$/);
    // The same client algo id again answers the same order: one order, not two.
    const again = await call('POST', '/api/v1/algo/orders', body);
    expect(again.status, said(again)).toBe(200);
    expect(again.body.id).toBe(id);

    // Amended: the quantity down, then the trigger moved while it waits. A larger quantity is refused by name and
    // changes nothing.
    const lower = await call('PATCH', `/api/v1/algo/orders/${id}`, { totalQty: '0.0006' });
    expect(lower.status, said(lower)).toBe(200);
    expect(lower.body).toMatchObject({ id, totalQty: '0.0006', state: 'live', awaitingTrigger: true });
    const up = await call('PATCH', `/api/v1/algo/orders/${id}`, { totalQty: '0.0024' });
    expect(up.status, said(up)).toBe(400);
    expect(up.body.intafacedCode).toBe('trade.amend_qty_up');
    const moved = String(trigger - 1n);
    const retrigger = await call('PATCH', `/api/v1/algo/orders/${id}`, { triggerPrice: moved });
    expect(retrigger.status, said(retrigger)).toBe(200);
    expect(retrigger.body).toMatchObject({ id, triggerPrice: moved, totalQty: '0.0006', state: 'live' });

    // Queried: the order as amended, still waiting, nothing placed or filled.
    const read = await call('GET', `/api/v1/algo/orders/${id}`);
    expect(read.status, said(read)).toBe(200);
    expect(read.body).toMatchObject({
      id,
      totalQty: '0.0006',
      triggerPrice: moved,
      awaitingTrigger: true,
      childrenEmitted: 0,
      status: 'active',
      state: 'live',
    });
    expect(read.body.filledQty).toMatch(/^0(\.0+)?$/);

    // Cancelled: the answer and the read both say canceled; an amend after it is refused by state.
    const cancelled = await call('DELETE', `/api/v1/algo/orders/${id}`);
    expect(cancelled.status, said(cancelled)).toBe(200);
    expect(cancelled.body).toMatchObject({ id, status: 'cancelled', state: 'canceled' });
    const after = await call('GET', `/api/v1/algo/orders/${id}`);
    expect(after.status, said(after)).toBe(200);
    expect(after.body).toMatchObject({ id, status: 'cancelled', state: 'canceled', childrenEmitted: 0 });
    const late = await call('PATCH', `/api/v1/algo/orders/${id}`, { totalQty: '0.0003' });
    expect(late.status, said(late)).toBe(409);
    expect(late.body.intafacedCode).toBe('trade.algo_bad_state');

    // The order never traded: the USDT balance reads as it did before it was placed.
    expect(await usdt()).toEqual(before);

    // Documented states: the developer page lists the states the API answers, each with what it means, and every state
    // this order passed through is one of them.
    await page.goto('/developers');
    await page.getByRole('main').getByRole('link', { name: 'Order types', exact: true }).click();
    await expect(page).toHaveURL(/\/developers\/order-types$/);
    const states = page.getByTestId('algo-order-states');
    await expect(states.getByRole('heading', { name: 'Algo orders', exact: true })).toBeVisible();
    const rows = states.locator('tbody tr');
    await expect(rows).toHaveCount(DOCUMENTED.length);
    expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-state')))).toEqual(DOCUMENTED);
    for (const seen of [made.body.state, lower.body.state, read.body.state, cancelled.body.state]) expect(DOCUMENTED).toContain(seen);
    await expect(states.locator('tr[data-state="live"]')).toContainText('Running, paused or waiting for its trigger price.');
    await expect(states.locator('tr[data-state="canceled"]')).toContainText('Cancelled: no new slices are placed.');
    await expect(states).toContainText('trade.amend_qty_up');
    await states.scrollIntoViewIfNeeded();
    await stepPicture();
  } finally {
    // Pass or fail, no schedule is left waiting; a second cancel of a cancelled order changes nothing.
    await call('DELETE', `/api/v1/algo/orders/${id}`).catch(() => {});
  }
});
