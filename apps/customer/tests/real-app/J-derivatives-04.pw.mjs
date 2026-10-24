import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, fromUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-04, in the running app (docs/roadmap/journeys.json): manage futures orders in the orders room. One test
// per step, titled "J-derivatives-04 #<n>", run in order on one TEST account. The contract is the TEST perpetual
// `local-test-gates.mjs futures` lists; its mark follows the stack's TEST book, which the TEST market maker walks a few
// basis points at a time. Every figure is read back through the customer's own API.
const J = 'J-derivatives-04';
const DESK = '/trade/futures';
const ROOM = '/trade/orders?product=futures';
const SYMBOL = 'BTC/USDT:USDT';
const SIZE = '0.01';
const LEVERAGE = '5';
const LABEL = 'grid-7';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function until(read, ok, what, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)}`);
}

/** The mark, as the service prices a preview. */
async function markOf(me) {
  const preview = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side: 'long', size: SIZE, leverage: LEVERAGE });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return { mark: toUnits(preview.body.markPrice), tier: preview.body.riskTier?.projected };
}

/** `bps` basis points from the mark, in whole units of price. */
const away = (mark, bps) => fromUnits(((mark + (mark * BigInt(bps)) / 10_000n) / 10n ** 18n) * 10n ** 18n);

/** A TEST long through the book at market, as the ticket sends it; waits for the position. */
async function openLong(me, tag) {
  const { tier } = await markOf(me);
  const placed = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'market',
    amount: SIZE,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    confirmTier: tier,
    clientOrderId: `${J}-${tag}-${Date.now()}`,
  });
  expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
  return until(
    async () => (await me.get('/api/v1/positions')).body.find((p) => p.symbol === SYMBOL && p.side === 'long' && p.status === 'open'),
    (p) => p !== undefined,
    'the TEST long',
  );
}

async function orders(me, query) {
  const { status, body } = await me.get(`/api/v1/futures/orders?${query}`);
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

async function room(page, query = '') {
  await page.goto(`${ROOM}${query}`);
  await expect(page.getByRole('heading', { name: 'Futures orders' })).toBeVisible();
}

const table = (page, name) => page.getByRole('table', { name });

test(`${J} #1 opens the orders room: open orders, history and executions, with the desk's own status words`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await fundedTrader(page, 'jd4', '1000');
  run.reset({ account: who });
  const me = await api(who);
  await signIn(page, who);
  await page.goto(DESK);
  // Derivatives access: the risk notice, the quiz and the two agreements, as any new trader clears them.
  await page.getByRole('button', { name: 'I have read this' }).click();
  const quiz = page.getByTestId('futures-quiz');
  await quiz.getByRole('radio', { name: /liquidated and can lose all of its margin/ }).check();
  await quiz.getByRole('button', { name: 'Submit answers' }).click();
  await expect(quiz.getByText('Passed. You can trade derivatives under the current rules.')).toBeVisible();
  for (const kind of ['derivatives_risk', 'margin_terms']) {
    const card = page.getByTestId(`agreement-${kind}`);
    await card.getByRole('button', { name: /^Accept / }).click();
    await expect(card).toContainText('Accepted');
  }
  // An execution to read: a TEST long at market.
  const position = await openLong(me, 'open');
  await page.reload();

  // A limit buy 3% under the mark rests; the ticket sends it with the trader's own label.
  const { mark } = await markOf(me);
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('group', { name: 'Order type' }).getByRole('button', { name: 'Limit' }).click();
  await ticket.getByRole('textbox', { name: 'Limit price' }).fill(away(mark, -300));
  await ticket.getByRole('textbox', { name: 'Size' }).fill(SIZE);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill(LEVERAGE);
  await ticket.getByRole('textbox', { name: 'Label (optional)' }).fill(LABEL);
  await ticket.getByRole('button', { name: 'Review', exact: true }).click();
  await ticket.getByRole('button', { name: 'Open long' }).click();
  const confirm = page.getByRole('alertdialog');
  const go = confirm.getByRole('button', { name: 'Confirm open long' });
  // The confirm re-checks the numbers first; a mark that moved shows the new figures and asks again, tier ticked again.
  let answer = null;
  page.on('response', (r) => {
    if (r.url().endsWith('/api/v1/futures/orders') && r.request().method() === 'POST') answer = r;
  });
  const moved = confirm.getByText('The numbers moved since you reviewed');
  for (let attempt = 0; attempt < 6 && !answer; attempt += 1) {
    const tier = confirm.getByRole('region', { name: 'New margin tier' }).getByRole('checkbox');
    if ((await tier.count()) > 0 && !(await tier.isChecked())) await tier.check();
    await go.click();
    // The re-check takes a moment; the notice from an earlier attempt may still be up while it runs.
    await page.waitForTimeout(1_000);
    await expect.poll(async () => answer !== null || ((await moved.isVisible()) && (await go.isEnabled())), { timeout: 20_000 }).toBe(true);
  }
  expect(answer, 'the ticket sent the order').not.toBeNull();
  expect(answer.status(), await answer.text()).toBe(200);
  expect(answer.request().postDataJSON()).toMatchObject({ type: 'limit', orderLabel: LABEL });
  const resting = await until(
    async () => (await orders(me, 'scope=open&limit=50')).filter((o) => o.orderLabel === LABEL),
    (list) => list.length === 1 && list[0].status === 'open',
    'the labelled limit resting',
  );
  const rest = resting[0];
  expect(rest).toMatchObject({ origin: 'user', originRef: null, side: 'buy', type: 'limit', qty: SIZE });

  // The desk's Orders tab names it in its words.
  await page.getByRole('tab', { name: 'Orders' }).click();
  const deskRow = page.getByRole('region', { name: 'Futures orders' }).getByRole('row').filter({ hasText: LABEL });
  await expect(deskRow).toContainText('Resting');
  await expect(deskRow).toContainText('You');

  // The orders room: spot and futures halves; the futures half opens on what rests, in the same words.
  await page.goto('/trade/orders');
  await page.getByRole('group', { name: 'Which orders' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page).toHaveURL(/product=futures/);
  const open = table(page, 'Open orders');
  const openRow = open.getByRole('row').filter({ hasText: LABEL });
  await expect(openRow).toContainText('Resting');
  await expect(openRow).toContainText('You');
  await expect(openRow).toContainText(SYMBOL);

  // Cancelled from the room: it leaves Open orders and is in Order history as Cancelled, as the desk says it too.
  const cancelled = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/futures/orders/${rest.orderId}`) && r.request().method() === 'DELETE',
  );
  await openRow.getByRole('button', { name: 'Cancel' }).click();
  expect((await cancelled).status()).toBe(200);
  await expect(open.getByRole('row').filter({ hasText: LABEL })).toHaveCount(0);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Order history' }).click();
  const historyRow = table(page, 'Order history').getByRole('row').filter({ hasText: LABEL });
  await expect(historyRow).toContainText('Cancelled');
  await page.goto(DESK);
  await page.getByRole('tab', { name: 'Orders' }).click();
  await page.getByRole('group', { name: 'Which orders' }).getByRole('button', { name: 'Order history' }).click();
  await expect(page.getByRole('region', { name: 'Futures orders' }).getByRole('row').filter({ hasText: LABEL })).toContainText('Cancelled');

  // Executions: the long's opening fill, taker on the book, with its fee; nothing realised on an open.
  await room(page, '&view=executions');
  const executions = table(page, 'Executions');
  const openFill = executions.getByRole('row').filter({ hasText: 'Open' }).first();
  await expect(openFill).toContainText(SYMBOL);
  await expect(openFill).toContainText('Buy');
  await expect(openFill).toContainText('(taker)');
  const { body } = await me.get('/api/v1/futures/executions?limit=50');
  const opened = body.executions.filter((e) => e.positionId === position.id && e.kind === 'open');
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.reduce((sum, e) => sum + toUnits(e.qty), 0n)).toBe(toUnits(SIZE));
  expect(opened.every((e) => e.feeRole === 'taker' && e.realizedPnl === null && toUnits(e.fee) >= 0n)).toBe(true);
  run.write({ positionId: position.id, cancelledId: rest.orderId });
});

test(`${J} #2 opens an order a stop placed, and one with a label: the origin named, the label shown and filtered`, async ({ page }) => {
  test.setTimeout(300_000);
  const me = await api(account());
  const { positionId, cancelledId } = run.read();
  await signIn(page, account());

  // A stop market 3 bps under the mark, on the mark: the walk crosses it within a minute or two and it closes the long
  // through the book with an order whose origin is the stop.
  let stop;
  for (let attempt = 0; attempt < 4 && !stop; attempt += 1) {
    const { mark } = await markOf(me);
    const res = await me.post('/api/v1/futures/conditional-orders', {
      market: SYMBOL,
      kind: 'stop_market',
      side: 'sell',
      quantity: SIZE,
      triggerPrice: fromUnits(mark - (mark * 3n) / 10_000n),
      triggerSource: 'mark',
      reduceOnly: true,
      clientOrderId: `${J}-stop-${Date.now()}`,
    });
    if (res.status === 201) stop = res.body;
    else expect(res.body.error, JSON.stringify(res.body)).toMatch(/wrong_side|trigger/);
  }
  expect(stop, 'the stop was armed').toBeTruthy();
  const placed = await until(
    async () => (await orders(me, 'scope=all&limit=50&origin=stop')).filter((o) => o.originRef === stop.id),
    (list) => list.length > 0 && list[0].status === 'filled',
    'the stop to fire and fill',
    240_000,
  );
  const fromStop = placed[0];
  expect(fromStop).toMatchObject({ origin: 'stop', side: 'sell', reduceOnly: true, positionId });

  // In the room, filtered by origin: the stop's order, named as a stop, filled.
  await room(page, '&view=history&origin=stop');
  const row = table(page, 'Order history').getByRole('row').filter({ hasText: 'Stop' }).first();
  await expect(row).toContainText('Filled');
  await row.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(new RegExp(`/trade/orders/${fromStop.orderId}\\?product=futures`));
  const facts = page.getByRole('definition');
  await expect(page.getByRole('heading', { name: `Sell ${SYMBOL}` })).toBeVisible();
  await expect(facts.filter({ hasText: 'Stop' }).first()).toBeVisible();
  await expect(page.getByText(`Your conditional order ${stop.id}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fills of this order' }).getByRole('listitem')).not.toHaveCount(0);

  // The labelled order from #1: its own page names the trader as its origin and shows the label.
  await page.goto(`/trade/orders/${cancelledId}?product=futures`);
  await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
  await expect(page.getByText('You', { exact: true })).toBeVisible();

  // Filtered by label: only that order, through the service's own filter.
  await room(page, `&view=history&label=${LABEL}`);
  const labelled = table(page, 'Order history').getByRole('row').filter({ hasText: LABEL });
  await expect(labelled).toHaveCount(1);
  const byLabel = await orders(me, `scope=all&limit=50&label=${LABEL}`);
  expect(byLabel.map((o) => o.orderId)).toEqual([cancelledId]);
  // A label the service would refuse is refused on the page before anything is asked.
  await page.getByRole('textbox', { name: 'Label' }).fill('two words');
  await expect(page.getByText('A label is up to 36 letters, digits and . _ : - with no spaces.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();

  // The stop's fill is a close execution with its realised result.
  const { body } = await me.get(`/api/v1/futures/executions?limit=50&orderId=${fromStop.orderId}`);
  expect(body.executions.length).toBeGreaterThan(0);
  expect(body.executions.every((e) => e.kind === 'close' && e.origin === 'stop' && e.realizedPnl !== null)).toBe(true);
});
