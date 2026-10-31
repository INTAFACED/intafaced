import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { EDGE, fund, json, journeyState, staffFreeze, staffRestore, toUnits, tool } from './stack.mjs';
import { awayBid, signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { tableIn } from './tables.mjs';
import { blankSigningWindow, signingPolicy } from './developer.mjs';

// J-developer-04, in the running app (docs/roadmap/journeys.json): sign requests and understand the errors that come
// back. One test per step, titled "J-developer-04 #<n>". The person is a TEST account on the local stack with a passkey
// (only such an account may hold a key, as in J-developer-03) and one live trade key made in the browser; every call
// after that goes from the developer's own program straight to Edge, as a bot's would.
// A step whose part is missing fails at it quickly (UNBUILT) instead of waiting out the default timeout.
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
  { key, secret, body, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID(), tamper, sendBody } = {},
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(raw ? { 'content-type': 'application/json' } : {}) };
  if (secret) {
    headers['x-intafaced-request-timestamp'] = timestamp;
    headers['x-intafaced-request-nonce'] = nonce;
    headers['x-intafaced-request-signature'] = sign(secret, { method, path, timestamp, nonce, body: raw });
  }
  // `tamper` sends another path and `sendBody` another body than the one signed, as a man in the middle would.
  const sent = sendBody === undefined ? raw : JSON.stringify(sendBody);
  const res = await fetch(`${EDGE}${tamper ?? path}`, { method, headers, body: sent || undefined });
  return { ...(await json(res)), headers: res.headers };
}

const codeOf = (reply) => reply.body?.code ?? reply.body?.error?.code;

/** The account's balance as the trade key reads it, to show a refused call changed and held nothing. */
async function balance(trade) {
  const reply = await call('GET', '/api/v1/account/balance', trade);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  // The clock fields change on every read; the amounts must not.
  const { serverTime, timestamp, datetime, ...amounts } = reply.body;
  return amounts;
}

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
  const { trade } = run.read();
  // A trade key is shown its signing secret once, at creation, beside the key.
  expect(trade.secret, 'a trade key is shown a signing secret once, at creation').toMatch(/^ifs_[A-Za-z0-9_-]{20,}$/);

  // "signs the published test vector": this program's signer, given the vector's published parts and TEST secret,
  // makes exactly the canonical string and signature the running service published from its own signer.
  const { vector } = await signingPolicy();
  const parts = { method: vector.method, path: vector.path, timestamp: vector.timestamp, nonce: vector.nonce, body: vector.body };
  expect(canonical(parts)).toBe(vector.canonical);
  expect(sign(vector.secret, parts)).toBe(vector.signature);

  // "the server accepts it": a live request signed the same way with the key's own secret is answered.
  const before = await balance(trade);

  // "an altered request is refused as tampered": the body is changed after signing (a bigger order), and the path in
  // a second call. Each is refused with the one tampered code, and the account reads exactly as before: nothing held.
  const order = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1', clientOrderId: `jd04-${RUN}-1` };
  const alteredBody = await call('POST', '/api/v1/orders', { ...trade, body: order, sendBody: { ...order, amount: '1000' } });
  const alteredPath = await call('GET', '/api/v1/account/balance', { ...trade, tamper: '/api/v1/account/balance?x=1' });
  for (const altered of [alteredBody, alteredPath]) {
    expect(altered.status, JSON.stringify(altered.body)).toBe(401);
    expect(
      codeOf(altered),
      `Edge names a tampered request by its own code (svc-edge PR of DV-auth-01): ${JSON.stringify(altered.body)}`,
    ).toBe('edge.request_tampered');
  }
  expect(await balance(trade)).toEqual(before);

  // The same vector is published on the authentication page, field for field.
  await page.goto('/developers/authentication');
  await expect(page.getByRole('heading', { name: 'Authentication', level: 1 })).toBeVisible();
  const shown = page.getByTestId('developers-sign-vector');
  await expect(shown, 'the page shows the vector (portal PR of DV-auth-01)').toBeVisible(UNBUILT);
  for (const name of ['method', 'path', 'timestamp', 'nonce', 'body', 'secret', 'signature']) {
    expect((await shown.getByTestId(`vector-${name}`).textContent())?.trim(), name).toBe(vector[name]);
  }
});

test(`${J} #2 sends a timestamp just outside the owner window: the stale code; a reused nonce gives the replay code`, async () => {
  test.setTimeout(240_000);
  const { trade } = run.read();
  expect(trade.secret, 'a trade key is shown a signing secret once, at creation').toBeTruthy();
  // The window is the owner's value; the stack runs a TEST one (tooling/profiles/test-owner-values/identity.json).
  const { windowSeconds } = await signingPolicy();
  expect(windowSeconds).toBe(300);
  const now = Math.floor(Date.now() / 1000);
  const before = await balance(trade);

  // Just outside, both ways: older is stale, ahead has its own code. Just inside is still answered.
  const stale = await call('GET', '/api/v1/account/balance', { ...trade, timestamp: String(now - windowSeconds - 5) });
  const future = await call('GET', '/api/v1/account/balance', { ...trade, timestamp: String(now + windowSeconds + 5) });
  expect((await call('GET', '/api/v1/account/balance', { ...trade, timestamp: String(now - windowSeconds + 30) })).status).toBe(200);

  // A nonce used once is refused the second time; the first call was answered.
  const nonce = randomUUID();
  expect((await call('GET', '/api/v1/account/balance', { ...trade, nonce })).status).toBe(200);
  const replay = await call('GET', '/api/v1/account/balance', { ...trade, nonce });

  for (const [want, reply] of [
    ['edge.request_stale', stale],
    ['edge.request_future', future],
    ['edge.request_replay', replay],
  ]) {
    expect(reply.status, JSON.stringify(reply.body)).toBe(401);
    expect(codeOf(reply), `Edge names it by its own code (svc-edge PR of DV-auth-01): ${JSON.stringify(reply.body)}`).toBe(want);
  }
  expect(await balance(trade)).toEqual(before);

  // A blank owner window stays blank: every signed request is refused with the typed code, never a default window.
  blankSigningWindow(true);
  try {
    expect((await signingPolicy()).windowSeconds).toBeNull();
    const unset = await call('GET', '/api/v1/account/balance', trade);
    expect(codeOf(unset), `Edge names it by its own code (svc-edge PR of DV-auth-01): ${JSON.stringify(unset.body)}`).toBe(
      'edge.request_window_unset',
    );
  } finally {
    blankSigningWindow(false);
  }
  expect(await balance(trade)).toEqual(before);

  // The page publishes the same window.
  await page.goto('/developers/authentication');
  const shown = page.getByTestId('developers-sign-window');
  await expect(shown, 'the page shows the window (portal PR of DV-auth-01)').toBeVisible(UNBUILT);
  expect(Number((await shown.textContent())?.match(/\d+/)?.[0])).toBe(windowSeconds);
});

test(`${J} #3 sends a request with two invalid fields: one typed body listing both, with a request id and a docs link`, async () => {
  const { who, trade } = run.read();
  const clientOrderId = `jd04-${RUN}-3`;
  // Funded, so "nothing held" compares a real balance: a refused order would have held USDT.
  expect(fund(who.email, 'USDT', '1000').tx).toBeTruthy();
  const before = await balance(trade);
  expect(toUnits(before.balances?.USDT?.free) >= toUnits('1000'), JSON.stringify(before)).toBe(true);
  const reply = await call('POST', '/api/v1/orders', {
    ...trade,
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'sideways', amount: '-1', price: '1', clientOrderId },
  });
  // One typed body: the exchange code, the service's own code, and one entry per bad field, each exactly once.
  expect(reply.status, JSON.stringify(reply.body)).toBe(400);
  expect(reply.body).toMatchObject({ code: 'InvalidOrder', intafacedCode: 'trade.validation_failed', message: expect.any(String) });
  const fields = (reply.body.errors ?? []).map((error) => error.field).sort();
  expect(fields).toEqual(['amount', 'side']);
  // The request id in the body is the one Edge put on the reply's header; the docs link names the error page.
  expect(reply.body.requestId).toBeTruthy();
  expect(reply.body.requestId).toBe(reply.headers.get('x-request-id'));
  expect(reply.body.docs).toBe(`/developers/errors#${reply.body.intafacedCode}`);
  // The docs link opens the published entry for this refusal: its code, status and detail code as the reply sent them.
  await page.goto(reply.body.docs);
  const entry = page.locator(`tr[id="${reply.body.intafacedCode}"]`);
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('rowheader')).toHaveText(reply.body.code);
  await expect(entry.getByRole('cell').first()).toHaveText(String(reply.status));
  await expect(entry.getByRole('cell').nth(1)).toHaveText(reply.body.intafacedCode);
  // Refused, so nothing was placed and nothing was held.
  const placed = await call('GET', `/api/v1/orders/by-client-id/${clientOrderId}?symbol=BTC/USDT`, trade);
  expect(placed.status, JSON.stringify(placed.body)).toBe(404);
  expect(placed.body?.intafacedCode).toBe('trade.order_not_found');
  expect(await balance(trade)).toEqual(before);
});

test(`${J} #4 provokes a gateway refusal and a service error: the edge prefix tells them apart`, async () => {
  const { trade } = run.read();
  const before = await balance(trade);
  const gateway = await call('GET', '/api/v1/account/balance', { key: 'ifc_not_a_real_key_000000000000' });
  // Refused at the gateway: a key Edge cannot find, under Edge's own prefix.
  expect(gateway.status, JSON.stringify(gateway.body)).toBe(401);
  expect(codeOf(gateway)).toBe('edge.api_key_denied');
  expect(codeOf(gateway)).toMatch(/^edge\./);
  const service = await call('POST', '/api/v1/orders', {
    ...trade,
    body: { symbol: 'NOPE/USDT', type: 'limit', side: 'buy', amount: '1', price: '1', clientOrderId: `jd04-${RUN}-4` },
  });
  // Passed the gateway and refused by the trade service: its own typed code, with no Edge prefix.
  expect(service.status, JSON.stringify(service.body)).toBe(404);
  expect(service.body).toMatchObject({ code: 'BadSymbol', intafacedCode: 'trade.market_not_found' });
  expect(codeOf(service)).not.toMatch(/^edge\./);
  expect(service.body.intafacedCode).not.toMatch(/^edge\./);
  for (const reply of [gateway, service]) {
    expect(reply.body.requestId, JSON.stringify(reply.body)).toBeTruthy();
    expect(reply.body.requestId).toBe(reply.headers.get('x-request-id'));
  }
  // Both refused: the order does not exist and nothing was held.
  const placed = await call('GET', `/api/v1/orders/by-client-id/jd04-${RUN}-4?symbol=NOPE/USDT`, trade);
  expect(placed.status, JSON.stringify(placed.body)).toBe(404);
  expect(await balance(trade)).toEqual(before);
});

test(`${J} #5 calls with a missing, wrong, revoked or out-of-scope key: each body code matches the catalogue entry`, async () => {
  test.setTimeout(180_000);
  await page.goto('/developers/errors/auth');
  const catalogue = tableIn(page, /Authentication and permission errors/);
  await expect(catalogue).toBeVisible(UNBUILT);
  // The published entry for each cause, read before the keys are made: one row per cause, its code and its status.
  const published = {};
  for (const cause of ['missing', 'wrong', 'revoked', 'scope']) {
    const row = catalogue.getByRole('row', { name: new RegExp(cause, 'i') });
    await expect(row, cause).toHaveCount(1);
    published[cause] = {
      code: (await row.getByRole('rowheader').getByRole('code').textContent())?.trim(),
      status: (await row.getByRole('cell').first().textContent())?.trim(),
    };
  }

  const readOnly = await makeKey('bot-read', 'Read only');
  const revoked = await makeKey('bot-gone', 'Read only');
  await page.goto('/uc/safe/api-keys');
  await page
    .getByRole('row', { name: /bot-gone/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();

  const { trade } = run.read();
  const before = await balance(trade);
  const order = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.001', price: '1', clientOrderId: `jd04-${RUN}-5` };
  const cases = [
    ['missing', await call('GET', '/api/v1/account/balance', {})],
    ['wrong', await call('GET', '/api/v1/account/balance', { key: 'ifc_not_a_real_key_000000000000' })],
    ['revoked', await call('GET', '/api/v1/account/balance', revoked)],
    ['scope', await call('POST', '/api/v1/orders', { ...readOnly, body: order })],
  ];
  for (const [cause, reply] of cases) {
    expect({ code: codeOf(reply), status: String(reply.status) }, `${cause}: ${JSON.stringify(reply.body)}`).toEqual(published[cause]);
  }
  // The page publishes these exact typed codes, so a page that drifted with the service would still be caught.
  expect(published).toEqual({
    missing: { code: 'AuthenticationError', status: '401' },
    wrong: { code: 'edge.api_key_denied', status: '401' },
    revoked: { code: 'edge.api_key_revoked', status: '401' },
    scope: { code: 'PermissionDenied', status: '403' },
  });
  // Four refusals: the out-of-scope order does not exist, and the account holds what it held.
  const placed = await call('GET', `/api/v1/orders/by-client-id/${order.clientOrderId}?symbol=BTC/USDT`, trade);
  expect(placed.status, JSON.stringify(placed.body)).toBe(404);
  expect(placed.body?.intafacedCode).toBe('trade.order_not_found');
  expect(await balance(trade)).toEqual(before);
});

test(`${J} #7 reads the response headers: the request id and the server's received and sent times, sent not before received`, async () => {
  const { trade } = run.read();
  const asked = Date.now();
  const reply = await call('GET', '/api/v1/account/balance', trade);
  const answered = Date.now();
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  expect(reply.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  // Unix milliseconds from the server's clock, read between this program's send and receipt (the stack shares the clock).
  const received = Number(reply.headers.get('x-server-received'));
  const sent = Number(reply.headers.get('x-server-sent'));
  expect(received, 'x-server-received').toBeGreaterThanOrEqual(asked);
  expect(sent, 'x-server-sent').toBeLessThanOrEqual(answered);
  expect(sent).toBeGreaterThanOrEqual(received);
});

test(`${J} #6 calls from a frozen account, then a money call during the platform posting freeze: account_frozen, then posting_frozen while a read still works`, async () => {
  test.setTimeout(300_000);
  const { who, trade } = run.read();
  // A buy the account can pay for and the market accepts, resting under the book: only the freeze can refuse it.
  expect(fund(who.email, 'USDT', '1000').tx).toBeTruthy();
  const order = {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount: '0.001',
    price: await awayBid(90),
    clientOrderId: `jd04-${RUN}-6`,
  };
  // The platform posting freeze first, so the account is still open: a money call is refused, a read still works.
  tool('local-test-gates.mjs', 'posting-freeze', 'on');
  let failed;
  try {
    const before = await balance(trade);
    const money = await call('POST', '/api/v1/orders', { ...trade, body: order });
    // Refused before the engine: a 400 the client may correct by waiting, named for the ledger's freeze.
    expect(money.status, JSON.stringify(money.body)).toBe(400);
    expect(money.body).toMatchObject({ code: 'OnMaintenance', intafacedCode: 'posting_frozen' });
    // A read still works, and the refused order held nothing and does not exist.
    expect(await balance(trade)).toEqual(before);
    const placed = await call('GET', `/api/v1/orders/by-client-id/${order.clientOrderId}?symbol=BTC/USDT`, trade);
    expect(placed.status, JSON.stringify(placed.body)).toBe(404);
    expect(placed.body?.intafacedCode).toBe('trade.order_not_found');
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
  const open = await balance(trade);
  const userId = await staffFreeze(who);
  // The account freeze (svc-identity), not the posting freeze (svc-ledger): a read and a money call both name it.
  const frozen = await call('GET', '/api/v1/account/balance', trade);
  expect(frozen.status, JSON.stringify(frozen.body)).toBe(403);
  expect(codeOf(frozen)).toBe('account_frozen');
  const frozenMoney = await call('POST', '/api/v1/orders', {
    ...trade,
    body: { ...order, clientOrderId: `jd04-${RUN}-6b` },
  });
  expect(frozenMoney.status, JSON.stringify(frozenMoney.body)).toBe(403);
  expect(codeOf(frozenMoney)).toBe('account_frozen');
  // Lifted through the same control, the account reads as it did before the freeze: the refused order does not exist
  // and nothing was held.
  // The freeze ended the account's sessions and revoked its keys, and lifting it brings neither back: the account signs
  // in again and makes a new key to look.
  await staffRestore(userId);
  await signIn(page, who);
  const after = await makeKey('bot-after-freeze');
  const gone = await call('GET', `/api/v1/orders/by-client-id/jd04-${RUN}-6b?symbol=BTC/USDT`, after);
  expect(gone.status, JSON.stringify(gone.body)).toBe(404);
  expect(gone.body?.intafacedCode).toBe('trade.order_not_found');
  expect(await balance(after)).toEqual(open);
});
