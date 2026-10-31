import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
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

/**
 * Puts a business on its TEST tier through the two founders (`tooling/scripts/local-test-merchant-pricing.mjs`) and returns
 * what they read back. Asynchronous, so the worker keeps answering Playwright while the founders sign in, which can wait out
 * TOTP steps.
 */
export async function merchantTier(merchantId, kind = 'open') {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-merchant-pricing.mjs'), merchantId, '--tier', kind],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000 },
  );
  return JSON.parse(stdout.trim().split('\n').pop());
}

/** Step 1 of setup, as the owner fills it: a TEST business with the stack's TEST starter fee. Stays on onboarding and
 * returns the new merchant's id. The stack enforces merchant controls (PAY_MERCHANT_CONTROLS=required), so the founders
 * then put the business on its TEST tier, with TEST intake caps and a TEST fee, before any journey takes a payment. */
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
  const merchantId = (Array.isArray(sent) ? sent[0] : sent).result.data.id;
  expect((await merchantTier(merchantId)).onTier, `the founders put ${merchantId} on its TEST tier`).toBe(true);
  return merchantId;
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
  await sentForReview(page, who);
  approveKyb(merchantId);
}

/** The owner chooses a category and sends the verification reference from /pay/onboarding/verification; it reads In review. */
export async function sentForReview(page, who) {
  await chooseTakenCategory(page);
  await page.goto('/pay/onboarding/verification');
  await page.getByLabel('Verification file reference *').fill(`TEST-kyb-${who.handle}`);
  await page.getByRole('button', { name: 'Send for review' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
}

/** The stack's TEST founder pair approves the business's verification (svc-pay's KYB decision door). */
export function approveKyb(merchantId) {
  const decided = JSON.parse(tool('local-test-world.mjs', 'approve-kyb', merchantId).trim().split('\n').pop());
  expect(decided.kybStatus).toBe('approved');
  return decided;
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
  // A refusal keeps its status and whole body, so a step can read the service's code past the message.
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
    if (!res.ok || !json?.result)
      throw Object.assign(new Error(`${route} refused: ${res.status} ${text.slice(0, 400)}`), { status: res.status, body: text });
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
    /** The same person after "Confirm it's you" (`auth.stepUpPay` with a fresh code): a token that may refund or pay out. */
    async steppedUp(merchantId, scopes, totpCode) {
      const minted = await send('/api/identity/trpc/auth.stepUpPay', { merchantId, scopes, factorProof: { totpCode } }, token);
      return { mutate: (procedure, input) => send(`/api/pay/trpc/${procedure}`, input, minted.accessToken) };
    },
    /** The same query, answered whole (status and parsed body) and never thrown, so a step can read a refusal's typed code. */
    answer: async (procedure, input) => {
      const res = await fetch(`${EDGE}/api/pay/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, {
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
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

/** The rooms whose header action moves money out: Pay out or Issue a refund. */
export const MONEY_ROOMS = ['/pay/money', '/pay/payouts', '/pay/payouts/destinations', '/pay/settlements', '/pay/refunds'];

/** The rooms that list the business's own records, so a new business has none and each must say so honestly. */
const LIST_ROOMS = [
  '/pay/payments',
  '/pay/links',
  '/pay/products',
  '/pay/refunds',
  '/pay/disputes',
  '/pay/customers',
  '/pay/invoices',
  '/pay/subscriptions',
  '/pay/payouts',
  '/pay/payouts/destinations',
  '/pay/settlements',
  '/pay/conversion',
  '/pay/developer/keys',
];

/** What an honest empty room shows: the kit's empty state, the card naming what it waits for, or a refusal in words. */
const HONEST =
  '[data-slot="state-block"][data-kind="empty"], [data-slot="state-block"][data-kind="refused"], [data-testid="pfo-soon"], [data-testid="failure"]';

/** Every room the portal's navigation reaches from the page, with its own address. */
async function navRooms(page) {
  const hrefs = await page.locator('nav a[href^="/pay/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  return [...new Set(hrefs)];
}

/**
 * The person opens each room from navigation, starting at the business home: each shows its own heading and finishes
 * loading, never "no access", never an error block or an uncertain failure, no refused read, no console error, and no
 * room asks the founder's console for anything. A room that lists the business's records shows an honest state for a
 * new business: the kit's empty state, the card naming what it waits for, or a typed refusal in words. Each room whose
 * header action moves money out records that action as drawn (`action`). Returns each room and the states it showed.
 */
export async function everyRoomOpens(page) {
  const refused = refusedPayCalls(page);
  const errors = [];
  const asked = [];
  const onConsole = (msg) => msg.type() === 'error' && errors.push(msg.text());
  const onRequest = (req) => req.url().includes('/api/') && asked.push(req.url());
  page.on('console', onConsole);
  page.on('request', onRequest);
  await page.goto('/pay/merchant');
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('nav a[href^="/pay/"]').first()).toBeVisible();
  const visited = new Map();
  const queue = await navRooms(page);
  while (queue.length) {
    const room = queue.shift();
    if (visited.has(room)) continue;
    await page.goto(room);
    const content = page.getByTestId('pp');
    await expect(page.locator('main h1').first(), room).toBeVisible();
    await expect(content.locator('[data-slot="state-block"][data-kind="loading"]'), `${room} finishes loading`).toHaveCount(0);
    await expect(page.getByText('You don’t have access'), room).toHaveCount(0);
    await expect(content.locator('[data-slot="state-block"][data-kind="error"]'), `${room} shows no error`).toHaveCount(0);
    await expect(content.locator('[data-testid="failure"][role="alert"]'), `${room} shows no uncertain failure`).toHaveCount(0);
    if (LIST_ROOMS.includes(room))
      await expect(content.locator(HONEST).first(), `${room}: a new business's list says honestly that it is empty`).toBeVisible();
    const states = {
      empty: await content.locator('[data-slot="state-block"][data-kind="empty"]').count(),
      waiting: await content.getByTestId('pfo-soon').count(),
      refused:
        (await content.locator('[data-slot="state-block"][data-kind="refused"]').count()) + (await content.getByTestId('failure').count()),
    };
    for (const block of await content.locator('[data-slot="state-block"][data-kind="empty"], [data-testid="pfo-soon"]').all())
      await expect(block, `${room}: the state says something`).not.toHaveText(/^\s*$/);
    if (MONEY_ROOMS.includes(room)) {
      // The room's own money action, as drawn: a live link and where it goes, or switched off with its reason.
      const head = page.getByTestId('plo-heading');
      const off = head.locator('.pfo-action-off');
      states.action = (await off.count())
        ? { off: await off.locator('small').innerText() }
        : { on: await head.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))) };
    }
    visited.set(room, states);
    for (const next of await navRooms(page)) if (!visited.has(next)) queue.push(next);
  }
  page.off('console', onConsole);
  page.off('request', onRequest);
  expect(visited.size).toBeGreaterThan(20);
  for (const room of [...LIST_ROOMS, ...MONEY_ROOMS]) expect([...visited.keys()], `${room} is reached`).toContain(room);
  expect(refused).toEqual([]);
  expect(errors).toEqual([]);
  expect(asked.filter((url) => /founderAdmin/i.test(url))).toEqual([]);
  return visited;
}
