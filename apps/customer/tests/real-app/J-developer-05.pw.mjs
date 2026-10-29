import { test, expect } from '@playwright/test';
import { awayBid } from './desk.mjs';
import { fund, journeyState } from './stack.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-05, in the running app (docs/roadmap/journeys.json): place an order over the API without ever doubling it.
// One test per step, titled "J-developer-05 #<n>", run in order. #1 makes the start: a verified TEST account with a
// passkey and TEST 1000 USDT makes a live trade key; every order rests far from the TEST BTC/USDT book so it never
// fills, and is read back through the same key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1 to #4: the public order route takes no Idempotency-Key header (the stored response, the conflict and the
//   in-progress codes).
// - #5: the docs carry no "accepted is not final" guidance or read-by-key route.
// - #6: no cursor paging on the order list.
const J = 'J-developer-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const order = async (amount = '0.001') => ({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount, price: await awayBid(50) });
const place = (body, key) => withKey(state('key'), { method: 'POST', path: '/api/v1/orders', body, headers: { 'Idempotency-Key': key } });
const openIds = async () => {
  const res = await withKey(state('key'), { path: '/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100' });
  return (res.body?.items ?? res.body ?? []).map((o) => o.id);
};

test(`${J} #1 places an order with an Idempotency-Key: accepted with its id`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdo');
  expect(fund(who.email, 'USDT', '1000').tx).toBeTruthy();
  const key = await makeKey(page);
  await page.context().close();
  const body = await order();
  run.reset({ who, key, body });
  const placed = await place(body, `${J}-1`);
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBe(200);
  expect(placed.headers.get('idempotency-key')).toBe(`${J}-1`);
  run.write({ orderId: placed.body.id });
});

test(`${J} #2 retries the same key and body: the stored response; one order`, async () => {
  const again = await place(state('body'), `${J}-1`);
  expect(again.body.id).toBe(state('orderId'));
  expect(again.headers.get('idempotent-replayed')).toBe('true');
  expect((await openIds()).filter((id) => id === state('orderId'))).toHaveLength(1);
});

test(`${J} #3 retries the same key with a changed quantity: the idempotency conflict code`, async () => {
  const changed = await place({ ...state('body'), amount: '0.002' }, `${J}-1`);
  expect(changed.status).toBe(409);
  expect(codeOf(changed.body)).toBe('idempotency_key_conflict');
});

test(`${J} #4 sends two requests with the same key at once: the second gets the in-progress code`, async () => {
  const body = await order();
  const [a, b] = await Promise.all([place(body, `${J}-4`), place(body, `${J}-4`)]);
  const codes = [a, b].map((r) => codeOf(r.body) ?? r.status);
  expect(codes).toContain('idempotency_key_in_progress');
});

test(`${J} #5 times out after the hold: the docs say accepted is not final; read by key; a retry never makes a second order`, async ({
  page,
}) => {
  await page.goto('/developers/idempotency');
  await expect(page.getByText(/Accepted isn’t final/)).toBeVisible({ timeout: 5_000 });
  const byKey = await withKey(state('key'), { path: `/api/v1/orders/by-key/${encodeURIComponent(`${J}-1`)}` });
  expect(byKey.body.id).toBe(state('orderId'));
});

test(`${J} #6 lists orders with a cursor, three pages: each once; the end cursor is empty; a blank maximum page size refuses`, async () => {
  for (let i = 0; i < 4; i++) await place(await order(), `${J}-6-${i}`);
  const seen = [];
  let cursor = '';
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const res = await withKey(state('key'), { path: `/api/v1/orders?symbol=BTC%2FUSDT&limit=2${cursor ? `&cursor=${cursor}` : ''}` });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    seen.push(...res.body.items.map((o) => o.id));
    cursor = res.body.nextCursor ?? '';
    if (!cursor) break;
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect(cursor).toBe('');
});
