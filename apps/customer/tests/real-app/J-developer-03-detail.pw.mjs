import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-03 steps #1, #7 and #9, in the running app (docs/roadmap/journeys.json): the key list with a revoked key's
// reason, the permission table and the missing-scope error, and the key detail with its expiry. J-developer-03.pw.mjs
// holds #2 to #6 and #8 in serial mode, so a step here that fails can't skip those; this file has its own TEST account
// with a passkey, on http://localhost:3210 for the passkey's relying party.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the key list has no Revoke with a reason, so no revoked row can show one.
// - #7: the Permissions section publishes no permission-to-endpoint table, and a missing-scope refusal carries no docs link.
// - #9: the create form has no expiry and there is no key detail page.
const J = 'J-developer-03';
const run = journeyState(`${J}-detail-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function developerPage(browser) {
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  return page;
}

/** Creates a key from the form with the passkey's step-up and returns the secret it shows once. */
async function createKey(page, { name, preset = 'Read only', expiry }) {
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel(preset, { exact: true }).check();
  if (expiry) await page.getByLabel('Expires on').fill(expiry, UNBUILT);
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  return key;
}

const rows = (page) => page.getByTestId('api-keys__table').locator('tbody tr');

test(`${J} #1 opens /uc/safe/api-keys: every column, a revoked key showing its reason, and the key-safety guidance`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await developerPage(browser);
  try {
    const dev = await signUp(page, 'dkd');
    await verify(page, dev);
    await signIn(page, dev);
    await addPasskey(page);
    run.reset({ dev });
    const key = await createKey(page, { name: 'reader-1' });
    run.write({ key });

    await page.goto('/uc/safe/api-keys');
    await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
    const table = page.getByTestId('api-keys__table');
    for (const column of ['Name', 'Prefix', 'Mode', 'Permissions', 'IP addresses', 'State'])
      await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
    await rows(page).first().getByRole('button', { name: 'Revoke' }).click(UNBUILT);
    const sheet = page.getByRole('dialog', { name: 'Revoke this key' });
    await sheet.getByLabel('Reason').fill('TEST: rotated');
    await sheet.getByRole('button', { name: 'Revoke with a passkey' }).click();
    await expect(rows(page).first()).toContainText('Revoked');
    await expect(rows(page).first()).toContainText('TEST: rotated');
  } finally {
    await page.context().close();
  }
});

test(`${J} #7 reads the permission-to-endpoint table, then calls a route without the scope: the typed permission error with a docs link`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    await page.goto('/developers/permissions');
    const table = page.getByRole('table', { name: 'Permissions and endpoints' });
    await expect(table).toBeVisible(UNBUILT);
    await expect(table.getByRole('row', { name: /trade:write/ })).toContainText('POST /api/v1/orders');

    // A read-only key placing an order.
    await signIn(page, state('dev'));
    const key = await createKey(page, { name: 'reader-2' });
    const res = await fetch(`${EDGE}/api/v1/orders`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/scope/);
    expect(body?.error?.docs ?? body?.docs).toMatch(/\/developers\/permissions/);
  } finally {
    await page.context().close();
  }
});

test(`${J} #9 sets an expiry and opens the key detail: expiry, idle expiry and IP policy shown; a key can't change its own expiry`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    await signIn(page, state('dev'));
    const inThirtyDays = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const key = await createKey(page, { name: 'expiring-1', expiry: inThirtyDays });
    await page.goto('/uc/safe/api-keys');
    await rows(page).filter({ hasText: 'expiring-1' }).getByRole('link', { name: 'expiring-1' }).click();
    const detail = page.getByRole('region', { name: 'Key detail' });
    await expect(detail).toContainText(inThirtyDays);
    await expect(detail).toContainText(/Idle expiry\s*(\d+ days|not set)/);
    await expect(detail).toContainText(/IP policy/);
    // The key itself may not move its own expiry.
    const res = await fetch(`${EDGE}/api/identity/trpc/developerKeys.setExpiry`, {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'expiring-1', expiresAt: null }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  } finally {
    await page.context().close();
  }
});
