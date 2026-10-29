import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EDGE, json, journeyState, staffFreeze, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { tableIn } from './tables.mjs';

// J-developer-04, in the running app (docs/roadmap/journeys.json): sign requests and understand the errors that come
// back. One test per step, titled "J-developer-04 #<n>". The person is a TEST account on the local stack with a passkey
// (only such an account may hold a key, as in J-developer-03) and one live trade key made in the browser; every call
// after that goes from the developer's own program straight to Edge, as a bot's would.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1, #2: /developers/authentication publishes no test vector, a trade key gets no signing secret at creation, and the
//   timestamp window is a constant, not an owner value (DV-auth-01).
// - #3: svc-trade's 400 lists every bad field with a docs link; #3 needs svc-edge request ids (branch developer-edge-errors).
// - #4: errors carry no request id in the body (DV-errors-01, svc-edge).
// - #5: no catalogue of auth and permission codes at /developers/errors/auth (DV-errors-02).
// - #6: svc-trade refuses a money call 503 posting_frozen; the stack tool that turns the freeze on and off
//   (`local-test-gates.mjs posting-freeze on|off`) is on branch developer-gates-posting-freeze.
// - #7: replies carry `x-request-id` only on rate-limit refusals, and no received or sent time (RC-developer-03).
// #6 runs last: it freezes the account.
const J = 'J-developer-04';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

/** @type {import('@playwright/test').Page} */
let page;

/** Makes a key in the browser with the preset named, as J-developer-03 does; returns the key and its signing secret if one is shown. */
async function makeKey(name, preset = 'Trade') {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel(preset, { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').textContent())?.trim();
  const secretBox = page.getByTestId('api-keys__signing-secret');
  const secret = (await secretBox.count()) ? (await secretBox.textContent())?.trim() : undefined;
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  return { key, secret };
}

const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const canonical = ({ method, path, timestamp, nonce, body = '' }) =>
  ['INTAFACED-REQ-V1', method.toUpperCase(), path, timestamp, nonce, sha256(body)].join('\n');
const sign = (secret, parts) => createHmac('sha256', secret).update(canonical(parts)).digest('hex');

/** One call from the developer's program: a bearer key and, with a secret, the three signature headers. */
async function call(
  method,
  path,
  { key, secret, body, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID(), tamper } = {},
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(raw ? { 'content-type': 'application/json' } : {}) };
  if (secret) {
    headers['x-intafaced-request-timestamp'] = timestamp;
    headers['x-intafaced-request-nonce'] = nonce;
    headers['x-intafaced-request-signature'] = sign(secret, { method, path, timestamp, nonce, body: raw });
  }
  const res = await fetch(`${EDGE}${tamper ?? path}`, { method, headers, body: raw || undefined });
  return { ...(await json(res)), headers: res.headers };
}

const codeOf = (reply) => reply.body?.code ?? reply.body?.error?.code;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  const who = await signUp(page, 'ds');
  await verify(page, who);
  await signIn(page, who);
  await addPasskey(page);
  run.reset({ who, trade: await makeKey('bot-sign') });
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 signs the published test vector: the server accepts it, and an altered request is refused as tampered`, async () => {
  await page.goto('/developers/authentication');
  await expect(page.getByRole('heading', { name: 'Authentication', level: 1 })).toBeVisible();
  const vector = page.getByTestId('developers-sign-vector');
  await expect(vector).toBeVisible(UNBUILT);
  const field = async (name) => (await vector.getByTestId(`vector-${name}`).textContent())?.trim() ?? '';
  const published = {
    method: await field('method'),
    path: await field('path'),
    timestamp: await field('timestamp'),
    nonce: await field('nonce'),
    body: await field('body'),
  };
  // The vector's signature is what this program computes from the published TEST secret.
  expect(sign(await field('secret'), published)).toBe(await field('signature'));

  const { trade } = run.read();
  expect(trade.secret, 'a trade key is shown a signing secret once, at creation').toBeTruthy();
  const ok = await call('GET', '/api/v1/account/balance', trade);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  const tampered = await call('GET', '/api/v1/account/balance', { ...trade, tamper: '/api/v1/account/balance?x=1' });
  expect(tampered.status).toBe(401);
  expect(codeOf(tampered)).toMatch(/tampered/);
});

test(`${J} #2 sends a timestamp just outside the owner window: the stale code; a reused nonce gives the replay code`, async () => {
  const { trade } = run.read();
  expect(trade.secret, 'a trade key is shown a signing secret once, at creation').toBeTruthy();
  await page.goto('/developers/authentication');
  // The window is the owner's value, published on the page in seconds.
  const window = Number((await page.getByTestId('developers-sign-window').textContent(UNBUILT))?.match(/\d+/)?.[0]);
  expect(window).toBeGreaterThan(0);
  const stale = await call('GET', '/api/v1/account/balance', { ...trade, timestamp: String(Math.floor(Date.now() / 1000) - window - 5) });
  expect(codeOf(stale)).toMatch(/stale/);
  const nonce = randomUUID();
  expect((await call('GET', '/api/v1/account/balance', { ...trade, nonce })).status).toBe(200);
  const replay = await call('GET', '/api/v1/account/balance', { ...trade, nonce });
  expect(codeOf(replay)).toMatch(/replay/);
});

test(`${J} #3 sends a request with two invalid fields: one typed body listing both, with a request id and a docs link`, async () => {
  const { trade } = run.read();
  const reply = await call('POST', '/api/v1/orders', {
    ...trade,
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'sideways', amount: '-1', price: '1', clientOrderId: `jd04-${RUN}-3` },
  });
  expect(reply.status).toBe(400);
  expect(reply.body, JSON.stringify(reply.body)).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  expect(reply.body.requestId).toBeTruthy();
  expect(reply.body.docs).toMatch(/\/developers\/errors/);
  const fields = (reply.body.errors ?? []).map((error) => error.field).sort();
  expect(fields).toEqual(['amount', 'side']);
});

test(`${J} #4 provokes a gateway refusal and a service error: the edge prefix tells them apart`, async () => {
  const { trade } = run.read();
  const gateway = await call('GET', '/api/v1/account/balance', { key: 'ifc_not_a_real_key_000000000000' });
  expect(gateway.status).toBe(401);
  expect(codeOf(gateway), JSON.stringify(gateway.body)).toMatch(/^edge\./);
  const service = await call('POST', '/api/v1/orders', {
    ...trade,
    body: { symbol: 'NOPE/USDT', type: 'limit', side: 'buy', amount: '1', price: '1', clientOrderId: `jd04-${RUN}-4` },
  });
  expect(service.status).toBeGreaterThanOrEqual(400);
  expect(codeOf(service), JSON.stringify(service.body)).toBeTruthy();
  expect(codeOf(service)).not.toMatch(/^edge\./);
  for (const reply of [gateway, service]) expect(reply.body.requestId, JSON.stringify(reply.body)).toBeTruthy();
});

test(`${J} #5 calls with a missing, wrong, revoked or out-of-scope key: each body code matches the catalogue entry`, async () => {
  test.setTimeout(180_000);
  await page.goto('/developers/errors/auth');
  const catalogue = tableIn(page, /Authentication and permission errors/);
  await expect(catalogue).toBeVisible(UNBUILT);
  const codeFor = async (cause) =>
    (
      await catalogue
        .getByRole('row', { name: new RegExp(cause, 'i') })
        .getByRole('code')
        .first()
        .textContent()
    )?.trim();

  const readOnly = await makeKey('bot-read', 'Read only');
  const revoked = await makeKey('bot-gone', 'Read only');
  await page.goto('/uc/safe/api-keys');
  await page
    .getByRole('row', { name: /bot-gone/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();

  const order = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1', clientOrderId: `jd04-${RUN}-5` };
  const cases = [
    ['missing', await call('GET', '/api/v1/account/balance', {})],
    ['wrong', await call('GET', '/api/v1/account/balance', { key: 'ifc_not_a_real_key_000000000000' })],
    ['revoked', await call('GET', '/api/v1/account/balance', revoked)],
    ['scope', await call('POST', '/api/v1/orders', { ...readOnly, body: order })],
  ];
  for (const [cause, reply] of cases) {
    expect(reply.status, cause).toBeGreaterThanOrEqual(400);
    expect(codeOf(reply), cause).toBe(await codeFor(cause));
  }
});

test(`${J} #7 reads the response headers: the request id and the server's received and sent times, sent not before received`, async () => {
  const { trade } = run.read();
  const reply = await call('GET', '/api/v1/account/balance', trade);
  expect(reply.headers.get('x-request-id')).toBeTruthy();
  const received = Number(reply.headers.get('x-server-received'));
  const sent = Number(reply.headers.get('x-server-sent'));
  expect(received, 'x-server-received').toBeGreaterThan(0);
  expect(sent).toBeGreaterThanOrEqual(received);
});

test(`${J} #6 calls from a frozen account, then a money call during the platform posting freeze: account_frozen, then posting_frozen while a read still works`, async () => {
  test.setTimeout(180_000);
  const { who, trade } = run.read();
  // The platform posting freeze first, so the account is still open: a money call is refused, a read still works.
  tool('local-test-gates.mjs', 'posting-freeze', 'on');
  let failed;
  try {
    const order = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1', clientOrderId: `jd04-${RUN}-6` };
    const money = await call('POST', '/api/v1/orders', { ...trade, body: order });
    expect(money.body?.intafacedCode, JSON.stringify(money.body)).toBe('posting_frozen');
    // Temporary and safe to resend under the same client order id, so the retry-with-backoff status.
    expect(money.status, JSON.stringify(money.body)).toBe(503);
    expect((await call('GET', '/api/v1/account/balance', trade)).status).toBe(200);
  } catch (error) {
    failed = error;
  }
  // The freeze is platform-wide: it comes off whatever happened above, and a failure to lift it is said loudly,
  // without hiding the step's own failure.
  try {
    tool('local-test-gates.mjs', 'posting-freeze', 'off');
  } catch (error) {
    throw new Error(`the platform posting freeze is still ON and must be lifted by hand: ${error.message}`, { cause: failed });
  }
  if (failed) throw failed;
  await staffFreeze(who);
  const frozen = await call('GET', '/api/v1/account/balance', trade);
  expect(codeOf(frozen), JSON.stringify(frozen.body)).toBe('account_frozen');
});
