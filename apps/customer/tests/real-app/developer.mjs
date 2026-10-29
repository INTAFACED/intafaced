import { expect } from '@playwright/test';
import { EDGE, ORIGIN } from './stack.mjs';
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

/** Makes a live key through the form and returns its secret, read once from "Your new key". */
export async function makeKey(page, { name = 'bot-1', preset = 'Trade', ips = '' } = {}) {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel(preset, { exact: true }).check();
  await page.getByLabel('IP addresses (one per line, optional)').fill(ips);
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  return key;
}

/** One call to Edge with the key, as a developer's client sends it. */
export async function withKey(key, { method = 'GET', path, body, headers = {} }) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${EDGE}${path}`, {
    method,
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, ...(raw ? { 'content-type': 'application/json' } : {}), ...headers },
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
