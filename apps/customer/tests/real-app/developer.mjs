import { createHash, createHmac, randomUUID } from 'node:crypto';
import { API_VERSION_HEADER, LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { expect } from './journey.mjs';
import { EDGE, ORIGIN, journeyState, json, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// Developer journeys' shared start: a verified TEST account with a passkey (only such an account may hold a key, and
// the passkey gives each create its fresh step-up) and a live key made through /uc/safe/api-keys/new. Passkeys belong
// to the relying party `localhost`, so the page runs on http://localhost:3210 with Chromium's virtual authenticator.

/** A signed-in passkey account on its own page, ready to make keys. */
export async function keyHolder(browser, prefix) {
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signIn(page, who);
  await addPasskey(page);
  return { page, who };
}

/** A signed-out visitor on a device of its own. */
export async function signedOutVisitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** The same holder signed in again on a fresh page (no new passkey: reading keys needs no step-up). */
export async function holderAgain(browser, who) {
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await signIn(page, who);
  return page;
}

// A key that places orders is shown a signing secret once, beside the key, and every request it sends must be signed
// (INTAFACED-REQ-V1). The secret is kept in this run's state file (mode 0600, keyed by the key's hash) so a later step
// that only holds the key can still sign, as the developer's program would.
const secrets = journeyState(`developer-signing-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const keyRef = (key) => createHash('sha256').update(key).digest('hex');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The three signature headers for one request, as the published test vector computes them. */
export function signedHeaders(
  secret,
  { method, path, body = '', timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID() },
) {
  const canonical = ['INTAFACED-REQ-V1', method.toUpperCase(), path, timestamp, nonce, sha256(body)].join('\n');
  return {
    'x-intafaced-request-timestamp': timestamp,
    'x-intafaced-request-nonce': nonce,
    'x-intafaced-request-signature': createHmac('sha256', secret).update(canonical).digest('hex'),
  };
}

/** Makes a live key through the form and returns its secret, read once from "Your new key" (with its signing secret, if shown, kept for withKey). */
export async function makeKey(page, { name = 'bot-1', preset = 'Trade', ips = '' } = {}) {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel(preset, { exact: true }).check();
  await page.getByLabel('IP addresses (one per line, optional)').fill(ips);
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  const secretBox = page.getByTestId('api-keys__signing-secret');
  if (key && (await secretBox.count())) secrets.write({ [keyRef(key)]: (await secretBox.locator('code').textContent())?.trim() });
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  return key;
}

/** The API version header every key client we ship sends: the newest version, pinned at release (J-developer-16 #5). */
export const VERSION_PIN = { [API_VERSION_HEADER]: LATEST_API_VERSION };

/**
 * One call to Edge with the key, as a developer's client sends it: signed when the key was shown a signing secret, and
 * pinned to the newest API version (`intafaced-version`), as every key client we ship sends its release-time version.
 * `version: null` sends no version header (J-developer-16 #5); any other value is sent as it is.
 */
export async function withKey(key, { method = 'GET', path, body, headers = {}, version = LATEST_API_VERSION }) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const secret = secrets.read()[keyRef(key)];
  const signed = secret ? signedHeaders(secret, { method, path, body: raw ?? '' }) : {};
  const res = await fetch(`${EDGE}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${key}`,
      ...(raw ? { 'content-type': 'application/json' } : {}),
      ...signed,
      ...(version === null ? {} : { [API_VERSION_HEADER]: version }),
      ...headers,
    },
    body: raw,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* kept as text */
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

export const codeOf = (body) => body?.error?.data?.code ?? body?.error?.code ?? body?.code;

/** The running identity service's published signing policy: the owner's window and the TEST vector its own signer made. */
export async function signingPolicy() {
  const reply = await json(await fetch(`${EDGE}/api/identity/trpc/requestSigningPolicy`));
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.result.data;
}

/** Identity restarted with the request-signing window blank (as production is until the owner sets it), or back on the stack's TEST value. */
export function blankSigningWindow(blank) {
  const before = process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW;
  if (blank) process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW = 'off';
  else delete process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW;
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW;
    else process.env.LOCAL_STACK_IDENTITY_REQUEST_SIGN_WINDOW = before;
  }
}

/** A prepared venue payload (svc-trade's `/api/v1/venue/prepare`), signed by one key: a program's own signing, no SDK. */
export async function signPrepared(account, prepared) {
  const t = prepared.typedData;
  const signature = await account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: account.address.toLowerCase() };
}
