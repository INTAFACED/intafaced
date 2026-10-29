import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-03 steps #1, #7 and #9, in the running app (docs/roadmap/journeys.json): the key list with a revoked key's
// reason, the permission table and the missing-scope error, and the key detail with its expiry. J-developer-03.pw.mjs
// holds #2 to #6 and #8 in serial mode, so a step here that fails can't skip those; this file has its own TEST account
// with a passkey, on http://localhost:3210 for the passkey's relying party. The steps share one page: the passkey lives
// in that page's virtual authenticator, so a new browser context could not pass the key step-up.
// A step that is written but not built yet fails at its first missing part, quickly (UNBUILT):
// - #7: the Permissions section publishes no permission-to-endpoint table, and a missing-scope refusal carries no docs link.
const J = 'J-developer-03';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  const dev = await signUp(page, 'dkd');
  await verify(page, dev);
  await signIn(page, dev);
  await addPasskey(page);
});

test.afterAll(async () => {
  await page?.context().close();
});

/** Creates a key from the form with the passkey's step-up and returns the secret it shows once. */
async function createKey({ name, preset = 'Read only', expiry, scopes }) {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  if (scopes) {
    await page.getByLabel('Choose', { exact: true }).check();
    for (const scope of scopes) await page.getByRole('checkbox', { name: scope }).check();
  } else await page.getByLabel(preset, { exact: true }).check();
  if (expiry) await page.getByLabel('Expires on').fill(expiry);
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  return key;
}

const rows = () => page.getByTestId('api-keys__table').locator('tbody tr');

test(`${J} #1 opens /uc/safe/api-keys: every column, a revoked key showing its reason, and the key-safety guidance`, async () => {
  // The key-safety guidance shows even before the person has any key.
  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
  await expect(rows()).toHaveCount(0);
  await createKey({ name: 'reader-1' });

  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
  const table = page.getByTestId('api-keys__table');
  for (const column of ['Name', 'Prefix', 'Mode', 'Permissions', 'IP addresses', 'Created', 'Ends', 'Last used', 'State'])
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  const row = rows().filter({ hasText: 'reader-1' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  const sheet = page.getByRole('dialog', { name: 'Revoke this key' });
  await sheet.getByLabel('Reason').fill('TEST: rotated');
  await sheet.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(row).toContainText('Revoked');
  await expect(row).toContainText('TEST: rotated');
});

test(`${J} #7 reads the permission-to-endpoint table, then calls a route without the scope: the typed permission error with a docs link`, async () => {
  await page.goto('/developers/permissions');
  const table = page.getByRole('table', { name: 'Permissions and endpoints' });
  await expect(table).toBeVisible(UNBUILT);
  await expect(table.getByRole('row', { name: /trade:write/ })).toContainText('POST /api/v1/orders');

  // A read-only key placing an order.
  const key = await createKey({ name: 'reader-2' });
  const res = await fetch(`${EDGE}/api/v1/orders`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(JSON.stringify(body)).toMatch(/scope/);
  expect(body?.error?.docs ?? body?.docs).toMatch(/\/developers\/permissions/);
});

test(`${J} #9 sets an expiry and opens the key detail: expiry, idle expiry and IP policy shown; a key can't change its own expiry`, async () => {
  test.setTimeout(120_000);
  const inThirtyDays = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  // The key holds identity:write, so the refusal below is the delegate rule, not a missing scope.
  const key = await createKey({ name: 'expiring-1', expiry: inThirtyDays, scopes: ['identity:read', 'identity:write'] });
  await page.goto('/uc/safe/api-keys');
  await rows().filter({ hasText: 'expiring-1' }).getByRole('link', { name: 'expiring-1' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys\/[0-9a-f-]{36}$/);
  const keyId = new URL(page.url()).pathname.split('/').at(-1);
  const detail = page.getByRole('region', { name: 'Key detail' });
  await expect(detail).toContainText(inThirtyDays);
  await expect(detail).toContainText(/Idle expiry\s*(\d+ days|not set)/);
  await expect(detail).toContainText(/IP policy/);
  // The key itself may not move its own expiry: a valid request for a later end date, sent with the key.
  const res = await fetch(`${EDGE}/api/identity/trpc/developerKeys.setExpiry`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ keyId, expiresAt: new Date(Date.now() + 60 * 864e5).toISOString() }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(403);
  expect(JSON.stringify(body)).toContain('auth.delegate_cannot_grant');
  await page.reload();
  await expect(detail).toContainText(inThirtyDays);
});
