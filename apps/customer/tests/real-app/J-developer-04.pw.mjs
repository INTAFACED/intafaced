import { test, expect } from '@playwright/test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { EDGE, ORIGIN, ROOT, journeyState, staffFreeze, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-04, in the running app (docs/roadmap/journeys.json): sign requests and understand the errors I get back.
// One test per step, titled "J-developer-04 #<n>", run in order. #1 makes the journey's start: a verified TEST account
// with a passkey creates a live trade key that requires signed requests, and keeps its key and signing secret in the run
// file (mode 600). Requests are signed the published way: HMAC-SHA256 over "INTAFACED-REQ-V1", method, path, timestamp,
// nonce and the body's SHA-256, one per line (svc-edge api-key-request-sign.ts), sent in x-intafaced-request-* headers.
// The acceptance window is the stack's TEST value. Every refusal is checked against the published error catalogue.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Authentication section publishes no page with the test vector, and the key form has no "Require signed
//   requests" choice, so no signing secret is ever shown.
// - #3, #5: no published error catalogue and no docs link in an error body.
// - #4: no edge prefix that tells a gateway refusal from a service error.
// - #6: no stack tool sets the platform posting freeze (`local-test-gates.mjs posting-freeze`).
// - #7: no server received and sent time headers.
const J = 'J-developer-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const VERSION = 'INTAFACED-REQ-V1';
const canonical = ({ method, path, timestamp, nonce, bodyHash }) =>
  [VERSION, method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
const sign = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');

/** Sends a request with the key, signed unless `signed` is false; `alter` changes the request after it is signed. */
async function call({ key, secret, method = 'GET', path = '/api/v1/account/balance', body, timestamp, nonce, signed = true, alter }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const n = nonce ?? randomUUID();
  const bodyHash = createHash('sha256').update(raw).digest('hex');
  const headers = { origin: ORIGIN, authorization: `Bearer ${key}`, ...(raw ? { 'content-type': 'application/json' } : {}) };
  if (signed) {
    headers['x-intafaced-request-timestamp'] = ts;
    headers['x-intafaced-request-nonce'] = n;
    headers['x-intafaced-request-signature'] = sign(secret, canonical({ method, path, timestamp: ts, nonce: n, bodyHash }));
  }
  const sent = alter ? alter({ method, path, raw }) : { method, path, raw };
  const res = await fetch(`${EDGE}${sent.path}`, { method: sent.method, headers, body: sent.raw || undefined });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* kept as text */
  }
  return { status: res.status, headers: res.headers, body: parsed, nonce: n };
}

/** The published error catalogue: code -> entry. */
async function catalogue() {
  const res = await fetch(`${ORIGIN}/developers/errors.json`);
  expect(res.status, 'the error catalogue is published').toBe(200);
  const entries = await res.json();
  return new Map(entries.map((e) => [e.code, e]));
}

const codeOf = (body) => body?.error?.code ?? body?.code;

test(`${J} #1 signs the published test vector: the server accepts it; an altered request is refused as tampered`, async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  try {
    await virtualAuthenticator(page);
    const dev = await signUp(page, 'jdsig');
    await verify(page, dev);
    await signIn(page, dev);
    await addPasskey(page);
    run.reset({ dev });

    // The published vector: the page's canonical string and secret give its signature.
    await page.goto('/developers/authentication');
    const vector = page.getByRole('region', { name: 'Test vector' });
    await expect(vector).toBeVisible(UNBUILT);
    const text = await vector.getByTestId('vector-canonical').innerText();
    const secret = await vector.getByTestId('vector-secret').innerText();
    expect(sign(secret.trim(), text.replace(/\r/g, ''))).toBe((await vector.getByTestId('vector-signature').innerText()).trim());

    // A live trade key that requires signed requests.
    await page.goto('/uc/safe/api-keys/new');
    await page.getByLabel('Key name').fill('signer-1');
    await page.getByLabel('Trade', { exact: true }).check();
    await page.getByLabel('Require signed requests').check();
    await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
    const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
    const signing = (await page.getByTestId('api-keys__signing-secret').locator('code').textContent())?.trim();
    run.write({ key, secret: signing });
  } finally {
    await page.context().close();
  }
  const key = state('key');
  const secret = state('secret');
  const ok = await call({ key, secret });
  expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBe(200);
  const tampered = await call({ key, secret, alter: (r) => ({ ...r, path: '/api/v1/account/balance?x=1' }) });
  expect(tampered.status).toBe(401);
  expect(codeOf(tampered.body)).toMatch(/tampered/);
});

test(`${J} #2 sends a timestamp just outside the window: stale; a reused nonce: replay`, async () => {
  const key = state('key');
  const secret = state('secret');
  const { REQUEST_SIGN_WINDOW_SECONDS: window } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/api-key-request-sign.js'));
  const stale = await call({ key, secret, timestamp: String(Math.floor(Date.now() / 1000) - window - 5) });
  expect(stale.status).toBe(401);
  expect(codeOf(stale.body)).toMatch(/stale/);
  const first = await call({ key, secret });
  expect(first.status).toBe(200);
  const again = await call({ key, secret, nonce: first.nonce });
  expect(again.status).toBe(401);
  expect(codeOf(again.body)).toMatch(/replay/);
});

test(`${J} #3 sends a request with two invalid fields: one typed body listing both, with a request id and a docs link`, async () => {
  const res = await call({
    key: state('key'),
    secret: state('secret'),
    method: 'POST',
    path: '/api/v1/orders',
    body: { symbol: 'BTC/USDT', type: 'limit', side: 'sideways', amount: '-1', price: '1' },
  });
  expect(res.status).toBe(400);
  const fields = (res.body?.error?.fields ?? []).map((f) => f.field).sort();
  expect(fields).toEqual(['amount', 'side']);
  expect(res.body?.error?.requestId ?? res.headers.get('x-request-id')).toBeTruthy();
  expect(res.body?.error?.docs).toMatch(/\/developers\/errors#/);
});

test(`${J} #4 provokes a gateway refusal and a service error: the edge prefix tells them apart`, async () => {
  const key = state('key');
  const secret = state('secret');
  // A route Edge doesn't serve is the gateway's; an order on an unknown market is the trading service's.
  const gateway = await call({ key, secret, path: '/api/v1/no-such-route' });
  const service = await call({
    key,
    secret,
    method: 'POST',
    path: '/api/v1/orders',
    body: { symbol: 'NOPE/USDT', type: 'limit', side: 'buy', amount: '1', price: '1' },
  });
  expect(codeOf(gateway.body)).toMatch(/^edge\./);
  expect(codeOf(service.body)).toMatch(/^trade\./);
});

test(`${J} #5 calls with a missing, wrong, revoked or out-of-scope key: each body code matches its catalogue entry`, async () => {
  const known = await catalogue();
  const secret = state('secret');
  const cases = [
    ['missing', await fetch(`${EDGE}/api/v1/account/balance`, { headers: { origin: ORIGIN } })],
    [
      'wrong',
      await fetch(`${EDGE}/api/v1/account/balance`, { headers: { origin: ORIGIN, authorization: 'Bearer ifc_wrong_key_000000000000' } }),
    ],
  ];
  for (const [what, res] of cases) {
    const body = await res.json().catch(() => null);
    expect(known.has(codeOf(body)), `${what}: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
  }
  // A trade key calling a withdrawal route: a scope no key may hold.
  const scope = await call({ key: state('key'), secret, method: 'DELETE', path: '/api/v1/account/withdrawals/x' });
  expect(known.has(codeOf(scope.body)), JSON.stringify(scope.body).slice(0, 200)).toBe(true);
});

test(`${J} #6 calls from a frozen account, then a money call during the posting freeze: account_frozen, then posting_frozen; reads work`, async () => {
  const dev = state('dev');
  const key = state('key');
  const secret = state('secret');
  const order = { symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1' };
  // The platform-wide posting freeze (svc-ledger's), set and cleared by the stack's TEST founders: a money call is
  // refused, a read still works.
  tool('local-test-gates.mjs', 'posting-freeze', 'on');
  try {
    const money = await call({ key, secret, method: 'POST', path: '/api/v1/orders', body: order });
    expect(codeOf(money.body)).toMatch(/posting_frozen/);
    const read = await call({ key, secret });
    expect(read.status).toBe(200);
  } finally {
    tool('local-test-gates.mjs', 'posting-freeze', 'off');
  }
  // Then this one account frozen by staff (svc-identity's): its money call is refused as frozen.
  await staffFreeze(dev, 'LOCAL TEST J-developer-04 freeze');
  const frozen = await call({ key, secret, method: 'POST', path: '/api/v1/orders', body: order });
  expect(codeOf(frozen.body)).toMatch(/account_frozen/);
});

test(`${J} #7 reads the response headers: the request id, server received and sent times, sent not before received`, async () => {
  const res = await call({ key: state('key'), secret: state('secret') });
  expect(res.headers.get('x-request-id')).toBeTruthy();
  const received = res.headers.get('x-server-received-at');
  const sent = res.headers.get('x-server-sent-at');
  expect(received, 'x-server-received-at').toBeTruthy();
  expect(Date.parse(sent)).toBeGreaterThanOrEqual(Date.parse(received));
});
