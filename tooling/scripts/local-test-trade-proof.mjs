#!/usr/bin/env node
/**
 * S3 diagnostic against an ALREADY RUNNING fresh LOCAL TEST stack. No mocks.
 * prepare: create an isolated customer and self-submit LOCAL TEST KYC; operator
 * approval and local:fund are separate, parent-coordinated steps.
 * run: register a virtual passkey, sign in through the rendered button, buy the
 * smallest safe BTC amount through Review/Confirm, check fills and ledger balances.
 * recover: restore an interrupted virtual passkey, sign in, remove it, logout.
 * inspect-security: password sign-in and first-passkey UI availability only;
 * never enrolls a key or places an order, including when order intent exists.
 * Required: LOCAL_STACK_STATE=~/.intafaced/s3-trade-20261015 (expanded absolute),
 * S3_TRADE_RECEIPTS=<absolute private directory>. S3_BROWSER optionally selects
 * installed Chromium. Credentials/recovery material stay mode 0600, never stdout.
 * A persisted write intent prevents accidental second orders on reruns.
 * Abrupt termination retains trade-proof-operation.lock in the state root.
 * Before recover, the operator must verify its recorded PID is gone and clear
 * only that stale lock; this script never automatically steals a held lock.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertActiveLocalStack } from './local-test-state.mjs';

const mode = process.argv[2];
if (!['prepare', 'run', 'recover', 'inspect-security'].includes(mode)) throw Error('Use prepare, run, recover, or inspect-security');
const expectedState = path.join(os.homedir(), '.intafaced', 's3-trade-20261015');
if (process.env.LOCAL_STACK_STATE !== expectedState) throw Error('Refusing: explicitly select the fresh S3 state root');
const state = fs.realpathSync(expectedState);
if (state !== expectedState) throw Error('Refusing: fresh S3 root must not be a symlink');
const marker = JSON.parse(fs.readFileSync(path.join(state, 'LOCAL-TEST-STACK.json'), 'utf8'));
if (marker.kind !== 'intafaced-local-test-stack' || marker.ports?.customer !== 3210 || marker.ports?.edge !== 14500)
  throw Error('Refusing: expected LOCAL TEST stack marker and ports');
const dir = process.env.S3_TRADE_RECEIPTS;
if (!dir || !path.isAbsolute(dir)) throw Error('Set absolute S3_TRADE_RECEIPTS');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const accountFile = path.join(state, 'trade-proof-customer.json');
const recoveryFile = path.join(state, 'trade-proof-virtual-key-recovery.json');
const intentFile = path.join(state, 'trade-proof-write-intent.json');
const lockFile = path.join(state, 'trade-proof-operation.lock');
if (mode !== 'recover' && fs.existsSync(recoveryFile)) throw Error('Existing passkey recovery material: run recover first');
if (mode === 'run' && fs.existsSync(intentFile)) throw Error('Order write intent exists: inspect receipt; never repeat an uncertain order');
const origin = 'http://localhost:3210';
const receipt = {
  at: new Date().toISOString(),
  mode,
  origin,
  state,
  label: 'LOCAL TEST: isolated customer; synthetic prices and funds; real running services, no API mocks',
  checks: [],
  cleanup: [],
  errors: [],
  blockedExternal: [],
  realDevice: 'NOT VERIFIED: Chromium virtual authenticator is not Touch ID proof',
};
let account, token, passwordSession, authSession, browser, page, context, cdp, credentialId, lockHeld, expect;
function privateWrite(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function privateCreate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
function check(name, ok, evidence = {}) {
  const row = { name, ok, ...evidence };
  receipt.checks.push(row);
  console.log(JSON.stringify(row));
  if (!ok) throw Error(name);
}
async function http(route, { method = 'GET', body, bearer = token } = {}) {
  const target = new URL(route, origin);
  if (target.origin !== origin) throw Error('Refusing nonlocal HTTP target');
  // Also protects session creation/logout and WebAuthn mutations, not just orders.
  if (method !== 'GET') assertActiveLocalStack({ stateDir: state });
  const r = await fetch(target, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error(`HTTP ${r.status}: unreadable service response`);
  }
  return { status: r.status, data };
}
async function rpc(proc, input = {}, bearer = token, method = 'POST') {
  const r = await http(`/api/identity/trpc/${proc}${method === 'GET' ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''}`, {
    method,
    ...(method === 'POST' ? { body: input } : {}),
    bearer,
  });
  if (r.status !== 200)
    throw Error(`${proc}: HTTP ${r.status} (${r.data.error?.data?.cause?.code || r.data.error?.data?.code || 'refused'})`);
  return r.data.result.data;
}
async function read(route) {
  const r = await http('/api/v1' + route);
  if (r.status !== 200) throw Error(`${route}: HTTP ${r.status}`);
  return r.data;
}
// Exact decimal arithmetic; no floating point balance or fee comparisons.
const D = 40n,
  UNIT = 10n ** D;
function units(v) {
  if (typeof v !== 'string' || !/^\d+(\.\d{1,40})?$/.test(v)) throw Error('Expected exact nonnegative decimal');
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(Number(D), '0'));
}
function decimal(n) {
  const sign = n < 0n ? '-' : '';
  if (n < 0n) n = -n;
  const frac = (n % UNIT).toString().padStart(Number(D), '0').replace(/0+$/, '');
  return sign + (n / UNIT).toString() + (frac ? '.' + frac : '');
}
const ceilStep = (n, step) => ((n + step - 1n) / step) * step;
const balance = (b, asset) => units(b.balances?.[asset]?.total ?? '0');
// fmtAmount(...,{places:8}) in data/format.ts rounds half-up, except a
// nonzero amount below that precision retains its own digits (up to18).
function displayedUnits(v) {
  const amount = units(v),
    step = 10n ** 32n;
  const rounded = ((amount + step / 2n) / step) * step;
  return rounded === 0n && amount !== 0n ? amount : rounded;
}
function parseRendered(v, asset = '') {
  if (typeof v !== 'string') throw Error('Missing rendered amount');
  let plain = v.replace(/[,\s]/g, '');
  if (asset) {
    if (!plain.endsWith(asset)) throw Error('Rendered amount has wrong asset');
    plain = plain.slice(0, -asset.length);
  }
  return units(plain);
}

async function signIn(register, passwordOnly = false) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const playwright = createRequire(path.join(root, 'package.json'))('@playwright/test');
  const { chromium } = playwright;
  expect = playwright.expect;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.S3_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    args: ['--disable-background-networking'],
  });
  context = await browser.newContext({ viewport: { width: 1512, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' });
  // Requests are never fulfilled or replaced. The only interception is an
  // external-network refusal; same-origin requests reach the real stack.
  await context.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.origin === origin || ['data:', 'blob:'].includes(u.protocol)) return r.continue();
    receipt.blockedExternal.push(u.origin);
    return r.abort();
  });
  await context.routeWebSocket('**/*', (ws) => {
    const u = new URL(ws.url());
    if (u.hostname === 'localhost' && u.port === '3210') ws.connectToServer();
    else {
      receipt.blockedExternal.push(u.origin);
      ws.close();
    }
  });
  page = await context.newPage();
  receipt.orderRequests = [];
  let assertion;
  page.on('request', (r) => {
    if (r.url() === origin + '/api/identity/trpc/webauthn.authVerify') assertion = r.postDataJSON();
    if (r.url() === origin + '/api/v1/orders' && r.method() === 'POST') {
      const draft = r.postDataJSON();
      receipt.orderRequests.push({
        symbol: draft.symbol,
        side: draft.side,
        type: draft.type,
        amount: draft.amount,
        clientOrderId: draft.clientOrderId,
      });
    }
  });
  page.on('pageerror', (e) => receipt.errors.push(e.message));
  const response = await page.goto(origin + '/login?redirect=' + (passwordOnly ? '%2Fuc%2Fsafe' : '%2Ftrade%2Fspot%2FBTC-USDT'));
  check(
    'Rendered LOCAL TEST sign-in',
    response.status() === 200 && (await page.getByRole('button', { name: 'Use a passkey', exact: true }).isVisible()),
  );
  if (passwordOnly) {
    const verified = page.waitForResponse((r) => r.url() === origin + '/api/identity/trpc/auth.login', { timeout: 20000 });
    await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    assertActiveLocalStack({ stateDir: state });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const r = await verified,
      body = await r.json();
    check('Rendered password sign-in succeeds for customer handoff', r.status() === 200 && body.result?.data?.userId === account.userId);
    authSession = body.result.data;
    receipt.browserAuth = 'password';
    token = authSession.accessToken;
    await page.waitForURL(origin + '/uc/safe', { timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Add passkey', exact: true })).toBeEnabled({ timeout: 20000 });
    const keys = await rpc('webauthn.list', { limit: 200 }, token, 'GET');
    check(
      'Customer can enroll their first passkey after proof cleanup',
      keys.length === 0 && (await page.getByRole('button', { name: 'Add passkey', exact: true }).isVisible()),
    );
    check('Security inspection submitted no order', receipt.orderRequests.length === 0);
    await page.screenshot({ path: path.join(dir, 'trade-customer-security-ready.png'), fullPage: false });
    return;
  }
  cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (register) {
    const before = await rpc('webauthn.list', { limit: 200 }, token, 'GET');
    check('Isolated customer starts without passkeys', before.length === 0);
    const options = await rpc('webauthn.registerOptions');
    check(
      'Passkey uses localhost RP and secure browser context',
      options.rp.id === 'localhost' && (await page.evaluate(() => window.isSecureContext)),
    );
    const payload = await page.evaluate(async (options) => {
      const decode = (v) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
      const encode = (v) =>
        btoa(String.fromCharCode(...new Uint8Array(v)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const c = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: decode(options.challenge),
          user: { ...options.user, id: decode(options.user.id) },
          excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: decode(c.id) })),
        },
      });
      return {
        id: c.id,
        rawId: encode(c.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: encode(c.response.clientDataJSON),
          attestationObject: encode(c.response.attestationObject),
          transports: c.response.getTransports(),
        },
        clientExtensionResults: c.getClientExtensionResults(),
      };
    }, options);
    // Persist BEFORE server enrollment: an uncertain response must retain recovery.
    privateCreate(recoveryFile, {
      userId: account.userId,
      credentialPublicId: payload.id,
      ...(await cdp.send('WebAuthn.getCredentials', { authenticatorId })),
    });
    const registered = await rpc('webauthn.registerVerify', payload);
    credentialId = registered.credentialId;
    const saved = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    privateWrite(recoveryFile, { ...saved, credentialId });
  } else {
    const saved = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    check('Recovery belongs to dedicated customer', saved.userId === account.userId);
    credentialId = saved.credentialId;
    for (const credential of saved.credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  const verified = page.waitForResponse((r) => r.url() === origin + '/api/identity/trpc/webauthn.authVerify', { timeout: 20000 });
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(account.email);
  assertActiveLocalStack({ stateDir: state });
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  const r = await verified;
  const body = await r.json();
  check('Rendered button completes real WebAuthn assertion', r.status() === 200 && Boolean(body.result?.data?.accessToken));
  authSession = body.result.data;
  token = authSession.accessToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  check('Live passkey session has correct user and MFA', authSession.userId === account.userId && claims.mfa === true);
  await page.waitForURL(origin + '/trade/spot/BTC-USDT', { timeout: 20000 });
  const me = await rpc('me', {}, token, 'GET');
  check('Live principal matches dedicated customer', me.userId === account.userId);
  const replay = await http('/api/identity/trpc/webauthn.authVerify', { method: 'POST', body: assertion, bearer: null });
  check('Replaying browser assertion is refused', replay.status === 401);
  if (!credentialId) {
    // A registration response may have been lost; resolve the factor by its
    // public credential ID rather than deleting any unrelated credential.
    const saved = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    const keys = await rpc('webauthn.list', { limit: 200 }, token, 'GET');
    const own = keys.find((key) => key.credentialId === saved.credentialPublicId || key.id === saved.credentialPublicId);
    credentialId = own?.id ?? own?.credentialId;
  }
}

async function trade() {
  const text = await page.locator('body').innerText();
  check('Trade visibly labels LOCAL TEST', /LOCAL TEST/i.test(text));
  const markets = await read('/markets?limit=500');
  const market = markets.find((m) => m.symbol === 'BTC/USDT');
  check('Real BTC market is orderable', Boolean(market?.orderable));
  let book;
  await expect
    .poll(
      async () => {
        book = await read('/orderbook/BTC%2FUSDT?limit=200');
        return typeof book.asks?.[0]?.[0] === 'string' && /^\d+(\.\d+)?$/.test(book.asks[0][0]);
      },
      { timeout: 20000, message: 'Real order book must have a best ask before review' },
    )
    .toBe(true);
  const ask = units(book.asks?.[0]?.[0]);
  receipt.marketSnapshot = { bestAsk: book.asks[0][0], asks: book.asks.length, bids: book.bids.length, timestamp: book.timestamp };
  const lastPrice = page.getByLabel('Last price', { exact: true });
  await lastPrice.waitFor({ state: 'visible' });
  await expect(lastPrice).toHaveText(/^[\d,]+(?:\.\d+)?$/, { timeout: 20000 });
  const shownPrice = (await lastPrice.innerText()).replace(/[$,\s]/g, '');
  const shownAsk = page.locator('.dk-bk-row[data-side="ask"] .dk-bk-price').first();
  await shownAsk.waitFor({ state: 'visible' });
  await expect(shownAsk).toHaveText(/^[\d,]+(?:\.\d+)?$/, { timeout: 20000 });
  check(
    'LOCAL TEST Trade renders positive ticker and book prices',
    units(shownPrice) > 0n && parseRendered(await shownAsk.innerText()) > 0n,
    { ticker: shownPrice, visibleAsk: await shownAsk.innerText() },
  );
  await page.screenshot({ path: path.join(dir, 'trade-test-prices.png'), fullPage: false });
  const lot = units(market.precision.amount);
  const min = units(market.limits.amount.min ?? market.precision.amount);
  const minCost = units(market.limits.cost.min ?? '0');
  // At least min amount and 20% over notional minimum, rounded up to whole lots.
  const costSize = (minCost * 12n * UNIT + 10n * ask - 1n) / (10n * ask);
  const amount = decimal(
    ceilStep(
      [min, costSize, units('0.0001')].reduce((a, b) => (a > b ? a : b)),
      lot,
    ),
  );
  check('Proof order stays below 100 TEST USDT', (units(amount) * ask) / UNIT < units('100'), { amount, symbol: market.symbol });
  const before = await read('/account/balance');
  receipt.beforeBalances = before;
  check('Dedicated customer has enough TEST quote funds', balance(before, 'USDT') > (units(amount) * ask * 2n) / UNIT);
  await page.getByRole('tab', { name: 'Market', exact: true }).click();
  const form = page.locator('form[data-side="buy"]');
  await form.getByRole('textbox', { name: 'Amount', exact: true }).fill(amount);
  await form.getByRole('button', { name: 'Buy BTC', exact: true }).click({ timeout: 20000 });
  const review = page.getByRole('alertdialog');
  await review.getByRole('heading', { name: 'Review your buy', exact: true }).waitFor();
  receipt.reviewText = await review.innerText();
  await page.screenshot({ path: path.join(dir, 'trade-review.png'), fullPage: false });
  const quoteBefore = await form.locator('.dk-avail dd').first().innerText();
  privateCreate(intentFile, {
    at: new Date().toISOString(),
    userId: account.userId,
    symbol: market.symbol,
    amount,
    purpose: 'One UI confirmation only. Inspect live orders before considering another run.',
  });
  const placed = page.waitForResponse((r) => r.url() === origin + '/api/v1/orders' && r.request().method() === 'POST', { timeout: 25000 });
  assertActiveLocalStack({ stateDir: state });
  await review.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  const response = await placed;
  const order = await response.json();
  receipt.order = order;
  check(
    'UI submitted exactly one live closed buy order',
    receipt.orderRequests.length === 1 &&
      response.status() >= 200 &&
      response.status() < 300 &&
      order.side === 'buy' &&
      order.status === 'closed' &&
      units(order.remaining) === 0n &&
      units(order.filled) === units(amount),
    { status: response.status(), orderId: order.id },
  );
  await form.getByRole('status').filter({ hasText: 'Your buy order filled:' }).waitFor({ timeout: 15000 });
  check('Rendered fill confirmation visible', true, { message: await form.getByRole('status').innerText() });
  await page.getByRole('tab', { name: 'Trade history', exact: true }).click();
  await page.locator('.dk-bottom-body:visible table tbody tr').first().waitFor({ timeout: 20000 });
  receipt.visibleTradeHistory = await page.locator('.dk-bottom-body:visible table').innerText();
  const fills = (await read('/account/trades?symbol=BTC%2FUSDT&limit=100')).filter((f) => f.order === order.id);
  receipt.fills = fills;
  check(
    'Live fill belongs to submitted order',
    fills.length > 0 && fills.every((f) => f.side === 'buy') && fills.reduce((s, f) => s + units(f.amount), 0n) === units(amount),
    { count: fills.length },
  );
  const after = await read('/account/balance');
  receipt.afterBalances = after;
  const fee = (asset) => fills.reduce((s, f) => s + (f.fee?.currency === asset ? units(f.fee.cost) : 0n), 0n);
  const bought = fills.reduce((s, f) => s + units(f.amount), 0n);
  const spent = fills.reduce((s, f) => s + units(f.cost), 0n);
  const baseDelta = balance(after, 'BTC') - balance(before, 'BTC');
  const quoteDelta = balance(before, 'USDT') - balance(after, 'USDT');
  check(
    'Actual ledger projection changed by exact fill amounts and fees',
    baseDelta === bought - fee('BTC') && quoteDelta === spent + fee('USDT'),
    { testBTCReceived: decimal(baseDelta), testUSDTSpent: decimal(quoteDelta) },
  );
  const available = form.locator('.dk-avail dd').first();
  const expectedQuote = displayedUnits(after.balances.USDT.free);
  await available.waitFor({ state: 'visible' });
  await page.waitForFunction(
    (expected) => {
      const e = document.querySelector('form[data-side="buy"] .dk-avail dd');
      return e && e.getClientRects().length > 0 && e.innerText.replace(/[,\s]/g, '') === expected + 'USDT';
    },
    decimal(expectedQuote),
    { timeout: 20000 },
  );
  const renderedQuote = await available.innerText();
  check(
    'Visible Available quote matches post-fill ledger and changed',
    parseRendered(renderedQuote, 'USDT') === expectedQuote && parseRendered(quoteBefore, 'USDT') !== expectedQuote,
    {
      before: quoteBefore,
      after: renderedQuote,
    },
  );
  await page.screenshot({ path: path.join(dir, 'trade-filled.png'), fullPage: false });
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();
  await page.locator('.dk-bottom-body:visible table tbody tr').first().waitFor();
  receipt.visibleAssets = await page.locator('.dk-bottom-body:visible table').innerText();
  for (const asset of ['BTC', 'USDT']) {
    const row = page
      .locator('.dk-bottom-body:visible table tbody tr')
      .filter({ has: page.getByRole('cell', { name: asset, exact: true }) });
    await row.waitFor({ state: 'visible' });
    const cells = await row.getByRole('cell').allTextContents();
    check(
      `Visible ${asset} Assets row matches post-fill ledger`,
      ['total', 'free', 'used'].every((field, i) => parseRendered(cells[i + 1]) === displayedUnits(after.balances[asset][field])),
    );
  }
  await page.screenshot({ path: path.join(dir, 'trade-balances.png'), fullPage: false });
  receipt.tradeResult = 'PASS: rendered passkey sign-in, one UI buy, fill, exact ledger changes and visible balances';
  // SessionProvider intentionally keeps credentials in memory. Use the same
  // History/popstate navigation as app/location.ts; a document reload signs out.
  await page.evaluate(() => {
    history.pushState(null, '', '/uc/safe');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  check(
    'Customer can enroll their own passkey from Security',
    await page.getByRole('button', { name: 'Add passkey', exact: true }).isEnabled(),
  );
  check('Customer UI completed without JavaScript errors', receipt.errors.length === 0);
}

try {
  assertActiveLocalStack({ stateDir: state });
  privateCreate(lockFile, { pid: process.pid, at: receipt.at, mode });
  lockHeld = true;
  // Recheck under the exclusive lock: changing receipt folders cannot bypass
  // the account's write intent or strand another simultaneous factor change.
  if (mode !== 'recover' && fs.existsSync(recoveryFile)) throw Error('Existing passkey recovery material: run recover first');
  if (mode === 'run' && fs.existsSync(intentFile)) throw Error('Order write intent exists: inspect before any further order');
  if (mode === 'prepare' && !fs.existsSync(accountFile))
    privateWrite(accountFile, {
      label: 'LOCAL TEST customer; no real identity or money',
      handle: 'local_test_trade_proof',
      email: 'local-test-trade-proof@local-test.invalid',
      password: crypto.randomBytes(24).toString('base64url'),
    });
  account = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  if (account.handle !== 'local_test_trade_proof' || account.email !== 'local-test-trade-proof@local-test.invalid')
    throw Error('Refusing: dedicated LOCAL TEST customer fixture mismatch');
  if (mode === 'prepare' && !account.userId) {
    const existing = await http('/api/identity/trpc/auth.login', {
      method: 'POST',
      body: { identifier: account.email, password: account.password },
      bearer: null,
    });
    if (existing.status === 200) passwordSession = existing.data.result.data;
    else if (existing.status === 401)
      passwordSession = await rpc('auth.register', { handle: account.handle, email: account.email, password: account.password }, null);
    else throw Error(`Cannot determine dedicated account: login HTTP ${existing.status}`);
    account.userId = passwordSession.userId;
    privateWrite(accountFile, account);
  } else passwordSession = await rpc('auth.login', { identifier: account.email, password: account.password }, null);
  token = passwordSession.accessToken;
  check('Dedicated LOCAL TEST customer authenticated', passwordSession.userId === account.userId, { userId: account.userId });
  if (mode === 'prepare') {
    const submission = account.kycSubmission ?? (await rpc('kyc.submit', { tier: 'full', jurisdiction: 'ZZ' }));
    account.kycSubmission = { id: submission.id };
    privateWrite(accountFile, account);
    check('Customer self-submitted explicitly synthetic KYC', Boolean(submission.id), { requestId: submission.id, jurisdiction: 'ZZ' });
    receipt.nextAction = 'Parent: approve this LOCAL TEST request and locally fund the dedicated email before run.';
    receipt.credentialsFile = accountFile;
  } else if (mode === 'inspect-security') {
    await signIn(false, true);
  } else {
    let needsSignIn = true;
    if (mode === 'recover') {
      const saved = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
      check('Recovery belongs to dedicated customer', saved.userId === account.userId);
      const keys = await rpc('webauthn.list', { limit: 200 }, token, 'GET');
      if (!keys.some((key) => key.credentialId === saved.credentialPublicId)) {
        fs.unlinkSync(recoveryFile);
        receipt.cleanup.push({ action: 'registration did not persist; no server factor to remove', ok: true });
        needsSignIn = false;
      }
    }
    if (needsSignIn) await signIn(mode === 'run');
    if (mode === 'run') await trade();
  }
} catch (e) {
  receipt.failure = e.message;
  process.exitCode = 1;
  console.log('FAILURE', e.message);
  if (page) {
    try {
      await page.screenshot({ path: path.join(dir, `trade-${mode}-failure.png`), fullPage: false, mask: [page.locator('input,textarea')] });
    } catch {
      /* Main failure remains authoritative. */
    }
  }
} finally {
  if (credentialId && authSession) {
    try {
      const removed = await rpc('webauthn.remove', { credentialId }, authSession.accessToken);
      receipt.cleanup.push({ action: 'remove harness-created virtual passkey', removed: removed.removed });
      if (removed.removed) fs.unlinkSync(recoveryFile);
      else process.exitCode = 1;
    } catch (e) {
      receipt.cleanup.push({ action: 'remove passkey', error: e.message });
      process.exitCode = 1;
    }
  }
  if (fs.existsSync(recoveryFile)) {
    receipt.cleanup.push({ action: 'recovery needed', path: recoveryFile });
    process.exitCode = 1;
  }
  for (const [name, session] of [
    [receipt.browserAuth ?? 'passkey', authSession],
    ['password', passwordSession],
  ]) {
    if (!session?.refreshToken) continue;
    try {
      await rpc('auth.logout', { refreshToken: session.refreshToken }, session.accessToken);
      receipt.cleanup.push({ action: `logout ${name} session`, ok: true });
    } catch (e) {
      receipt.cleanup.push({ action: `logout ${name} session`, error: e.message });
      process.exitCode = 1;
    }
  }
  if (browser) await browser.close();
  if (lockHeld) fs.unlinkSync(lockFile);
  receipt.result = process.exitCode ? 'FAIL: inspect failure and cleanup' : `PASS: ${mode} checks and cleanup`;
  privateWrite(path.join(dir, `trade-${mode}-result-${receipt.at.replace(/[:.]/g, '-')}.json`), receipt);
  console.log('RESULT', receipt.result);
  console.log('RECEIPTS', dir);
}
