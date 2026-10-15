#!/usr/bin/env node
/**
 * Captured S3 local-stack diagnostic, not a product authentication implementation.
 * Requires an already running LOCAL TEST stack and its existing market taker fixture.
 * Registers a temporary virtual passkey, clicks the rendered passkey sign-in button,
 * checks the live principal and replay refusal, removes the key, and logs out.
 * Run from the dependency-equipped stack checkout with S3_STACK_REPO and
 * S3_SIGNIN_RECEIPTS set to absolute directories. S3_BROWSER optionally selects
 * an already installed Chromium executable. No dependency install or service restart.
 * Recovery key material, if needed after a failed verification, stays only in the
 * receipt directory with mode 0600; never commit that directory.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
const root = process.env.S3_STACK_REPO;
const dir = process.env.S3_SIGNIN_RECEIPTS;
if (!root || !dir || !path.isAbsolute(root) || !path.isAbsolute(dir))
  throw Error('Set absolute S3_STACK_REPO and S3_SIGNIN_RECEIPTS directories');
const state = path.join(os.homedir(), '.intafaced', 'local-test-stack');
const marker = JSON.parse(fs.readFileSync(path.join(state, 'LOCAL-TEST-STACK.json')));
if (marker.ports?.customer !== 3210) throw Error('Expected existing LOCAL TEST stack on customer port 3210');
fs.mkdirSync(dir, { recursive: true });
if (fs.existsSync(path.join(dir, 'signin-virtual-key-recovery.json')))
  throw Error('Existing virtual-key recovery receipt requires review before a new run');
const require = createRequire(root + '/package.json');
const { chromium } = require('@playwright/test');
const fixture = JSON.parse(fs.readFileSync(path.join(state, 'market-accounts.json'))).taker;
const url = 'http://localhost:3210';
const receipt = {
  at: new Date().toISOString(),
  origin: url,
  fixture: 'existing LOCAL TEST market taker (no credentials copied)',
  browser: 'installed Brave Chromium, headless, fresh profile',
  checks: [],
  errors: [],
  cleanup: [],
};
let browser, context, page, token, authSession, credentialId, registrationToken, passwordSession;
function check(name, result) {
  receipt.checks.push({ name, ...result });
  console.log(JSON.stringify(receipt.checks.at(-1)));
}
async function rpc(proc, input = {}, bearer = token, method = 'POST') {
  const route = url + '/api/identity/trpc/' + proc + (method === 'GET' ? '?input=' + encodeURIComponent(JSON.stringify(input)) : '');
  const response = await fetch(route, {
    method,
    headers: { origin: url, 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  return { status: response.status, data: body.result?.data, error: body.error };
}
function requireOK(name, result) {
  check(name, { status: result.status, ok: result.status === 200, errorCode: result.error?.data?.cause?.code || result.error?.data?.code });
  if (result.status !== 200) throw Error(name + ' HTTP ' + result.status);
  return result.data;
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.S3_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  });
  context = await browser.newContext();
  page = await context.newPage();
  // Guard against accidental external service use. No request is mocked or fulfilled.
  await context.route('**/*', (r) => {
    const u = new URL(r.request().url());
    return ['localhost', '127.0.0.1'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol) ? r.continue() : r.abort();
  });
  page.on('pageerror', (e) => receipt.errors.push(e.message));
  await page.goto(url + '/login?redirect=%2Ftrade');
  check('served customer sign-in', {
    http: 200,
    passkeyButton: await page.getByRole('button', { name: 'Use a passkey', exact: true }).count(),
    localTestBanner: (await page.locator('body').innerText()).includes('balances are test funds'),
  });
  const session = requireOK(
    'existing test fixture password login',
    await rpc('auth.login', { identifier: fixture.email, password: fixture.password }, null),
  );
  if (session.userId !== fixture.userId) throw Error('fixture identity mismatch');
  token = session.accessToken;
  registrationToken = token;
  passwordSession = session;
  const before = requireOK('credential list before', await rpc('webauthn.list', { limit: 200 }, token, 'GET'));
  check('existing credentials', { count: before.length });
  const cdp = await context.newCDPSession(page);
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
  const options = requireOK('live registration options', await rpc('webauthn.registerOptions', {}));
  check('RP and origin configuration', {
    rpId: options.rp.id,
    secureContext: await page.evaluate(() => window.isSecureContext),
    origin: new URL(page.url()).origin,
  });
  if (options.rp.id !== 'localhost') throw Error('unexpected RP');
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
        excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: decode(c.id) })),
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
  const registration = requireOK('live registration verify', await rpc('webauthn.registerVerify', payload));
  credentialId = registration.credentialId;
  // Kept only until cleanup, so a failed verification never strands a test-account factor.
  fs.writeFileSync(
    dir + '/signin-virtual-key-recovery.json',
    JSON.stringify({ fixture: 'market taker', ...(await cdp.send('WebAuthn.getCredentials', { authenticatorId })) }),
    { mode: 0o600 },
  );
  let verifyPayload;
  page.on('request', (request) => {
    if (request.url().includes('/webauthn.authVerify')) verifyPayload = request.postDataJSON();
  });
  const verifyResponse = page.waitForResponse((r) => r.url().includes('/webauthn.authVerify'), { timeout: 15000 });
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(fixture.email);
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  const response = await verifyResponse;
  const verifyBody = await response.json();
  authSession = requireOK('rendered passkey button → native assertion → live authVerify', {
    status: response.status(),
    data: verifyBody.result?.data,
    error: verifyBody.error,
  });
  token = authSession.accessToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  check('session issued by live identity', { matchesFixture: authSession.userId === fixture.userId, mfa: claims.mfa === true });
  if (authSession.userId !== fixture.userId || claims.mfa !== true) throw Error('wrong session claims');
  await page.waitForURL(url + '/trade', { timeout: 15000 });
  check('customer UI redirect', {
    url: page.url(),
    localTestBanner: (await page.locator('body').innerText()).includes('balances are test funds'),
  });
  const me = requireOK('authenticated live me through customer → edge → identity', await rpc('me', {}, token, 'GET'));
  check('authenticated principal', { matchesFixture: me.userId === fixture.userId });
  if (me.userId !== fixture.userId) throw Error('principal mismatch');
  const sig = Buffer.from(verifyPayload.credential.response.signature, 'base64url');
  check('browser assertion format', { ASN1_DER: sig[0] === 0x30, bytes: sig.length });
  const replay = await rpc('webauthn.authVerify', verifyPayload, null);
  check('replayed assertion rejected', { status: replay.status, rejected: replay.status === 401 });
  if (replay.status !== 401) throw Error('replay not rejected');
  await page.screenshot({ path: dir + '/signin-trade-after-passkey.png', fullPage: false, mask: [page.locator('input,textarea')] });
  receipt.customerResult = 'PASS: real browser WebAuthn with virtual authenticator against existing running services; no API mocks';
} catch (e) {
  receipt.failure = e.message;
  console.log('FAILURE', e.message);
  process.exitCode = 1;
} finally {
  if (credentialId && authSession) {
    try {
      const result = await rpc('webauthn.remove', { credentialId }, authSession.accessToken);
      receipt.cleanup.push({
        action: 'remove harness-created passkey through live API',
        status: result.status,
        removed: result.data?.removed,
      });
      if (result.data?.removed) {
        fs.unlinkSync(dir + '/signin-virtual-key-recovery.json');
      } else process.exitCode = 1;
    } catch (e) {
      receipt.cleanup.push({ error: e.message });
      process.exitCode = 1;
    }
  }
  for (const s of [authSession, passwordSession]) {
    if (!s?.refreshToken) continue;
    try {
      const r = await rpc('auth.logout', { refreshToken: s.refreshToken }, s.accessToken);
      receipt.cleanup.push({
        action: s === authSession ? 'logout passkey test session' : 'logout password test session',
        status: r.status,
      });
    } catch (e) {
      receipt.cleanup.push({ error: e.message });
    }
  }

  if (browser) await browser.close();
  receipt.founderResult =
    'NOT VERIFIED: existing local stack marker provides customer only; no admin/founder app endpoint configured or started. No founder account impersonated.';
  receipt.realDevice = 'NOT VERIFIED: virtual authenticator is not Touch ID proof.';
  fs.writeFileSync(dir + '/signin-live-result.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log('RECEIPT', dir + '/signin-live-result.json');
  console.log('CLEANUP', JSON.stringify(receipt.cleanup));
}
