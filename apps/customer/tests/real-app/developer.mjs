import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';
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
export function signedHeaders(secret, { method, path, body = '', timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID() }) {
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

/** One call to Edge with the key, as a developer's client sends it: signed when the key was shown a signing secret. */
export async function withKey(key, { method = 'GET', path, body, headers = {} }) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const secret = secrets.read()[keyRef(key)];
  const signed = secret ? signedHeaders(secret, { method, path, body: raw ?? '' }) : {};
  const res = await fetch(`${EDGE}${path}`, {
    method,
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, ...(raw ? { 'content-type': 'application/json' } : {}), ...signed, ...headers },
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
