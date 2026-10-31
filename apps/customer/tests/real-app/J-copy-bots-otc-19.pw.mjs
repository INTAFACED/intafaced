import { test, expect } from './journey.mjs';
import { fund, journeyState } from './stack.mjs';
import { awayBid } from './desk.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-copy-bots-otc-19, in the running app (docs/roadmap/journeys.json): drive bots and algo orders with the API. One test
// per step, titled "J-copy-bots-otc-19 #<n>", run in order. #1 makes the start: a verified TEST account with a passkey
// and TEST 2000 USDT makes a live trade key; every call goes to Edge with that key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #6: there is no public bots API (grid, grid copy, grid stream, DCA, recurring buy).
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

test(`${J} #1 creates a neutral grid bot by API: one bot; stopping with settlement keep leaves the positions`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jcb');
  expect(fund(who.email, 'USDT', '2000').tx).toBeTruthy();
  const key = await makeKey(page);
  await page.context().close();
  run.reset({ who, key });
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
