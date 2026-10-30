import path from 'node:path';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-03, in the running app (docs/roadmap/journeys.json): create a live trading key with only the permissions
// it needs. One test per step this build serves, titled "J-developer-03 #<n>". The person is a TEST account on the
// local stack: signed up, verified by the stack's TEST operators, with a passkey (only an account with a verified
// passkey may hold a key) that also gives each create its fresh step-up. Passkeys belong to the relying party
// `localhost`, so the steps share one signed-in page on http://localhost:3210 with Chromium's virtual authenticator.
// The stack's TEST owner value caps live keys at three per account (IDENTITY_API_KEYS_MAX_BY_TIER).
const J = 'J-developer-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const { apiKeyCreateRequestId } = await import(path.join(ROOT, 'packages/contracts/dist/api-keys.js'));

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let who;

async function openForm() {
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await expect(page.getByLabel('Trade', { exact: true })).toBeVisible();
}

/** Fills the form and presses Create key (no step-up), or Create with a passkey (the fresh step-up). */
async function fill({ name, preset = 'Trade', ips = '', passkey = false }) {
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel(preset, { exact: true }).check();
  await page.getByLabel('IP addresses (one per line, optional)').fill(ips);
  await page.getByRole('button', { name: passkey ? 'Create with a passkey' : 'Create key', exact: true }).click();
}

/** Identity restarted with the owner's key cap blank, or back on the stack's TEST cap (as J-identity-08 #5 does). */
function identityKeyCap(on) {
  const before = process.env.LOCAL_STACK_IDENTITY_KEY_CAP;
  if (on) delete process.env.LOCAL_STACK_IDENTITY_KEY_CAP;
  else process.env.LOCAL_STACK_IDENTITY_KEY_CAP = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_IDENTITY_KEY_CAP;
    else process.env.LOCAL_STACK_IDENTITY_KEY_CAP = before;
  }
}

async function keysInList() {
  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keys on this account' })).toBeVisible();
  return page.getByTestId('api-keys__table').locator('tbody tr');
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  who = await signUp(page, 'dk');
  await verify(page, who);
  await signIn(page, who);
  await addPasskey(page);
  run.reset({ who });
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #2 Create with no fresh step-up is refused and makes nothing`, async () => {
  // The room shows its key-safety guidance before there is any key.
  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
  await expect(page.getByText('You have no API keys.')).toBeVisible();
  await expect(page.getByText('0 of 3 keys in use.')).toBeVisible();

  await page.getByRole('link', { name: 'Create a key' }).click();
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await fill({ name: 'bot-1' });
  await expect(page.getByRole('alert')).toHaveText(/^Confirm it is you first.*Nothing was created\.$/);
  await expect(await keysInList()).toHaveCount(0);
});

test(`${J} #3 The read-only preset ticks only read scopes and says what the key cannot do`, async () => {
  await openForm();
  await page.getByLabel('Read only', { exact: true }).check();
  const ticked = await page.locator('input[name=scope]:checked').evaluateAll((boxes) => boxes.map((box) => box.value));
  expect(ticked.length).toBeGreaterThan(0);
  expect(ticked.every((scope) => scope.endsWith(':read'))).toBe(true);
  await expect(page.locator('input[name=scope][value="trade:write"]')).not.toBeChecked();
  await expect(page.getByText('It cannot place or cancel orders or change anything.')).toBeVisible();
  // Withdrawal is never offered, and the room says why.
  await expect(page.locator('input[name=scope][value="trade:withdraw"]')).toHaveCount(0);
  await expect(page.getByTestId('api-keys__blocked')).toContainText(
    'trade:withdraw: Only while you are signed in on a device, never by a key.',
  );
});

test(`${J} #4 Submitting with no scope is a typed refusal and makes no row`, async () => {
  await openForm();
  await page.getByLabel('Key name').fill('bot-1');
  await page.getByLabel('Choose', { exact: true }).check();
  await expect(page.locator('input[name=scope]:checked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose at least one permission. Nothing was created.');
  await expect(await keysInList()).toHaveCount(0);
});

test(`${J} #5 Create bot-1 with an IP list: the secret once, then the record without it`, async () => {
  await openForm();
  await fill({ name: 'bot-1', ips: '203.0.113.7', passkey: true });
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  await expect(page.getByText('Copy this key now. It is shown once and cannot be shown again.')).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  expect(key).toMatch(/^ifc_[A-Za-z0-9_-]{20,}$/);
  const done = page.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await done.click();

  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  const rows = page.getByTestId('api-keys__table').locator('tbody tr');
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row.getByRole('rowheader')).toHaveText('bot-1');
  const prefix = (await row.locator('code').textContent())?.trim();
  expect(key.startsWith(prefix)).toBe(true);
  await expect(row).toContainText('Live');
  await expect(row).toContainText('trade:read, trade:write');
  await expect(row).toContainText('203.0.113.7');
  await expect(row).toContainText('Active');
  await expect(page.getByText('1 of 3 keys in use.')).toBeVisible();
  expect(await page.content()).not.toContain(key);

  // The same request again, as a retry after a lost reply would send it: the record, and no secret. Sent from a
  // second sign-in of the same person, straight to Edge.
  const second = await api(who);
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((res) => res.json());
  const userId = login.result.data.userId;
  const asked = { name: 'bot-1', scopes: ['trade:read', 'trade:write'], ips: ['203.0.113.7'] };
  const again = await second.post('/api/identity/trpc/developerKeys.create', {
    ...asked,
    requestId: apiKeyCreateRequestId(userId, [], asked),
  });
  expect(again.status).toBe(200);
  expect(again.body.result.data).toMatchObject({ key: null, replayed: true, record: { name: 'bot-1', prefix } });
  await expect(await keysInList()).toHaveCount(1);
});

test(`${J} #6 A second key named BOT-1 is refused: the name is taken`, async () => {
  await openForm();
  await fill({ name: 'BOT-1', passkey: true });
  await expect(page.getByRole('alert')).toHaveText('You already have a key with this name. Choose another name. Nothing was created.');
  await expect(await keysInList()).toHaveCount(1);
});

test(`${J} #8 The fourth key is refused at the cap of three, and every key while the cap is blank`, async () => {
  test.setTimeout(300_000);
  for (const name of ['bot-2', 'bot-3']) {
    await openForm();
    await fill({ name, preset: 'Read only', passkey: true });
    await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  }
  await expect(await keysInList()).toHaveCount(3);
  await expect(
    page.getByText(
      '3 of 3 keys in use. Revoked and ended keys do not count. This account holds as many keys as it may. Revoke one to make another.',
    ),
  ).toBeVisible();
  await openForm();
  await fill({ name: 'bot-4', preset: 'Read only', passkey: true });
  await expect(page.getByRole('alert')).toHaveText(
    'This account holds as many keys as it may. Revoke one to make another. Nothing was created.',
  );
  await expect(await keysInList()).toHaveCount(3);

  // With the owner's cap blank, no key is made: the room says the cap is not set, and a create is refused with that
  // cap's own sentence, never the cap-reached one, and nothing is written.
  identityKeyCap(false);
  try {
    await expect(await keysInList()).toHaveCount(3);
    await expect(page.getByText('The number of keys an account may hold is not set, so new keys are refused.')).toBeVisible();
    await openForm();
    const answered = page.waitForResponse((res) => res.url().includes('developerKeys.create'));
    await fill({ name: 'bot-5', preset: 'Read only', passkey: true });
    // Identity's own answer to the browser's create: the blank cap's code, not the cap-reached one.
    const reply = await answered;
    const text = await reply.text();
    expect(reply.status(), text).toBe(412);
    expect(text).toContain('identity.key_cap_unset');
    expect(text).not.toContain('identity.key_cap_reached');
    await expect(page.getByRole('alert')).toHaveText(
      'The number of keys an account may hold is not set, so keys are refused. Nothing was created.',
    );
    await expect(await keysInList()).toHaveCount(3);
  } finally {
    identityKeyCap(true);
  }
});
