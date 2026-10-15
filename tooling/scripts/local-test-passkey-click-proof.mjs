#!/usr/bin/env node
/** Auth-only proof against the held S3 LOCAL TEST stack. Never uses the trade
 * customer, real profile, real keys, balances, KYC, or order endpoints.
 * LOCAL_STACK_STATE must explicitly select S3; PASSKEY_CLICK_EVIDENCE must be
 * an absolute private directory. A new auth-only account/profile is created
 * per run. Virtual credential material is private and removed after cleanup.
 * Native get is called through with a bounded abort: this is NOT Touch ID proof.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertActiveLocalStack } from './local-test-state.mjs';

const state = path.join(os.homedir(), '.intafaced/s3-trade-20261015');
if (process.env.LOCAL_STACK_STATE !== state) throw Error('Select the fresh S3 LOCAL TEST state explicitly');
const dir = process.env.PASSKEY_CLICK_EVIDENCE;
if (!dir || !path.isAbsolute(dir)) throw Error('Set absolute PASSKEY_CLICK_EVIDENCE');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const origin = 'http://localhost:3210';
const stamp = crypto.randomBytes(6).toString('hex');
const fixtureFile = path.join(dir, `auth-only-fixture-${stamp}.json`);
const fixture = {
  label: 'LOCAL TEST auth-only account; no identity or money',
  handle: `pk_click_${stamp}`,
  email: `passkey-click-${stamp}@local-test.invalid`,
  password: crypto.randomBytes(24).toString('base64url'),
};
const receipt = {
  at: new Date().toISOString(),
  label: 'Headed Brave; real LOCAL TEST services; separate auth-only fixture; no API fulfillment',
  checks: [],
  network: [],
  console: [],
  pageErrors: [],
  cleanup: [],
  platformSuccess: 'UNVERIFIED: native browser request is bounded and aborted; Nitro must approve their own Touch ID',
};
const sessions = new Map();
let virtual, native, mfa, credentialId, cdp, authenticatorId;
const privateWrite = () => {
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  fs.chmodSync(fixtureFile, 0o600);
};
function check(name, ok, evidence = {}) {
  const row = { name, ok, ...evidence };
  receipt.checks.push(row);
  console.log(JSON.stringify(row));
  if (!ok) throw Error(name);
}
function remember(session) {
  if (session?.refreshToken) sessions.set(session.refreshToken, session);
  return session;
}
async function rpc(procedure, input, session) {
  assertActiveLocalStack({ stateDir: state });
  const response = await fetch(`${origin}/api/identity/trpc/${procedure}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { origin, 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}) },
    body: JSON.stringify(input),
  });
  if (response.status !== 200) throw Error(`${procedure}: HTTP ${response.status}`);
  return (await response.json()).result.data;
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, expect } = createRequire(path.join(root, 'package.json'))('@playwright/test');
async function browser(kind) {
  const context = await chromium.launchPersistentContext(path.join(dir, `brave-${kind}-${stamp}`), {
    executablePath: process.env.PASSKEY_CLICK_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
    if (route.request().method() !== 'GET') assertActiveLocalStack({ stateDir: state });
    return route.continue();
  });
  const page = context.pages()[0];
  page.setDefaultTimeout(15000);
  page.on('console', (message) => receipt.console.push({ kind, type: message.type(), text: message.text().slice(0, 300) }));
  page.on('pageerror', (error) => receipt.pageErrors.push({ kind, message: error.message }));
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/identity/trpc/')) return;
    receipt.network.push({ kind, method: response.request().method(), path: url.pathname, status: response.status() });
    if (/\/(auth\.login|webauthn\.authVerify)$/.test(url.pathname) && response.status() === 200)
      remember((await response.json()).result.data);
  });
  return { context, page };
}
async function login(page) {
  await page.goto(origin + '/login?redirect=%2Fuc%2Fsafe');
  await page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(origin + '/uc/safe');
}
async function signout(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  const revoked = page.waitForResponse((response) => response.url().endsWith('/auth.logout'));
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  check('Rendered sign-out revokes its session', (await revoked).status() === 200);
  // The app keeps the current private room, showing its native Sign in link.
  await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
  await page.waitForURL((url) => url.pathname === '/login');
}
async function blank(page, label) {
  const start = receipt.network.length;
  const email = page.getByRole('textbox', { name: 'Email or handle', exact: true });
  await expect(email).toHaveValue('');
  await page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Enter your email or handle before using a passkey.' })).toBeVisible();
  await expect(email).toBeFocused();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  check(label, !receipt.network.slice(start).some((row) => /authOptions|authVerify|auth.login/.test(row.path)));
}
try {
  assertActiveLocalStack({ stateDir: state });
  privateWrite();
  const registration = remember(await rpc('auth.register', { handle: fixture.handle, email: fixture.email, password: fixture.password }));
  fixture.userId = registration.userId;
  privateWrite();
  virtual = await browser('virtual');
  await virtual.page.goto(origin + '/login');
  await blank(virtual.page, 'Fresh blank identifier gives feedback/focus without authentication');
  cdp = await virtual.context.newCDPSession(virtual.page);
  await cdp.send('WebAuthn.enable');
  ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  await login(virtual.page);
  const registered = virtual.page.waitForResponse((response) => response.url().endsWith('/webauthn.registerVerify'));
  await virtual.page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await virtual.page.getByRole('dialog').getByRole('button', { name: 'Add passkey', exact: true }).click();
  const registeredResponse = await registered;
  check('Auth-only virtual key enrolled by rendered Security button', registeredResponse.status() === 200);
  credentialId = (await registeredResponse.json()).result.data.credentialId;
  fixture.credentialId = credentialId;
  fixture.virtualRecovery = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  privateWrite();
  await signout(virtual.page);
  await blank(virtual.page, 'After sign-out blank identifier gives feedback/focus without authentication');
  await virtual.page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(fixture.email);
  await expect(virtual.page.getByLabel('Password', { exact: true })).toHaveValue('');
  const verified = virtual.page.waitForResponse((response) => response.url().endsWith('/webauthn.authVerify'));
  await virtual.page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  const verifiedResponse = await verified;
  check('Actual passkey button with empty password verifies through real services', verifiedResponse.status() === 200);
  mfa = remember((await verifiedResponse.json()).result.data);
  const claims = JSON.parse(Buffer.from(mfa.accessToken.split('.')[1], 'base64url').toString());
  check('Passkey session belongs to auth-only customer and has MFA', mfa.userId === fixture.userId && claims.mfa === true);
  await virtual.page.waitForURL(origin + '/uc/safe');
  await signout(virtual.page);

  native = await browser('native');
  await login(native.page);
  await signout(native.page);
  await blank(native.page, 'Real browser profile after sign-out retains actionable blank validation');
  // Call the native method with the actual server options. No credential, API
  // response or successful assertion is fabricated. Abort only bounds automation.
  await native.page.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    window.__passkeyClickNative = { calls: 0, settled: false };
    navigator.credentials.get = async (options) => {
      window.__passkeyClickNative.calls++;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 2000);
      try {
        return await get({ ...options, signal: AbortSignal.any([options.signal, abort.signal]) });
      } finally {
        clearTimeout(timer);
        window.__passkeyClickNative.settled = true;
      }
    };
  });
  await native.page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(fixture.email);
  await expect(native.page.getByLabel('Password', { exact: true })).toHaveValue('');
  const optionsResponse = native.page.waitForResponse((response) => response.url().endsWith('/webauthn.authOptions'));
  await native.page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
  check('Headed native profile button receives real authOptions', (await optionsResponse).status() === 200);
  await expect.poll(() => native.page.evaluate(() => window.__passkeyClickNative.calls)).toBe(1);
  await expect.poll(() => native.page.evaluate(() => window.__passkeyClickNative.settled), { timeout: 6000 }).toBe(true);
  check('Headed native navigator.credentials.get called through exactly once', true);
  await expect(native.page.getByRole('button', { name: 'Use a passkey', exact: true })).toBeEnabled();
  check(
    'Bounded native request never invents verification',
    !receipt.network.some((row) => row.kind === 'native' && row.path.endsWith('/webauthn.authVerify')),
  );
  await native.page.screenshot({ path: path.join(dir, 'native-after-signout.png'), mask: [native.page.locator('input')] });
  check('No browser JavaScript errors', receipt.pageErrors.length === 0);
} catch (error) {
  receipt.failure = error.message;
  process.exitCode = 1;
} finally {
  if (credentialId && mfa) {
    try {
      // The UI logout revoked this session, so create a fresh assertion through
      // the same isolated virtual authenticator before removing only its key.
      await virtual.page.getByRole('textbox', { name: 'Email or handle', exact: true }).fill(fixture.email);
      const verified = virtual.page.waitForResponse((response) => response.url().endsWith('/webauthn.authVerify'));
      await virtual.page.getByRole('button', { name: 'Use a passkey', exact: true }).click();
      const response = await verified;
      if (response.status() !== 200) throw Error('Cleanup passkey sign-in refused');
      mfa = remember((await response.json()).result.data);
      const removed = await rpc('webauthn.remove', { credentialId }, mfa);
      if (!removed.removed) throw Error('Cleanup did not remove harness key');
      delete fixture.virtualRecovery;
      delete fixture.credentialId;
      privateWrite();
      receipt.cleanup.push({ action: 'Removed only new auth-only fixture virtual key', ok: true });
    } catch (error) {
      receipt.cleanup.push({ action: 'Remove auth-only virtual key', ok: false, error: error.message });
      process.exitCode = 1;
    }
  }
  for (const session of sessions.values()) {
    try {
      await rpc('auth.logout', { refreshToken: session.refreshToken }, session);
      receipt.cleanup.push({ action: 'Revoke own test session', ok: true });
    } catch (error) {
      receipt.cleanup.push({ action: 'Revoke own test session', ok: false, error: error.message });
      process.exitCode = 1;
    }
  }
  if (fixture.virtualRecovery) {
    receipt.cleanup.push({ action: 'Private virtual recovery retained; cleanup required', ok: false, path: fixtureFile });
    process.exitCode = 1;
  }
  await native?.context.close();
  await virtual?.context.close();
  receipt.verdict = process.exitCode ? 'FAIL' : 'PASS (native Touch ID success remains unverified)';
  fs.writeFileSync(path.join(dir, `auth-click-${stamp}.json`), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({ verdict: receipt.verdict, failure: receipt.failure, checks: receipt.checks.length, cleanup: receipt.cleanup }),
  );
}
