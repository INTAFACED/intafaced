import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-03 steps #1, #7 and #9, in the running app (docs/roadmap/journeys.json): the key list with a revoked key's
// reason, the permission table and the missing-scope error, and the key detail with its expiry. J-developer-03.pw.mjs
// holds #2 to #6 and #8 in serial mode, so a step here that fails can't skip those; this file has its own TEST account
// with a passkey, on http://localhost:3210 for the passkey's relying party. The steps share one page: the passkey lives
// in that page's virtual authenticator, so a new browser context could not pass the key step-up.
const J = 'J-developer-03';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

/** @type {import('@playwright/test').Page} */
let page;
/** The TEST developer, for a second sign-in that reads the records back. */
let dev;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  dev = await signUp(page, 'dkd');
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

/** The typed code identity puts at the end of a refusal's message (`... [auth.delegate_cannot_grant]`). */
const codeOf = (body) => /\[([a-z_]+\.[a-z_.]+)\]$/.exec(body?.error?.message ?? '')?.[1];

/** The account's BTC/USDT orders, open and closed, as the exchange holds them, read back through a second sign-in. */
async function storedOrders() {
  const mine = await api(dev);
  const open = await mine.get('/api/v1/orders/open?symbol=BTC%2FUSDT&limit=100');
  const closed = await mine.get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=100');
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return { open: open.body, closed: closed.body };
}

/** The account's own keys as identity holds them, read back through a second sign-in. */
async function storedKeys() {
  const res = await (
    await api(dev)
  ).get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.result.data.keys;
}

test(`${J} #1 opens /uc/safe/api-keys: every column, a revoked key showing its reason, and the key-safety guidance`, async () => {
  // The key-safety guidance shows even before the person has any key: a new account holds none.
  expect(await storedKeys()).toEqual([]);
  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
  await expect(rows()).toHaveCount(0);
  const secret = await createKey({ name: 'reader-1' });

  await page.goto('/uc/safe/api-keys');
  await expect(page.getByRole('heading', { name: 'Keeping a key safe' })).toBeVisible();
  const table = page.getByTestId('api-keys__table');
  const columns = ['Name', 'Prefix', 'Mode', 'Permissions', 'IP addresses', 'Created', 'Ends', 'Last used', 'State', 'Actions'];
  await expect(table.getByRole('columnheader')).toHaveText(columns);
  const [stored] = await storedKeys();
  expect(secret?.startsWith(stored.prefix)).toBe(true);
  const row = rows().filter({ hasText: 'reader-1' });
  await expect(row).toHaveCount(1);
  // Each column shows the stored value: name, prefix, live mode, the read-only permissions, any address, no end date,
  // not used yet, live state.
  expect(stored).toMatchObject({ name: 'reader-1', mode: 'live', ipAllowlist: [], expiresAt: null, lastUsedAt: null, revoked: false });
  expect(stored.scopes.length).toBeGreaterThan(0);
  await expect(row.getByRole('rowheader')).toContainText('reader-1');
  const cells = row.getByRole('cell');
  await expect(cells.nth(0)).toContainText(stored.prefix);
  await expect(cells.nth(1)).toHaveText('Live');
  await expect(cells.nth(2)).toHaveText(stored.scopes.join(', '));
  await expect(cells.nth(3)).toHaveText('Any address');
  await expect(cells.nth(5)).toHaveText('No end date');
  await expect(cells.nth(6)).toHaveText('Not used');

  await row.getByRole('button', { name: 'Revoke' }).click();
  const sheet = page.getByRole('dialog', { name: 'Revoke this key' });
  await sheet.getByLabel('Reason').fill('TEST: rotated');
  await sheet.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(row).toContainText('Revoked by you: TEST: rotated');
  // The reason the row shows is the one identity stored, with the person as the cause.
  const [revoked] = await storedKeys();
  expect(revoked).toMatchObject({ id: stored.id, revoked: true, revokedBy: 'owner', revokeReason: 'TEST: rotated' });
  expect(revoked.revokedAt).not.toBeNull();
});

test(`${J} #7 reads the permission-to-endpoint table, then calls a route without the scope: the typed permission error with a docs link`, async () => {
  // A read-only key placing an order: refused by its scope, with the code and the link to the table.
  const key = await createKey({ name: 'reader-2' });
  const stored = (await storedKeys()).find((k) => k.name === 'reader-2');
  expect(stored.scopes).not.toContain('trade:write');
  const ordersBefore = await storedOrders();
  expect(ordersBefore).toEqual({ open: [], closed: [] });
  const res = await fetch(`${EDGE}/api/v1/orders`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1' }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(403);
  expect(body).toEqual({
    code: 'PermissionDenied',
    message: 'Scope "trade:write" is required',
    intafacedCode: 'scope.denied',
    docs: '/developers/permissions',
    // Each refusal carries its own request id for support; the code is exact.
    requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  });
  // The refusal placed nothing: the account's orders read back unchanged.
  expect(await storedOrders()).toEqual(ordersBefore);

  // The docs link opens the published table, which names trade:write against the order route.
  await page.goto(body.docs);
  const table = page.getByRole('table', { name: 'Permissions and endpoints' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row', { name: /trade:write/ })).toContainText('POST /api/v1/orders');
});

test(`${J} #9 sets an expiry and opens the key detail: expiry, idle expiry and IP policy shown; a key can't change its own expiry`, async () => {
  test.setTimeout(120_000);
  const day = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  // The key holds identity:write, so the refusal below is the delegate rule, not a missing scope.
  const key = await createKey({ name: 'expiring-1', expiry: day(30), scopes: ['identity:read', 'identity:write'] });
  await page.goto('/uc/safe/api-keys');
  await rows().filter({ hasText: 'expiring-1' }).getByRole('link', { name: 'expiring-1' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys\/[0-9a-f-]{36}$/);
  const keyId = new URL(page.url()).pathname.split('/').at(-1);
  const detail = page.getByRole('region', { name: 'Key detail' });

  // Sets an expiry on the detail: an earlier end date, which needs no second factor.
  await page.getByLabel('New end date').fill(day(20));
  await page.getByRole('button', { name: 'Save end date' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The end date is saved.' })).toBeVisible();
  const stored = () => storedKeys().then((keys) => keys.find((k) => k.id === keyId));
  const lastDay = (iso) => new Date(Date.parse(iso) - 1).toISOString().slice(0, 10);
  const saved = (await stored()).expiresAt;
  // Stored as the end of the chosen day (UTC): its last working day is the day the person picked.
  expect(lastDay(saved)).toBe(day(20));

  // The detail shows the stored end date, the idle expiry (a LOCAL TEST 90 days on this stack) and the IP policy.
  await page.reload();
  await expect(page.getByTestId('api-keys__expiry')).toContainText(`Works through ${day(20)} (UTC)`);
  await expect(page.getByTestId('api-keys__idle')).toContainText('90 days');
  await expect(page.getByTestId('api-keys__idle')).toContainText('No job ends idle keys today');
  await expect(detail.getByText('IP policy')).toBeVisible();
  await expect(page.getByTestId('api-keys__ip-policy')).toContainText('Any address.');

  // The key itself may not move its own expiry: a valid request for a later end date, sent with the key.
  const res = await fetch(`${EDGE}/api/identity/trpc/developerKeys.setExpiry`, {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ keyId, expiresAt: new Date(Date.now() + 60 * 864e5).toISOString() }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(403);
  expect(codeOf(body), JSON.stringify(body)).toBe('auth.delegate_cannot_grant');
  // Nothing changed: the stored end date is the one the person saved.
  expect((await stored()).expiresAt).toBe(saved);
});
