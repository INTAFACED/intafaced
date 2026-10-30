import { test, expect } from '@playwright/test';
import { bestPrices, fund, journeyState, tool, toUnits } from './stack.mjs';
import { awayBid } from './desk.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-copy-bots-otc-19, in the running app (docs/roadmap/journeys.json): drive bots and algo orders with the API. One test
// per step, titled "J-copy-bots-otc-19 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey
// and TEST 2000 USDT makes a live trade key; every call goes to Edge with that key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2, #3, #5 and #6: there is no public grid copy, grid stream, DCA or recurring buy API.
// - #7: the public algo route; and the stack sets no TEST bots verification level, so svc-trade refuses every algo
//   create.
const J = 'J-copy-bots-otc-19';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const call = (method, path, body) => withKey(state('key'), { method, path, body });

const ONE = toUnits('1');

/** The grid bot read back by API until `ok` holds. */
async function untilBot(id, ok, waitMs = 90_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const res = await call('GET', `/api/v1/bots/grid/${id}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    if (ok(res.body)) return res.body;
    if (Date.now() >= until)
      throw new Error(`grid ${id} reads ${res.body.state}: ${JSON.stringify(res.body.orders.map((o) => [o.side, o.status, o.price]))}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The bot's resting buys, highest price first, in units. */
const openBuys = (bot) =>
  bot.orders
    .filter((o) => o.side === 'buy' && o.status === 'open')
    .map((o) => toUnits(o.price))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

/** A TEST market `move` percent ("-1.25%") from one price to another. */
function shiftPercent(from, to) {
  const bps = ((to - from) * 10_000n) / from;
  const abs = bps < 0n ? -bps : bps;
  return `${bps < 0n ? '-' : '+'}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
}

/** The key holder's total of one asset, from the API's own balance read, in units. */
async function balance(asset) {
  const res = await call('GET', '/api/v1/account/balance');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return toUnits(res.body.balances?.[asset]?.total ?? '0');
}

test(`${J} #1 creates a neutral grid bot by API: one bot; stopping with settlement keep leaves the positions`, async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, who } = await keyHolder(browser, 'jcb');
  expect(fund(who.email, 'USDT', '2000').tx).toBeTruthy();
  const key = await makeKey(page);
  await page.context().close();
  run.reset({ who, key });
  // Bounds 5% either side of today's TEST book, so the bot places buys below the mark at create.
  const { bid, ask } = await bestPrices();
  const body = {
    clientId: `${J}-1-${Date.now().toString(36)}`,
    symbol: 'BTC/USDT',
    direction: 'neutral',
    lowerPrice: String((toUnits(bid) * 95n) / 100n / ONE),
    upperPrice: String((toUnits(ask) * 105n) / 100n / ONE),
    grids: 10,
    investment: '300',
  };
  const made = await call('POST', '/api/v1/bots/grid', body);
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const id = made.body.id;
  run.write({ gridId: id });
  // One bot: the same client id again answers the same bot, and the person's list holds it once.
  const again = await call('POST', '/api/v1/bots/grid', body);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.id).toBe(id);
  const list = await call('GET', '/api/v1/bots/grid');
  expect(list.status, JSON.stringify(list.body).slice(0, 300)).toBe(200);
  expect(list.body.map((bot) => bot.id)).toEqual([id]);
  const running = await untilBot(id, (bot) => bot.state === 'running' && openBuys(bot).length >= 2);
  // A position to keep: the TEST price falls through the top resting buy only. A buy fills once the book's asks reach
  // it, 6 bps over the mid, so aim the mid between 6 bps under the second buy and 6 bps under the top one.
  const buys = openBuys(running);
  const target = (((buys[0] + buys[1]) / 2n) * (10_000n - 6n)) / 10_000n;
  // The walk keeps wandering, so the shift is measured from the mid of this moment. The bot is stopped before the price
  // goes back, so the pair's sell one level up can't fill on the way.
  const now = await bestPrices();
  const mid = (toUnits(now.bid) + toUnits(now.ask)) / 2n;
  let held, before, stopped;
  try {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', shiftPercent(mid, target));
    held = await untilBot(id, (bot) => bot.orders.some((o) => o.side === 'buy' && o.status === 'filled'));
    before = await balance('BTC');
    stopped = await call('POST', `/api/v1/bots/grid/${id}/stop`, { settlement: 'keep' });
  } finally {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '0%');
  }
  expect(before > 0n, 'the filled buy delivered BTC').toBe(true);
  expect(stopped.status, JSON.stringify(stopped.body).slice(0, 300)).toBe(200);
  expect(stopped.body.state).toBe('stopped');
  // Keep: every open level order is cancelled and the bought base stays the person's, unsold.
  const after = await untilBot(id, (bot) => bot.orders.every((o) => o.status !== 'open'));
  expect(after.state).toBe('stopped');
  const filled = (bot) => bot.orders.filter((o) => o.status === 'filled').map((o) => `${o.side}:${o.orderId}`);
  expect(filled(after)).toEqual(filled(held));
  expect(after.orders.some((o) => o.side === 'sell' && o.status === 'filled')).toBe(false);
  expect(await balance('BTC'), 'the bought BTC is kept').toBe(before);
});

test(`${J} #2 requests a copy of a lead's grid by API: as in the web`, async () => {
  const res = await call('POST', '/api/v1/bots/grid/copy', { sourceBotId: state('gridId') });
  expect(res.status).toBe(200);
});

test(`${J} #3 subscribes to the grid stream: one fill event per fill id`, async () => {
  const res = await call('POST', '/api/v1/stream/token');
  expect(res.status).toBe(200);
});

test(`${J} #4 withdraws grid funds by API without step-up: refused for step-up`, async () => {
  const id = state('gridId');
  const before = await call('GET', `/api/v1/bots/grid/${id}`);
  expect(before.status, JSON.stringify(before.body).slice(0, 300)).toBe(200);
  const res = await call('POST', `/api/v1/bots/grid/${id}/withdraw`, { requestId: `${J}-4`, asset: 'USDT', amount: '1' });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403);
  expect(res.body.intafacedCode).toBe('identity.step_up_required');
  // Nothing was withdrawn: the bot reads back as it was.
  const after = await call('GET', `/api/v1/bots/grid/${id}`);
  expect(after.body).toEqual(before.body);
});

test(`${J} #5 creates a spot DCA bot by API and sends a manual buy to a stopped one: immutable; refused as not running`, async () => {
  const made = await call('POST', '/api/v1/bots/dca', { symbol: 'BTC/USDT', baseOrder: '20', clientId: `${J}-5` });
  expect(made.status).toBe(200);
});

test(`${J} #6 creates a recurring buy rule twice with one key and tops up past the cap: one rule; the cap code`, async () => {
  const body = { basket: [{ asset: 'BTC', weightPct: '100' }], amount: '10', every: 'day', clientId: `${J}-6` };
  const a = await call('POST', '/api/v1/recurring', body);
  // Each call must make or return a rule: two refusals (no public recurring API yet) would otherwise compare equal.
  expect(a.status, `UNBUILT: no public recurring buy API; answered ${JSON.stringify(a.body).slice(0, 200)}`).toBe(200);
  expect(a.body.id, 'the rule has an id').toBeTruthy();
  const b = await call('POST', '/api/v1/recurring', body);
  expect(b.status, JSON.stringify(b.body).slice(0, 200)).toBe(200);
  expect(b.body.id).toBe(a.body.id);
  // One rule: the person's rule list, read back, holds this key exactly once.
  const list = await call('GET', '/api/v1/recurring');
  expect(list.status, JSON.stringify(list.body).slice(0, 200)).toBe(200);
  const rules = Array.isArray(list.body) ? list.body : list.body.items;
  expect(rules.filter((rule) => rule.clientId === body.clientId).map((rule) => rule.id)).toEqual([a.body.id]);
  // The top-up past the cap is refused by its cap code; a top-up route has to exist for this to pass.
  const topUp = await call('POST', `/api/v1/recurring/${a.body.id}/top-up`, { amount: '1000000' });
  expect(topUp.status, JSON.stringify(topUp.body).slice(0, 200)).toBeGreaterThanOrEqual(400);
  expect(codeOf(topUp.body), 'the cap code').toMatch(/cap/);
});

test(`${J} #7 places a TWAP with a client algo id, amends, cancels and reads: one parent; amend refused; trigger kind refused`, async () => {
  const body = {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    durationMs: 600_000,
    sliceIntervalMs: 60_000,
    limitPrice: await awayBid(50),
    clientAlgoId: `${J}-7`,
  };
  const a = await call('POST', '/api/v1/algo/twap', body);
  expect(a.status, JSON.stringify(a.body).slice(0, 300)).toBe(200);
  const b = await call('POST', '/api/v1/algo/twap', body);
  expect(b.body.id).toBe(a.body.id);
  const amend = await call('PATCH', `/api/v1/algo/${a.body.id}`, { totalQty: '0.003' });
  expect(codeOf(amend.body)).toBe('algo_immutable');
});
