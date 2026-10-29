import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, tool } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { addAuthenticator, forgetSession, nextCode } from './identity-factors.mjs';

/**
 * A person who may open a business: signed up, verified "full" by the stack's TEST operators, with an authenticator,
 * and signed in again with its code (opening a business needs a second factor). Lands on `destination`.
 */
export async function businessReadyPerson(page, prefix, destination = '/pay/merchant') {
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signInWithCode(page, who, '/uc/safe');
  const { secret, step } = await addAuthenticator(page, totp);
  Object.assign(who, { totp, secret, step });
  await forgetSession(page);
  await signInWithCode(page, who, destination);
  return who;
}

/**
 * The sign-in form, with the authenticator's next code once the person has one. The form is used only once the page's
 * own session check (`auth.refresh`) has answered: a sign-in sent while that answer lands is discarded by the form as
 * "sign-in context changed", which a person typing never meets but a script filling in 200 ms does.
 */
export async function signInWithCode(page, who, destination) {
  const restored = page.waitForResponse((r) => r.url().includes('auth.refresh'), { timeout: 10_000 }).catch(() => null);
  await page.goto(`/login?redirect=${encodeURIComponent(destination)}`);
  await restored;
  await expect(page.getByRole('button', { name: /^sign in$/i })).toBeEnabled();
  if (who.secret) {
    const { code, step } = await nextCode(who.totp, who.secret, who.step);
    who.step = step;
    await page.fill('input[name=totp]', code);
  }
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  const login = page.waitForResponse((r) => r.url().includes('auth.login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const sent = await (await login).json().catch(() => null);
  who.userId = (Array.isArray(sent) ? sent[0] : sent)?.result?.data?.userId ?? who.userId;
  await expect(page).toHaveURL(new RegExp(`${destination.replace(/[/.]/g, '\\$&')}$`));
}

/** Step 1 of setup, as the owner fills it: a TEST business with the stack's TEST starter fee. Stays on onboarding and
 * returns the new merchant's id. */
export async function openBusiness(page, who, legalName = 'TEST Merchant Ltd') {
  const created = page.waitForResponse((r) => r.url().includes('merchant.create') && r.request().method() === 'POST');
  await page.goto('/pay/onboarding/business');
  await page.getByLabel('Legal business name *').fill(legalName);
  await page.getByLabel('Country code *').fill('DE');
  await page.getByLabel('Type of business *').fill('online shop');
  await page.getByLabel('Contact email *').fill(who.email);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create my account' }).click();
  const sent = await (await created).json();
  await expect(page.getByText('Your merchant account exists.')).toBeVisible();
  return (Array.isArray(sent) ? sent[0] : sent).result.data.id;
}

/**
 * Once the stack's category table has categories (J-merchant-02 #7 adds one), approval needs a chosen category that
 * INTAFACED takes (RC-merchant-08). The owner picks a standard one if there is one, else the first taken one with its
 * terms set; an empty table asks nothing.
 */
async function chooseTakenCategory(page) {
  await page.goto('/pay/compliance');
  const section = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business category' }) });
  const all = section.getByRole('list', { name: 'Every category' });
  await expect(section.getByTestId('category-no-rule').or(all)).toBeVisible();
  if (!(await all.isVisible())) return;
  // A standard category (cards, crypto and bank transfer) first, so a journey's business can take every method whatever
  // categories earlier journeys added; otherwise the first one taken.
  const items = await all.getByRole('listitem').all();
  const texts = await Promise.all(items.map(async (item) => (await item.textContent()) ?? ''));
  // The class is the first fact under each category (CategoryFacts): its exact word, never a label that contains it.
  const classes = await Promise.all(items.map(async (item) => ((await item.locator('dd').first().textContent()) ?? '').trim()));
  const standard = (i) => classes[i] === 'Standard';
  const order = [...items.keys()].sort((x, y) => Number(!standard(x)) - Number(!standard(y)));
  for (const i of order) {
    const item = items[i];
    const text = texts[i];
    if (text.includes('Not taken') || text.includes('Not set.')) continue;
    await section.getByLabel('Your business category').selectOption({ label: await item.getAttribute('aria-label') });
    await section.getByRole('button', { name: 'Save category' }).click();
    await expect(section.getByText('Your category was saved.')).toBeVisible();
    return;
  }
}

/** Step 2 of setup: the owner sends a TEST verification reference, then the stack's founder pair approves it through
 * svc-pay's two-person door (`local-test-world.mjs approve-kyb`). The owner signs in again after, for the new grant. */
export async function verifiedBusiness(page, who, merchantId) {
  await chooseTakenCategory(page);
  await page.goto('/pay/onboarding/verification');
  await page.getByLabel('Verification file reference *').fill(`TEST-kyb-${who.handle}`);
  await page.getByRole('button', { name: 'Send for review' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  const decided = JSON.parse(tool('local-test-world.mjs', 'approve-kyb', merchantId).trim().split('\n').pop());
  expect(decided.kybStatus).toBe('approved');
}

/** Every pay call the page makes that the service refuses, as "status procedure". */
export function refusedPayCalls(page) {
  const refused = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/pay/') && res.status() >= 400)
      refused.push(`${res.status()} ${url.pathname.replace('/api/pay/trpc/', '')}`);
  });
  return refused;
}

/** A stable uuid for a journey key, so a retried create names the same thing (idempotency keys are business keys). */
export function uuidOf(seed) {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A person's own pay API through Edge, signed in with a session of its own and its authenticator's next code. `kept`
 * is told the code's time step, so the next sign-in waits for a fresh code.
 */
export async function payApiOf(who, kept) {
  const totp = (await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'))).totp;
  const next = await nextCode(totp, who.secret, who.step);
  kept(next.step);
  const send = async (route, body, token) => {
    const res = await fetch(`${EDGE}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* the body is kept as text for the error */
    }
    if (!res.ok || !json?.result) throw new Error(`${route} refused: ${res.status} ${text.slice(0, 400)}`);
    return json.result.data;
  };
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, totpCode: next.code }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in refused: ${JSON.stringify(login).slice(0, 300)}`);
  return {
    mutate: (procedure, input) => send(`/api/pay/trpc/${procedure}`, input, token),
    query: (procedure, input) => send(`/api/pay/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, undefined, token),
  };
}

/**
 * A TEST card payment on the stack's sandbox card rail (`tok_ok`, or `token`: `tok_funds_held` is captured with its funds
 * held by the acquirer until a `card-funds` report), paid: authorised and captured. `key` names it, so a
 * retried step finds the payment its first attempt made, wherever that attempt left it.
 */
export async function paidCardPayment(api, merchantId, { key, amount, assetId = 'USDT', token = 'tok_ok' }) {
  const created = await api.mutate('payment.create', {
    requestId: uuidOf(key),
    merchantId,
    amount,
    assetId,
    method: 'card',
    railAdapter: 'card-sandbox',
    metadata: { reference: key },
    instrument: { kind: 'card', token },
  });
  if (!['created', 'authorized'].includes(created.status)) return created;
  const authorized = created.status === 'created' ? await api.mutate('payment.authorize', { paymentId: created.id }) : created;
  if (authorized.status === 'captured') return authorized;
  // A declined or failed authorisation is returned as it is: capture is only asked of an authorised payment.
  if (authorized.status !== 'authorized') return authorized;
  return api.mutate('payment.capture', { paymentId: created.id });
}
