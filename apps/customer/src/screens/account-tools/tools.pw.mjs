import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_SECRET, failure, fees, keys, markets, perks, rank, refused, subAccounts, trpc } from './tools.fixtures.mjs';

const shots = process.env.TOOLS_SHOTS ?? join(tmpdir(), 'intafaced-tools-shots');
mkdirSync(shots, { recursive: true });

const forbidden =
  /unavailable|not connected|restricted|fixture|lifecycle|\bspaces?\b|\broom\b|\bledger\b|\btier\b|partition|identity service|undefined|\[object/i;
const rawScope = /trade:(read|write|withdraw)|identity:|pay:|admin:/;
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Answer the identity calls (/api/identity/trpc/<procedure>), the fee list and the market list. State lives in the test,
 * so a create or a revoke changes what the next read returns. `hold` keeps named reads open until `release()`;
 * `fail` makes them answer 503. No service is contacted, and every secret in here is the fake one.
 */
async function mock(page, options = {}) {
  const state = {
    keys: options.keys ?? keys(),
    subs: options.subs ?? subAccounts(),
    // 'ok' | 'unconfirmed' (needs the passkey check first) | 'missing' (no passkey at all)
    passkey: options.passkey ?? 'ok',
    createError: options.createError ?? null,
    discount: options.discount ?? 50,
    fail: new Set(options.fail ?? []),
    hold: new Set(options.hold ?? []),
    held: [],
    calls: [],
    logs: [],
  };
  page.on('console', (message) => state.logs.push(message.text()));
  const respond = (route, procedure, input) => {
    switch (procedure) {
      case 'apiKeys.list':
        return route.fulfill({ status: 200, json: trpc(state.keys) });
      case 'apiKeys.create':
      case 'mintApiKeyWithIpAllowlist': {
        if (state.createError) return route.fulfill(state.createError);
        if (state.passkey === 'missing') return route.fulfill(refused('No enrolled passkey', 'auth.passkey_missing'));
        if (state.passkey === 'unconfirmed')
          return route.fulfill(refused('passkey verify is unavailable', 'auth.passkey_verify_unavailable'));
        const row = {
          id: `55555555-5555-4555-8555-${String(state.keys.length + 1).padStart(12, '0')}`,
          name: input.name,
          prefix: 'fake_new1',
          scopes: input.scopes,
          lastUsedAt: null,
          revoked: false,
          mode: 'live',
        };
        state.keys = [row, ...state.keys];
        return route.fulfill({
          status: 200,
          json: trpc({ id: row.id, key: FAKE_SECRET, prefix: row.prefix, mode: 'live', ...(input.ips ? { ipAllowlist: input.ips } : {}) }),
        });
      }
      case 'beginVerifyPasskey':
        return route.fulfill({
          status: 200,
          json: trpc({
            challenge: 'dGVzdC1jaGFsbGVuZ2U',
            rpId: '127.0.0.1',
            allowCredentials: [{ id: 'dGVzdC1rZXk', type: 'public-key' }],
            userVerification: 'required',
          }),
        });
      case 'verifyPasskey':
        state.passkey = 'ok';
        return route.fulfill({ status: 200, json: trpc({ credentialId: 'dGVzdC1rZXk', verified: true }) });
      case 'apiKeys.revoke': {
        const row = state.keys.find((item) => item.id === input.keyId);
        const was = row ? !row.revoked : false;
        if (row) row.revoked = true;
        return route.fulfill({ status: 200, json: trpc({ revoked: was }) });
      }
      case 'subAccounts.list':
        return route.fulfill({ status: 200, json: trpc(state.subs) });
      case 'subAccounts.create': {
        if (state.createError) return route.fulfill(state.createError);
        const row = {
          id: `dddddddd-dddd-4ddd-8ddd-${String(state.subs.length + 1).padStart(12, '0')}`,
          label: input.label,
          purpose: input.purpose ?? null,
          revoked: false,
          createdAt: '2026-10-14T02:00:00.000Z',
        };
        state.subs = [row, ...state.subs];
        return route.fulfill({ status: 200, json: trpc({ id: row.id }) });
      }
      case 'subAccounts.revoke': {
        const row = state.subs.find((item) => item.id === input.subAccountId);
        const was = row ? !row.revoked : false;
        if (row) row.revoked = true;
        return route.fulfill({ status: 200, json: trpc({ revoked: was }) });
      }
      case 'rank.get':
        return route.fulfill({ status: 200, json: trpc(rank()) });
      case 'rank.perks':
        return route.fulfill({ status: 200, json: trpc(perks(state.discount)) });
      default:
        return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    }
  };
  await page.route('**/api/identity/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1]);
    const post = route.request().method() === 'POST';
    const input = post
      ? route.request().postDataJSON()
      : url.searchParams.get('input')
        ? JSON.parse(url.searchParams.get('input'))
        : undefined;
    state.calls.push({ procedure, input, method: route.request().method() });
    if (state.fail.has(procedure)) return route.fulfill({ status: failure.status, json: failure.json });
    if (state.hold.has(procedure)) return void state.held.push({ route, procedure, input });
    return respond(route, procedure, input);
  });
  await page.route('**/api/v1/markets**', (route) => route.fulfill({ status: 200, json: options.noMarkets ? [] : markets }));
  await page.route('**/api/v1/account/fees**', (route) =>
    state.fail.has('fees') ? route.fulfill({ status: failure.status, json: failure.json }) : route.fulfill({ status: 200, json: fees() }),
  );
  return {
    state,
    calls: (procedure) => state.calls.filter((call) => call.procedure === procedure),
    release: async () => {
      for (const { route, procedure, input } of state.held.splice(0)) await respond(route, procedure, input);
    },
  };
}

const open = async (page, path) => {
  await page.goto(path);
  await page.locator('.acct').waitFor();
};
const snap = async (page, name) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, `${name}-1440x900.png`), fullPage: true });
};
const watch = (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const bodyText = (page) => page.locator('.acct').innerText();

/** A fake passkey assertion, so the check can run without a real authenticator. */
const fakePasskey = (page) =>
  page.addInitScript(() => {
    const bytes = (n) => new Uint8Array([n, n + 1, n + 2]).buffer;
    const credential = Object.create(PublicKeyCredential.prototype, {
      id: { value: 'dGVzdC1rZXk' },
      rawId: { value: bytes(1) },
      response: {
        value: { clientDataJSON: bytes(4), authenticatorData: bytes(7), signature: bytes(10), userHandle: null },
      },
      getClientExtensionResults: { value: () => ({}) },
    });
    navigator.credentials.get = async () => credential;
    window.__passkeyAsked = 0;
    const get = navigator.credentials.get;
    navigator.credentials.get = async (...args) => {
      window.__passkeyAsked += 1;
      return get(...args);
    };
  });

// ── API keys ────────────────────────────────────────────────────────────────

test('api keys: Account sub-nav, a table with name, key start, access, last used and status, and the withdraw note', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/uc/api');
  const links = page.locator('.acct-nav a');
  expect(await links.allTextContents()).toEqual(['Account', 'Security', 'Verification', 'API keys', 'Sub-accounts', 'Fees', 'Display']);
  await expect(page.locator('.acct-nav a[aria-current="page"]')).toHaveText('API keys');
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
  await expect(page.getByText('Keys can never withdraw')).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Key', 'Access', 'Last used', 'Status', 'Action']);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Price alerts bot');
  await expect(rows.nth(0)).toContainText('fake_a1b2…');
  await expect(rows.nth(0).locator('.tools-chip')).toHaveText(['Read']);
  await expect(rows.nth(0)).toContainText('13 Oct, 08:30');
  await expect(rows.nth(0)).toContainText('Active');
  await expect(rows.nth(1).locator('.tools-chip')).toHaveText(['Read', 'Trade']);
  await expect(rows.nth(1)).toContainText('Never');
  await expect(rows.nth(2)).toContainText('Revoked');
  await expect(rows.nth(2).getByRole('button')).toHaveCount(0);
  await expect(rows.nth(3)).toContainText('Sandbox');
  const text = await bodyText(page);
  expect(text).not.toMatch(forbidden);
  expect(text).not.toMatch(rawScope);
  expect(text).not.toMatch(uuidText);
  expect(await noOverflow(page)).toBe(true);
  await snap(page, 'api-keys-loaded');
  expect(errors).toEqual([]);
});

test('api keys: loading, empty, error and refused states', async ({ page }) => {
  const errors = watch(page);
  const held = await mock(page, { hold: ['apiKeys.list'] });
  await open(page, '/uc/api');
  await expect(page.locator('[data-slot="state-block"][data-kind="loading"]')).toBeVisible();
  await snap(page, 'api-keys-loading');
  held.state.hold.clear();
  await held.release();
  await expect(page.getByRole('table')).toBeVisible();

  await page.unrouteAll();
  await mock(page, { keys: [] });
  await open(page, '/uc/api');
  await expect(page.getByText('No API keys yet')).toBeVisible();
  await expect(page.locator('[data-kind="empty"]').getByRole('button', { name: 'Create API key' })).toBeVisible();
  await snap(page, 'api-keys-empty');

  await page.unrouteAll();
  const bad = await mock(page, { fail: ['apiKeys.list'] });
  await open(page, '/uc/api');
  await expect(page.getByText('Couldn’t load your API keys')).toBeVisible();
  expect(await bodyText(page)).not.toMatch(/SERVICE_UNAVAILABLE|-32603|503/);
  await snap(page, 'api-keys-error');
  bad.state.fail.clear();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  await page.unrouteAll();
  await page.route('**/api/identity/trpc/apiKeys.list**', (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: { message: 'Missing scope', code: -32003, data: { code: 'FORBIDDEN', intafacedCode: 'scope.denied', httpStatus: 403 } },
      },
    }),
  );
  await open(page, '/uc/api');
  await expect(page.getByText("You can't do this here")).toBeVisible();
  expect(await bodyText(page)).not.toMatch(/scope\.denied/);
  await snap(page, 'api-keys-refused');
  expect(errors).toEqual([]);
});

test('api keys: create with Trade and an IP list, then the key is shown once and nowhere else', async ({ page, context }) => {
  const errors = watch(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = await mock(page);
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  // Withdraw is a locked row, never a choice; Read is on by default.
  await expect(dialog.getByText('Never available on an API key.')).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('checkbox', { name: /^Read/ })).toBeChecked();
  await snap(page, 'api-keys-create-form');

  // Needs a name.
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByText('Give the key a name.')).toBeVisible();
  expect(api.calls('apiKeys.create')).toHaveLength(0);

  await dialog.getByLabel('Name', { exact: true }).fill('Market maker');
  // Trade includes Read, so Read cannot be turned off under it.
  await dialog.getByRole('checkbox', { name: /^Trade/ }).click();
  await expect(dialog.getByRole('checkbox', { name: /^Read/ })).toBeDisabled();
  await expect(dialog.getByText(/Anyone who gets this key can use it from anywhere/)).toBeVisible();

  // A range is not accepted.
  await dialog.getByLabel('Allowed IP addresses (optional)').fill('203.0.113.7\n203.0.113.0/24');
  await expect(dialog.getByText('These are not single IP addresses: 203.0.113.0/24')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create key' }).click();
  expect(api.calls('mintApiKeyWithIpAllowlist')).toHaveLength(0);
  await dialog.getByLabel('Allowed IP addresses (optional)').fill('203.0.113.7, 2001:db8::1');
  await expect(dialog.getByText(/Anyone who gets this key/)).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByRole('heading', { name: 'Copy your key now' })).toBeVisible();
  expect(api.calls('mintApiKeyWithIpAllowlist')).toHaveLength(1);
  const sent = api.calls('mintApiKeyWithIpAllowlist')[0];
  expect(sent.method).toBe('POST');
  expect(sent.input).toEqual({ name: 'Market maker', scopes: ['trade:read', 'trade:write'], ips: ['203.0.113.7', '2001:db8::1'] });
  expect(JSON.stringify(sent.input)).not.toMatch(/withdraw/);

  // The warning, the key and the copy button.
  await expect(dialog.getByText('This is the only time you will see it')).toBeVisible();
  await expect(dialog.getByTestId('api-key-secret')).toHaveText(FAKE_SECRET);
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FAKE_SECRET);
  await snap(page, 'api-keys-secret');

  // It cannot be dismissed by accident: no close icon, Escape and a click outside do nothing, Done waits for the tick.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog.getByTestId('api-key-secret')).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog.getByTestId('api-key-secret')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I have saved this key/ }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Gone from the page, from storage and from the console; the list shows only the start of it.
  expect(await page.locator('body').innerText()).not.toContain(FAKE_SECRET);
  expect(await page.content()).not.toContain(FAKE_SECRET);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  expect(stored).not.toContain(FAKE_SECRET);
  expect(api.state.logs.join('\n')).not.toContain(FAKE_SECRET);
  // Reopening starts from an empty form: the earlier key, name and addresses are not kept in the component.
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const again = page.getByRole('dialog');
  await expect(again.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await expect(again.getByTestId('api-key-secret')).toHaveCount(0);
  await expect(again.getByLabel('Name', { exact: true })).toHaveValue('');
  await expect(again.getByLabel('Allowed IP addresses (optional)')).toHaveValue('');
  await expect(again.getByRole('checkbox', { name: /^Trade/ })).not.toBeChecked();
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await again.getByRole('button', { name: 'Cancel' }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const first = page.getByRole('table').locator('tbody tr').first();
  await expect(first).toContainText('Market maker');
  await expect(first).toContainText('fake_new1…');
  await expect(first.locator('.tools-chip')).toHaveText(['Read', 'Trade']);
  expect(errors).toEqual([]);
});

test('api keys: nothing can be cancelled while a key is being made, and a key made after leaving is revoked', async ({ page }) => {
  const api = await mock(page, { hold: ['apiKeys.create'] });
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Slow bot');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect.poll(() => api.state.held.length).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  // The close icon is gone too: only the (disabled) footer Cancel is left.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  // The key arrives while the person is still here: it is shown, not dropped.
  api.state.hold.clear();
  await api.release();
  await expect(dialog.getByTestId('api-key-secret')).toHaveText(FAKE_SECRET);
  await dialog.getByRole('checkbox', { name: /I have saved this key/ }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();

  // Leaving the page mid-request: the key that gets made is revoked straight away, never left active and unseen.
  api.state.hold.add('apiKeys.create');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const next = page.getByRole('dialog');
  await next.getByLabel('Name', { exact: true }).fill('Abandoned');
  await next.getByRole('button', { name: 'Create key' }).click();
  await expect.poll(() => api.state.held.length).toBe(1);
  await page.evaluate(() => {
    history.pushState(null, '', '/uc/fees');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Fees' })).toBeVisible();
  api.state.hold.clear();
  await api.release();
  await expect.poll(() => api.calls('apiKeys.revoke').length).toBe(1);
  expect(api.calls('apiKeys.revoke')[0].input.keyId).toBe(api.state.keys.find((key) => key.name === 'Abandoned').id);
  expect(await page.content()).not.toContain(FAKE_SECRET);
});

test('api keys: the passkey step cannot be cancelled mid-check, and addresses are sent in canonical form', async ({ page }) => {
  await fakePasskey(page);
  const api = await mock(page, { passkey: 'unconfirmed', hold: ['verifyPasskey'] });
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Bot');
  await dialog.getByLabel('Allowed IP addresses (optional)').fill('2001:DB8::1');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await dialog.getByRole('button', { name: 'Confirm passkey' }).click();
  await expect.poll(() => api.state.held.length).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
  api.state.hold.clear();
  await api.release();
  await expect(dialog.getByTestId('api-key-secret')).toHaveText(FAKE_SECRET);
  expect(api.calls('mintApiKeyWithIpAllowlist').at(-1).input.ips).toEqual(['2001:db8::1']);
});

test('api keys: no IP list uses the plain create, and Read-only asks for read only', async ({ page }) => {
  const api = await mock(page);
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Dashboard');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByTestId('api-key-secret')).toBeVisible();
  expect(api.calls('mintApiKeyWithIpAllowlist')).toHaveLength(0);
  expect(api.calls('apiKeys.create')[0].input).toEqual({ name: 'Dashboard', scopes: ['trade:read'] });
});

test('api keys: a passkey that was never confirmed is confirmed first, then the key is made', async ({ page }) => {
  const errors = watch(page);
  await fakePasskey(page);
  const api = await mock(page, { passkey: 'unconfirmed' });
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Bot');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByText('Confirm your passkey', { exact: true })).toBeVisible();
  expect(await dialog.innerText()).not.toMatch(forbidden);
  await snap(page, 'api-keys-passkey-step');
  expect(await dialog.getByTestId('api-key-secret').count()).toBe(0);
  await dialog.getByRole('button', { name: 'Confirm passkey' }).click();
  await expect(dialog.getByTestId('api-key-secret')).toHaveText(FAKE_SECRET);
  expect(await page.evaluate(() => window.__passkeyAsked)).toBe(1);
  expect(api.calls('beginVerifyPasskey')).toHaveLength(1);
  const verify = api.calls('verifyPasskey')[0].input;
  expect(verify).toMatchObject({ id: 'dGVzdC1rZXk', type: 'public-key' });
  expect(Object.keys(verify.response).sort()).toEqual(['authenticatorData', 'clientDataJSON', 'signature']);
  // Created exactly once, after the check.
  expect(api.calls('apiKeys.create')).toHaveLength(2);
  expect(api.state.keys.filter((key) => key.name === 'Bot')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('api keys: no passkey at all points to Security and creates nothing', async ({ page }) => {
  const api = await mock(page, { passkey: 'missing' });
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Bot');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByText('Add a passkey first')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open Security' })).toHaveAttribute('href', '/uc/safe');
  await snap(page, 'api-keys-passkey-missing');
  expect(api.state.keys).toHaveLength(4);
});

test('api keys: a lost answer says so instead of claiming success or failure', async ({ page }) => {
  await mock(page);
  await page.unroute('**/api/identity/trpc/**');
  await page.route('**/api/identity/trpc/**', (route) => {
    const procedure = decodeURIComponent(new URL(route.request().url()).pathname.split('/trpc/')[1]);
    if (procedure === 'apiKeys.list') return route.fulfill({ status: 200, json: trpc(keys()) });
    return route.fulfill({ status: 502, body: 'bad gateway' });
  });
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Bot');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  await expect(dialog.getByText('We couldn’t confirm the key was created')).toBeVisible();
  await snap(page, 'api-keys-uncertain');
});

test('api keys: revoke asks first, names the key, and marks it revoked', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page);
  await open(page, '/uc/api');
  await page.getByRole('button', { name: 'Revoke Grid trader' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('Revoke this key?')).toBeVisible();
  await expect(dialog.getByText('“Grid trader” stops working straight away')).toBeVisible();
  await snap(page, 'api-keys-revoke-confirm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(api.calls('apiKeys.revoke')).toHaveLength(0);
  await page.getByRole('button', { name: 'Revoke Grid trader' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(api.calls('apiKeys.revoke')[0].input).toEqual({ keyId: '22222222-2222-4222-8222-222222222222' });
  const row = page.getByRole('table').locator('tbody tr').nth(1);
  await expect(row).toContainText('Revoked');
  await expect(row.getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ── Sub-accounts ────────────────────────────────────────────────────────────

test('sub-accounts: a table, closed ones marked, a Preview for moving money with no amounts', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/uc/sub-accounts');
  await expect(page.locator('.acct-nav a[aria-current="page"]')).toHaveText('Sub-accounts');
  await expect(page.getByRole('heading', { level: 1, name: 'Sub-accounts' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Purpose', 'Created', 'Status', 'Action']);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Weekend bot');
  await expect(rows.nth(0)).toContainText('10 Oct, 09:41');
  await expect(rows.nth(0)).toContainText('Active');
  await expect(rows.nth(1)).toContainText('—');
  await expect(rows.nth(2)).toContainText('Closed');
  await expect(rows.nth(2).getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Names can’t be changed yet.')).toBeVisible();
  const preview = page.locator('[data-preview="move-money"]');
  await expect(preview.getByText('Preview', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Review move' })).toBeDisabled();
  // No amount or fee is ever invented in the Preview.
  expect(await preview.innerText()).not.toMatch(/\d/);
  const text = await bodyText(page);
  expect(text).not.toMatch(forbidden);
  expect(text).not.toMatch(uuidText);
  expect(await noOverflow(page)).toBe(true);
  await snap(page, 'sub-accounts-loaded');
  expect(errors).toEqual([]);
});

test('sub-accounts: loading, empty and error states', async ({ page }) => {
  const held = await mock(page, { hold: ['subAccounts.list'] });
  await open(page, '/uc/sub-accounts');
  await expect(page.locator('[data-slot="state-block"][data-kind="loading"]')).toBeVisible();
  await snap(page, 'sub-accounts-loading');
  held.state.hold.clear();
  await held.release();
  await expect(page.getByRole('table')).toBeVisible();

  await page.unrouteAll();
  await mock(page, { subs: [] });
  await open(page, '/uc/sub-accounts');
  await expect(page.getByText('No sub-accounts yet')).toBeVisible();
  await snap(page, 'sub-accounts-empty');

  await page.unrouteAll();
  await mock(page, { fail: ['subAccounts.list'] });
  await open(page, '/uc/sub-accounts');
  await expect(page.getByText('Couldn’t load your sub-accounts')).toBeVisible();
  await snap(page, 'sub-accounts-error');
});

test('sub-accounts: create, refused until the owner opens them, and close', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page, {
    createError: refused('IDENTITY_MAX_SUB_ACCOUNTS is unset — owner must publish a live-partition cap', 'auth.sub_account_cap_unset'),
  });
  await open(page, '/uc/sub-accounts');
  await page.getByRole('button', { name: 'Create sub-account' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create sub-account' }).click();
  await expect(dialog.getByText('Give the sub-account a name.')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Fund');
  await dialog.getByRole('button', { name: 'Create sub-account' }).click();
  await expect(dialog.getByText('Sub-accounts aren’t switched on for accounts yet. Nothing was created.')).toBeVisible();
  expect(await dialog.innerText()).not.toMatch(/IDENTITY_MAX|cap|owner must/);
  await snap(page, 'sub-accounts-refused');

  api.state.createError = null;
  await dialog.getByLabel('Purpose (optional)').fill('Savings');
  await dialog.getByRole('button', { name: 'Create sub-account' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.calls('subAccounts.create').at(-1).input).toEqual({ label: 'Fund', purpose: 'Savings' });
  await expect(page.getByRole('table').locator('tbody tr').first()).toContainText('Fund');

  await page.getByRole('button', { name: 'Close Weekend bot' }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert.getByText(/Any money and open orders in it stay there, and can’t be moved out yet\./)).toBeVisible();
  await alert.getByRole('button', { name: 'Close sub-account' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(api.calls('subAccounts.revoke')[0].input).toEqual({ subAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await expect(page.getByRole('table').locator('tbody tr').nth(1)).toContainText('Closed');
  expect(errors).toEqual([]);
});

// ── Fees ────────────────────────────────────────────────────────────────────

test('fees: your rank discount, dashes for levels and volume the back end has not set, rates by market', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page, '/uc/fees');
  await expect(page.locator('.acct-nav a[aria-current="page"]')).toHaveText('Fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Fees' })).toBeVisible();
  const stats = page.locator('.tools-stat');
  await expect(stats).toHaveCount(3);
  await expect(stats.nth(0)).toContainText('Your fee level');
  await expect(stats.nth(0).locator('.tools-stat__value')).toHaveText('—');
  await expect(stats.nth(0)).toContainText('Levels based on how much you trade haven’t been set yet.');
  await expect(stats.nth(1)).toContainText('30-day trading volume');
  await expect(stats.nth(1).locator('.tools-stat__value')).toHaveText('—');
  await expect(stats.nth(1)).toContainText('We don’t count your trading volume towards a fee level yet.');
  await expect(stats.nth(2).locator('.tools-stat__value')).toHaveText('0.50%');
  await expect(stats.nth(2)).toContainText('From Rank 2.');
  const levels = page.getByRole('table').first();
  await expect(levels.getByRole('columnheader')).toHaveText(['Level', '30-day volume', 'Maker', 'Taker']);
  await expect(page.getByText(/Levels and their rates haven’t been set yet/)).toBeVisible();
  const markets = page.getByRole('table', { name: 'Trading fees by market' });
  await expect(markets.getByRole('columnheader')).toHaveText(['Market', 'Maker', 'Taker']);
  const btc = markets.locator('tbody tr', { hasText: 'BTC/USDT' });
  await expect(btc).toContainText('0.10%');
  await expect(btc).toContainText('0.15%');
  const unset = markets.locator('tbody tr', { hasText: 'IFC/USDT' });
  await expect(unset.locator('td')).toHaveText(['—', '—']);
  await expect(page.getByText('— means a rate hasn’t been set for that market yet.')).toBeVisible();
  const text = await bodyText(page);
  expect(text).not.toMatch(forbidden);
  expect(text).not.toMatch(/\bNaN\b|\$-|0\.00%\s*—/);
  expect(await noOverflow(page)).toBe(true);
  await snap(page, 'fees-loaded');
  expect(errors).toEqual([]);
});

test('fees: loading, a rank that cannot load, rates that cannot load, and no markets', async ({ page }) => {
  const held = await mock(page, { hold: ['rank.get', 'rank.perks'] });
  await open(page, '/uc/fees');
  await expect(page.locator('[role="status"][aria-label="Loading your rank"]')).toBeVisible();
  await snap(page, 'fees-loading');
  held.state.hold.clear();
  await held.release();
  await expect(page.locator('.tools-stat').nth(2).locator('.tools-stat__value')).toHaveText('0.50%');

  await page.unrouteAll();
  await mock(page, { fail: ['rank.get'] });
  await open(page, '/uc/fees');
  await expect(page.getByText('Couldn’t load your rank')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Trading fees by market' })).toBeVisible();
  await snap(page, 'fees-error');

  await page.unrouteAll();
  await mock(page, { fail: ['fees'] });
  await open(page, '/uc/fees');
  await expect(page.getByText('Couldn’t load market rates')).toBeVisible();

  await page.unrouteAll();
  await mock(page, { noMarkets: true, discount: 0 });
  await open(page, '/uc/fees');
  await expect(page.getByText('No markets yet')).toBeVisible();
  await expect(page.locator('.tools-stat').nth(2)).toContainText('Rank up to earn one.');
  await snap(page, 'fees-empty');
});

test('keyboard: Tab reaches the sub-nav first, the page works at 1280 wide, and nothing overflows', async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const path of ['/uc/api', '/uc/sub-accounts', '/uc/fees']) {
    await open(page, path);
    await page.getByRole('heading', { level: 1 }).waitFor();
    expect(await noOverflow(page)).toBe(true);
  }
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.closest('nav, main')?.tagName ?? '');
  expect(['NAV', 'MAIN']).toContain(focused);
});
