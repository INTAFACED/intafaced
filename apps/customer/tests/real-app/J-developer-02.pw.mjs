import path from 'node:path';
import { test, expect } from '@playwright/test';
import { EDGE, ROOT, api, json, journeyState, tool, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, forgetSession, nextCode, virtualAuthenticator } from './identity-factors.mjs';
import { openBusiness, signInWithCode, verifiedBusiness } from './merchant.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-developer-02, in the running app (docs/roadmap/journeys.json): make a first call in the sandbox. One test per step,
// titled "J-developer-02 #<n>". The person is a TEST account on the local stack that owns a TEST business the stack's
// operators approved (pay permissions come only from that grant, with no sandbox temporary grant), signed in with its
// authenticator code, with a passkey for each fresh step-up (as in J-developer-03) and no keys yet. Sandbox funds are TEST and never reach the live ledger, which the steps
// check by reading the live balance before and after.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #6: the clock check measures against the edge's fixed signing window, not an owner-set one (DV-auth-01).
// - #4, #5, #8: no sandbox funds, reset cap or test values (DV-sandbox-02). The stack starts with the funding decision
//   unset; #5 sets a TEST value with `local-test-gates.mjs sandbox-funds set` (proposed, not built).
// - #7: no door refuses a sandbox key at the live host with `env.mismatch`.
const J = 'J-developer-02';
const RUN = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${RUN}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

/** @type {import('@playwright/test').Page} */
let page;

const sandboxes = () => tableIn(page, 'Your sandboxes');

async function openSandbox(name) {
  await page.goto('/developers/sandbox');
  await expect(page.getByRole('textbox', { name: 'Sandbox name' })).toBeVisible(UNBUILT);
  await page.waitForLoadState('networkidle');
  const link = sandboxes().getByRole('link', { name, exact: true });
  // A worker restart after a failure signs up a new account, which has no sandbox from #2 yet.
  if (!(await link.count())) {
    await page.getByRole('textbox', { name: 'Sandbox name' }).fill(name);
    await page.getByRole('button', { name: 'Create sandbox' }).click();
  }
  await link.click(UNBUILT);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

const sandboxBalance = async () =>
  toUnits(((await page.getByTestId('sandbox-balance').textContent()) ?? '').match(/([\d,.]+)\s*USDT/)?.[1]?.replaceAll(',', '') ?? '0');

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = await signUp(page, 'sb');
  await verify(page, who);
  // An approved TEST business (as J-merchant-02 sets one up): opening it needs a second factor, and the owner signs in
  // again after approval for the pay grant.
  await signInWithCode(page, who, '/uc/safe');
  const { secret, step } = await addAuthenticator(page, totp);
  Object.assign(who, { totp, secret, step });
  await forgetSession(page);
  await signInWithCode(page, who, '/pay/merchant');
  const merchantId = await openBusiness(page, who);
  await verifiedBusiness(page, who, merchantId);
  await forgetSession(page);
  await signInWithCode(page, who, '/uc/safe');
  delete who.totp;
  await addPasskey(page);
  // write, not reset: a worker restart after a failure keeps what earlier steps stored (the key from #3).
  run.write({ who });
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 follows the trading quickstart: account, key, clock check, first call`, async () => {
  await page.goto('/developers');
  await page.getByRole('link', { name: 'Quickstart', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quickstart', level: 1 })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Quickstart steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(4);
  for (const [i, step] of ['account', 'key', 'clock', 'first call'].entries()) {
    await expect(steps.nth(i)).toContainText(new RegExp(step, 'i'));
  }
  // Each step leads somewhere real: the key step opens the key room, the clock step reads the server, the first call
  // opens the reference that lists the time route.
  await expect(steps.nth(0).getByRole('link')).toHaveAttribute('href', '/register');
  await expect(steps.nth(2).getByRole('button', { name: 'Check my clock' })).toBeVisible();
  await steps.nth(1).getByRole('link').click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  await expect(page.getByRole('heading', { name: 'Keys on this account' })).toBeVisible();
  await page.goBack();
  await steps.nth(3).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('GET /api/v1/time');
});

/** One sign-in through the edge as the account, with its authenticator's next code, kept for this worker. */
let signedIn = null;
async function account(who) {
  if (!signedIn) {
    const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
    const { code, step } = await nextCode(totp, who.secret, who.step);
    who.step = step;
    run.write({ who });
    signedIn = await api(who, code);
  }
  return signedIn;
}

/** What identity holds for this account's sandboxes, read through the edge as the account (not from the page). */
async function sandboxRecords(who) {
  const res = await (await account(who)).get('/api/identity/trpc/developerSandboxes.list');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

async function sandboxDetail(who, sandboxId) {
  const input = encodeURIComponent(JSON.stringify({ sandboxId }));
  const res = await (await account(who)).get(`/api/identity/trpc/developerSandboxes.get?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Identity restarted with the owner's sandbox cap blank, or back on the stack's TEST cap (as J-identity-08 #5 does). */
function identitySandboxCap(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP;
  else process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP;
    else process.env.LOCAL_STACK_IDENTITY_SANDBOX_CAP = before;
  }
}

async function createSandboxNamed(name) {
  await page.getByRole('textbox', { name: 'Sandbox name' }).fill(name);
  await page.getByRole('button', { name: 'Create sandbox' }).click();
}

test(`${J} #2 creates a sandbox with a name: listed, a second named sandbox works, and with the sandbox cap blank the second refuses`, async () => {
  test.setTimeout(240_000);
  const { who } = run.read();
  // beforeAll signs up a new account, so it holds no sandbox yet.
  expect((await sandboxRecords(who)).sandboxes).toEqual([]);
  await page.goto('/developers/sandbox');
  await expect(page.getByRole('heading', { name: 'Sandbox', level: 1 })).toBeVisible();

  // "sandbox with a name listed": on the page and in identity's own record.
  await createSandboxNamed('development');
  await expect(sandboxes().getByRole('row', { name: /^development\b/ })).toBeVisible();
  expect((await sandboxRecords(who)).sandboxes.map((sandbox) => sandbox.name)).toEqual(['development']);

  // "with the sandbox cap blank the second refuses": identity restarted with the cap blank refuses by its code, and
  // nothing is written.
  identitySandboxCap(false);
  try {
    await page.reload();
    await expect(page.getByTestId('sandbox-cap')).toHaveAttribute('data-limit', 'unset');
    await createSandboxNamed('ci');
    await expect(page.getByRole('alert')).toHaveAttribute('data-code', 'identity.sandbox_cap_unset');
    await expect(bodyRows(sandboxes())).toHaveCount(1);
    const held = await sandboxRecords(who);
    expect(held.sandboxes.map((sandbox) => sandbox.name)).toEqual(['development']);
    expect(held.cap).toEqual({ limit: null, held: 1 });
  } finally {
    identitySandboxCap(true);
  }

  // "a second named sandbox (development, CI, UAT) works" once the stack's TEST cap is back.
  await page.reload();
  await expect(page.getByTestId('sandbox-cap')).toHaveAttribute('data-limit', '3');
  for (const name of ['ci', 'uat']) {
    await createSandboxNamed(name);
    await expect(sandboxes().getByRole('row', { name: new RegExp(`^${name}\\b`) })).toBeVisible();
  }
  await expect(bodyRows(sandboxes())).toHaveCount(3);
  const made = await sandboxRecords(who);
  expect(made.sandboxes.map((sandbox) => sandbox.name)).toEqual(['development', 'ci', 'uat']);
  expect(made.cap).toEqual({ limit: 3, held: 3 });
});

test(`${J} #3 creates a sandbox key: shown once with the sandbox base URL, sandbox-safe scopes only, and a trade scope is refused for that reason`, async () => {
  const { who } = run.read();
  await openSandbox('development');
  const sandboxId = /\/developers\/sandbox\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)?.[1];
  expect(sandboxId, page.url()).toBeTruthy();
  expect((await sandboxDetail(who, sandboxId)).keys).toEqual([]);

  // "trade scope refused for that reason": a sandbox serves no trading, so the refusal is env.scope_not_sandboxable and
  // no key is made.
  await page.getByRole('link', { name: 'Create a sandbox key' }).click();
  await page.getByLabel('Key name').fill('sandbox-trade');
  await page.getByLabel('Trade', { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveAttribute('data-code', 'env.scope_not_sandboxable');
  await expect(page.getByRole('alert')).toContainText('can’t be used in a sandbox');
  expect((await sandboxDetail(who, sandboxId)).keys).toEqual([]);

  // "sandbox key shown once with sandbox base URL".
  await page.getByLabel('Key name').fill('sandbox-first');
  await page.getByLabel('Read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').textContent())?.trim();
  expect(key).toMatch(/^ifc_test_/);
  const baseUrl = (await page.getByTestId('sandbox-base-url').textContent())?.trim();
  // The address shown is identity's sandbox address, and that is the edge's sandbox host on this stack (EDGE_SANDBOX_HOSTS
  // is localhost at the edge's port; the live host is 127.0.0.1).
  expect(baseUrl).toBe((await sandboxRecords(who)).baseUrl);
  expect(baseUrl).toBe(`http://localhost:${new URL(EDGE).port}`);
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'development', level: 1 })).toBeVisible();
  expect(await page.content()).not.toContain(key);

  // "only sandbox-safe scopes": the one key identity holds for this sandbox is a sandbox key with the read scope only.
  const { keys } = await sandboxDetail(who, sandboxId);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatchObject({ name: 'sandbox-first', mode: 'sandbox', scopes: ['pay:read'], revoked: false });
  expect(key.startsWith(keys[0].prefix)).toBe(true);
  run.write({ key, baseUrl });
});

test(`${J} #4 presses Fund while the owner decision is unset: a typed refusal naming the decision, nothing written`, async () => {
  await openSandbox('development');
  const before = await sandboxBalance();
  await page.getByRole('button', { name: 'Fund with TEST money' }).click();
  await expect(page.getByRole('alert')).toContainText('The owner has not set sandbox test funds. Nothing was added.');
  expect(await sandboxBalance()).toBe(before);
});

test(`${J} #5 funds the sandbox once the decision is set: the sandbox balance rises, labelled TEST, and the live book is untouched`, async () => {
  const { who } = run.read();
  const live = await (await account(who)).balances();
  tool('local-test-gates.mjs', 'sandbox-funds', 'set');
  await openSandbox('development');
  const before = await sandboxBalance();
  await page.getByRole('button', { name: 'Fund with TEST money' }).click();
  await expect.poll(sandboxBalance).toBeGreaterThan(before);
  await expect(page.getByTestId('sandbox-balance')).toContainText('TEST');
  expect(await (await account(who)).balances()).toEqual(live);
});

test(`${J} #6 runs the clock check: the offset against the server, and within the owner's window it passes`, async () => {
  await page.goto('/developers/quickstart');
  await page.getByRole('button', { name: 'Check my clock' }).click(UNBUILT);
  const result = page.getByTestId('developers-clock-check');
  await expect(result).toContainText(/Offset\s*-?\d+ ms/);
  await expect(result).toContainText('Within the window');
});

test(`${J} #7 sends the first signed call: success in the sandbox, and the same key at the live host is refused with the environment mismatch code`, async () => {
  const { key, baseUrl } = run.read();
  expect(key, 'a sandbox key from #3').toBeTruthy();
  const at = (host) => fetch(`${host}/api/v1/account/balance`, { headers: { authorization: `Bearer ${key}` } }).then(json);
  const sandbox = await at(baseUrl);
  expect(sandbox.status, JSON.stringify(sandbox.body)).toBe(200);
  const live = await at(EDGE);
  expect(live.body?.code ?? live.body?.error?.code).toBe('env.mismatch');
});

test(`${J} #8 triggers a simulated decline and resets the balance: the payment ends declined; reset works until the daily cap, then a typed refusal`, async () => {
  test.setTimeout(180_000);
  const { key, baseUrl } = run.read();
  await page.goto('/developers/sandbox/test-values');
  const decline = tableIn(page, 'Test values')
    .getByRole('row', { name: /Decline/ })
    .getByRole('code')
    .first();
  await expect(decline).toBeVisible(UNBUILT);
  const payment = await fetch(`${baseUrl}/api/pay/v1/payments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': `jd02-${RUN}-8-decline` },
    body: JSON.stringify({ amount: '10', currency: 'USD', card: (await decline.textContent())?.trim() }),
  }).then(json);
  expect(payment.body?.status, JSON.stringify(payment.body)).toBe('declined');

  await openSandbox('development');
  const reset = page.getByRole('button', { name: 'Reset balances' });
  for (let i = 0; i < 50; i += 1) {
    await reset.click();
    const said = page.getByRole('status').or(page.getByRole('alert'));
    await expect(said).toBeVisible();
    if (/daily reset limit/i.test((await said.textContent()) ?? '')) return;
  }
  throw new Error('fifty resets in a day were all accepted: no daily cap');
});
