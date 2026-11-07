// World: book
import http from 'node:http';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';

// J-developer-08, in the running app (docs/roadmap/journeys.json): see what my key did. One test per step, titled
// "J-developer-08 #<n>", written by an independent test-writer from the step's own words (OWNER 212); the builder makes
// them pass and may not weaken them. The person is a TEST account with a passkey and one read-only key whose IP list is
// 127.0.0.1. Before step 1 the key makes three calls straight to Edge, as a developer's program would: one answered,
// one denied (a read-only key placing an order), and one from 127.0.0.2, outside its IP list (CI runs on Linux, where
// every 127.x address is the machine's own, so the call leaves from that address). Each step reads that start; a worker started again after a failed step makes it afresh.
//
// Names this file asks the product for, where main has nothing yet (the builder implements them as written):
// - the key detail page has a table named "Call log", one row per call, each with data-request-id (the x-request-id
//   Edge answered that call with) and data-status (the HTTP status); a call from outside the key's IP list says
//   "Outside the IP list"; the log's as-of time is api-keys__calls-as-of, a <time datetime="ISO">.
// - the log has a "Status" select, "From" and "To" date fields (YYYY-MM-DD, UTC) and a "Refresh" button.
// - identity serves the log as `developerKeys.calls { keyId, limit }`.
// - the detail page's region "Limits" shows api-keys__limit-used, api-keys__limit-remaining (whole numbers) and
//   api-keys__limits-as-of, a <time datetime="ISO">.
const J = 'J-developer-08';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
// A part main does not have yet fails at its first look, not after the default wait.
const UNBUILT = { timeout: 10_000 };
// Values the calls carry that the log must never show: a body field and a header.
const BODY_MARK = `jd8body${Date.now().toString(36)}`;
const HEADER_MARK = `jd8header${Date.now().toString(36)}`;

test.describe.configure({ mode: 'default' });

/** @type {import('@playwright/test').Page} */
let page;

/** A call from another of this machine's addresses (outside the key's IP list), straight to Edge. */
function callFrom(localAddress, key, path) {
  const url = new URL(path, EDGE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        localAddress,
        headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'x-jd8-note': HEADER_MARK },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, requestId: res.headers['x-request-id'] }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const callLog = () => page.getByRole('table', { name: 'Call log' });
const logRows = () => callLog().locator('tbody tr');
const asOf = async (testId) => page.getByTestId(testId).locator('time').getAttribute('datetime', UNBUILT);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const holder = await keyHolder(browser, 'jd8');
  page = holder.page;
  const key = await makeKey(page, { name: 'bot-log', preset: 'Read only', ips: '127.0.0.1' });
  const keyId = await page
    .getByTestId('api-keys__table')
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name: 'bot-log', exact: true }) })
    .getAttribute('data-key-id');

  // The three calls: one answered, one denied, one from outside the IP list.
  const started = new Date().toISOString();
  const answered = await withKey(key, { path: '/api/v1/account/balance', headers: { 'x-jd8-note': HEADER_MARK } });
  expect(answered.status, JSON.stringify(answered.body).slice(0, 300)).toBe(200);
  const denied = await withKey(key, {
    method: 'POST',
    path: '/api/v1/orders',
    headers: { 'x-jd8-note': HEADER_MARK },
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1', clientOrderId: BODY_MARK },
  });
  expect(denied.status, `a read-only key may not place an order: ${JSON.stringify(denied.body).slice(0, 300)}`).toBe(403);
  const outside = await callFrom('127.0.0.2', key, '/api/v1/account/balance');
  // Edge refuses it as a denied key (401); the same read from 127.0.0.1 was answered just before, so the address is why.
  expect([401, 403], 'the same call from outside the IP list is refused').toContain(outside.status);
  const calls = [
    { requestId: answered.headers.get('x-request-id'), status: 200, path: '/api/v1/account/balance' },
    { requestId: denied.headers.get('x-request-id'), status: 403, path: '/api/v1/orders' },
    { requestId: outside.requestId, status: 403, path: '/api/v1/account/balance', outside: true },
  ];
  for (const call of calls) expect(call.requestId, `Edge answered ${call.path} with a request id`).toBeTruthy();
  run.reset({ who: holder.who, key, keyId, calls, started, limit: answered.headers.get('x-ratelimit-limit') });
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 opens /uc/safe/api-keys/<keyId>: the key detail with its call log`, async () => {
  const { keyId } = run.read();
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'bot-log' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Key detail' })).toBeVisible();
  await expect(callLog()).toBeVisible(UNBUILT);
  await expect(logRows()).toHaveCount(3, UNBUILT);
});

test(`${J} #2 reads the three rows: status and request id on each, no body or header value, the call from outside the IP list flagged`, async () => {
  const { who, key, keyId, calls } = run.read();
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  await expect(logRows()).toHaveCount(3, UNBUILT);
  for (const call of calls) {
    const row = callLog().locator(`tbody tr[data-request-id="${call.requestId}"]`);
    await expect(row, `the call to ${call.path} that Edge answered ${call.status}`).toHaveCount(1, UNBUILT);
    await expect(row).toHaveAttribute('data-status', String(call.status));
    // Status and request id are shown on the row, and what was called.
    await expect(row).toContainText(String(call.status));
    await expect(row).toContainText(call.requestId);
    await expect(row).toContainText(call.path);
    if (call.outside) await expect(row).toContainText('Outside the IP list');
    else await expect(row).not.toContainText('Outside the IP list');
  }
  // Nothing secret: no body value, no header value, never the key, in the log or in what identity serves for it.
  const shown = (await callLog().innerHTML()) + (await page.content());
  for (const secret of [BODY_MARK, HEADER_MARK, key]) expect(shown).not.toContain(secret);
  const served = await (
    await api(who)
  ).get(`/api/identity/trpc/developerKeys.calls?input=${encodeURIComponent(JSON.stringify({ keyId, limit: 50 }))}`);
  expect(served.status, JSON.stringify(served.body).slice(0, 300)).toBe(200);
  for (const secret of [BODY_MARK, HEADER_MARK, key]) expect(JSON.stringify(served.body)).not.toContain(secret);
});

test(`${J} #3 filters by status and date and presses Refresh: only matching rows, and the as-of time updates`, async () => {
  const { keyId, calls } = run.read();
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  await expect(logRows()).toHaveCount(3, UNBUILT);
  const before = await asOf('api-keys__calls-as-of');

  // Status 403, today: the two refused calls only.
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel('Status').selectOption('403', UNBUILT);
  await page.getByLabel('From').fill(today, UNBUILT);
  await page.getByLabel('To').fill(today, UNBUILT);
  await page.waitForTimeout(1_100);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(UNBUILT);
  const refused = calls.filter((c) => c.status === 403).map((c) => c.requestId);
  await expect(logRows()).toHaveCount(2);
  expect((await logRows().evaluateAll((rows) => rows.map((r) => r.dataset.requestId))).sort()).toEqual(refused.sort());
  const after = await asOf('api-keys__calls-as-of');
  expect(Date.parse(after ?? '')).toBeGreaterThan(Date.parse(before ?? ''));

  // Status 200: the answered call only.
  await page.getByLabel('Status').selectOption('200');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(logRows()).toHaveCount(1);
  await expect(logRows().first()).toHaveAttribute('data-request-id', calls[0].requestId);

  // A day with no calls: no rows.
  await page.getByLabel('From').fill('2020-01-01');
  await page.getByLabel('To').fill('2020-01-02');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(logRows()).toHaveCount(0);
});

test(`${J} #4 opens the log of someone else's key: refused`, async ({ browser }) => {
  const { keyId, calls } = run.read();
  const other = await keyHolder(browser, 'jd8o');
  try {
    // In the browser: the other person's page for this key shows no log and no call of it.
    await other.page.goto(`/uc/safe/api-keys/${keyId}`);
    await expect(other.page.getByRole('alert')).toBeVisible();
    await expect(other.page.getByRole('table', { name: 'Call log' })).toHaveCount(0);
    for (const call of calls) expect(await other.page.content()).not.toContain(call.requestId);

    // And from identity itself: the log of a key that is not theirs is refused.
    const reply = await (
      await api(other.who)
    ).get(`/api/identity/trpc/developerKeys.calls?input=${encodeURIComponent(JSON.stringify({ keyId, limit: 50 }))}`);
    expect([403, 404], JSON.stringify(reply.body).slice(0, 300)).toContain(reply.status);
    for (const call of calls) expect(JSON.stringify(reply.body)).not.toContain(call.requestId);
  } finally {
    await other.page.context().close();
  }
});

test(`${J} #5 reads used and remaining limits: usage with an as-of time`, async () => {
  const { keyId, limit, started } = run.read();
  await page.goto(`/uc/safe/api-keys/${keyId}`);
  const limits = page.getByRole('region', { name: 'Limits' });
  await expect(limits).toBeVisible(UNBUILT);
  const number = async (testId) => Number((await limits.getByTestId(testId).textContent(UNBUILT))?.replace(/[^\d]/g, ''));
  const used = await number('api-keys__limit-used');
  const remaining = await number('api-keys__limit-remaining');
  expect(Number.isInteger(used) && used >= 0, `used is a whole number (${used})`).toBe(true);
  expect(Number.isInteger(remaining) && remaining >= 0, `remaining is a whole number (${remaining})`).toBe(true);
  expect(used, 'the key has made calls, so some of its limit is used').toBeGreaterThan(0);
  // The same limit Edge answers the key's calls with, when Edge names one.
  if (limit) expect(used + remaining).toBe(Number(limit));
  // As of a time after the key's calls, and not in the future.
  const at = Date.parse((await limits.getByTestId('api-keys__limits-as-of').locator('time').getAttribute('datetime', UNBUILT)) ?? '');
  expect(at).toBeGreaterThanOrEqual(Date.parse(started));
  expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
});
