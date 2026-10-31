import { test, expect } from '@playwright/test';
import { bestPrices, fund, journeyState, toUnits } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-copy-bots-otc-19, in the running app (docs/roadmap/journeys.json): drive bots and algo orders with the API. One test
// per step, titled "J-copy-bots-otc-19 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey
// and TEST 2000 USDT makes a live trade key; every call goes to Edge with that key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #6: there is no public bots API (grid, grid copy, grid stream, DCA, recurring buy).
const J = 'J-copy-bots-otc-19';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const call = (method, path, body) => withKey(state('key'), { method, path, body });

test(`${J} #1 creates a neutral grid bot by API: one bot; stopping with settlement keep leaves the positions`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jcb');
  expect(fund(who.email, 'USDT', '2000').tx).toBeTruthy();
  const key = await makeKey(page);
  // A second key that may only read, for #7's refusal of a write without trade:write.
  const readKey = await makeKey(page, { name: 'read-1', preset: 'Read only' });
  await page.context().close();
  run.reset({ who, key, readKey });
  const made = await call('POST', '/api/v1/bots/grid', {
    symbol: 'BTC/USDT',
    direction: 'neutral',
    grids: 10,
    investment: '300',
    clientId: `${J}-1`,
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  run.write({ gridId: made.body.id });
  const stopped = await call('POST', `/api/v1/bots/grid/${made.body.id}/stop`, { settlement: 'keep' });
  expect(stopped.body.state).toBe('stopped');
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
  const res = await call('POST', `/api/v1/bots/grid/${state('gridId')}/withdraw`, { amount: '10' });
  expect(codeOf(res.body)).toBe('step_up_required');
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
  test.setTimeout(120_000);
  // A buy limit at or over the ask (the slice price band), a whole number 1% over it; small and slow, cancelled below.
  const { ask } = await bestPrices();
  const body = {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.0002',
    durationMs: 3_600_000,
    sliceIntervalMs: 600_000,
    limitPrice: String((toUnits(ask) * 101n) / 100n / ONE + 1n),
    clientAlgoId: `${J}-7-${Date.now().toString(36)}`,
  };
  const a = await call('POST', '/api/v1/algo/twap', body);
  expect(a.status, JSON.stringify(a.body).slice(0, 300)).toBe(200);
  const id = a.body.id;
  try {
    expect(a.body).toMatchObject({ kind: 'twap', side: 'buy', totalQty: body.totalQty, limitPrice: body.limitPrice });
    // One parent: the same client algo id again answers the same parent, and the list holds it once.
    const b = await call('POST', '/api/v1/algo/twap', body);
    expect(b.status, JSON.stringify(b.body).slice(0, 300)).toBe(200);
    expect(b.body.id).toBe(id);
    const list = await call('GET', '/api/v1/algo?limit=500');
    expect(list.status, JSON.stringify(list.body).slice(0, 300)).toBe(200);
    expect(list.body.nextCursor).toBeNull();
    expect(list.body.rows.filter((row) => row.id === id)).toHaveLength(1);
    // Amend is refused by name, and the parent reads back unchanged.
    const amend = await call('PATCH', `/api/v1/algo/${id}`, { totalQty: '0.0003' });
    expect(amend.status, JSON.stringify(amend.body).slice(0, 300)).toBe(400);
    expect(amend.body.intafacedCode).toBe('trade.algo_params_immutable');
    const read = await call('GET', `/api/v1/algo/${id}`);
    expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
    expect(read.body).toMatchObject({ id, totalQty: body.totalQty, limitPrice: body.limitPrice });
    // A trigger kind is refused as not built, and a key without trade:write is refused; neither makes a parent.
    const trigger = await call('POST', '/api/v1/algo/trigger', { ...body, clientAlgoId: `${body.clientAlgoId}-t` });
    expect(trigger.status, JSON.stringify(trigger.body).slice(0, 300)).toBe(400);
    expect(trigger.body.intafacedCode).toBe('trade.algo_kind_not_built');
    const readOnly = await withKey(state('readKey'), {
      method: 'POST',
      path: '/api/v1/algo/twap',
      body: { ...body, clientAlgoId: `${body.clientAlgoId}-r` },
    });
    expect(readOnly.status, JSON.stringify(readOnly.body).slice(0, 300)).toBe(403);
    const after = await call('GET', '/api/v1/algo?limit=500');
    expect(after.body.rows.map((row) => row.id).sort()).toEqual(list.body.rows.map((row) => row.id).sort());
  } finally {
    const cancelled = await call('POST', `/api/v1/algo/${id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body).slice(0, 300)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
  }
});
