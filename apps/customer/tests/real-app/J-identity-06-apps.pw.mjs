// World: none
import { test, expect } from './journey.mjs';
import { codeOf, keyHolder, makeKey, withKey } from './developer.mjs';

// J-identity-06 #6, in the running app (docs/roadmap/journeys.json): I open Connected apps and API access and revoke a
// key. Tests titled "J-identity-06 #<n>" prove a whole step. A verified TEST account with a passkey (only such an account
// may hold a key) makes its keys through /uc/safe/api-keys/new, as the developer journeys do.
const J = 'J-identity-06';

test(`${J} #6 Connected apps and API access lists both keys with prefix, permissions and state, never the secret; the revoked key fails on its next call; an empty list is an honest empty state`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page } = await keyHolder(browser, 'ca');
  try {
    // Before any key: the honest empty states, for keys and for outside apps.
    await page.goto('/uc/safe/api-keys');
    await expect(page.getByRole('heading', { name: 'API keys', level: 1 })).toBeVisible();
    await expect(page.getByText('You have no API keys.')).toBeVisible();
    const apps = page.getByRole('region', { name: 'Connected apps' });
    await expect(apps.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
    await expect(apps).toContainText('No connected apps.');
    await expect(apps).toContainText('This platform gives no outside app access to an account, so there is none to remove');
    await expect(apps.getByRole('listitem')).toHaveCount(0);
    await expect(apps.getByRole('button')).toHaveCount(0);

    // Two keys, both listed with their prefix, permissions and state; neither secret appears anywhere on the page.
    const first = await makeKey(page, { name: 'app-one', preset: 'Read only' });
    const second = await makeKey(page, { name: 'app-two', preset: 'Read only' });
    // Read the list identity answers the page, so each row is held to the stored key: its prefix, its permissions in
    // full and its state, cell by cell (cells after the name: prefix, mode, permissions, IPs, created, ends, last used,
    // state, action).
    const stored = async () => {
      const listed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/identity/trpc/developerKeys.list'));
      await page.goto('/uc/safe/api-keys');
      const res = await listed;
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text.includes(first), 'the first secret is never in the list identity answers').toBe(false);
      expect(text.includes(second), 'the second secret is never in the list identity answers').toBe(false);
      return JSON.parse(text).result.data.keys;
    };
    const keys = await stored();
    expect(keys.map((k) => k.name).sort()).toEqual(['app-one', 'app-two']);
    const table = page.getByTestId('api-keys__table');
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('columnheader').nth(3)).toHaveText('Permissions');
    await expect(table.getByRole('columnheader').nth(8)).toHaveText('State');
    for (const [name, key] of [
      ['app-one', first],
      ['app-two', second],
    ]) {
      const record = keys.find((k) => k.name === name);
      expect(record.revoked, `${name} is not revoked yet`).toBe(false);
      expect(record.scopes.length, `${name} holds the read-only permissions`).toBeGreaterThan(0);
      const row = table.getByRole('row', { name: new RegExp(name) });
      await expect(row).toHaveCount(1);
      const cells = row.getByRole('cell');
      await expect(cells.nth(0)).toHaveText(record.prefix);
      expect(key.startsWith(record.prefix), `${name}'s prefix is the start of its key`).toBe(true);
      expect(record.prefix.length, `${name} shows only a prefix, not the key`).toBeLessThan(key.length);
      await expect(cells.nth(1)).toHaveText(record.mode === 'live' ? 'Live' : 'Sandbox');
      await expect(cells.nth(2)).toHaveText(record.scopes.join(', '));
      await expect(cells.nth(7)).toHaveText('Active');
    }
    // The same preset gives both keys the same permissions.
    expect(keys[0].scopes.slice().sort()).toEqual(keys[1].scopes.slice().sort());
    const html = await page.content();
    expect(html.includes(first), 'the first secret is never on the page').toBe(false);
    expect(html.includes(second), 'the second secret is never on the page').toBe(false);

    // Both keys answer before the revoke.
    for (const key of [first, second]) {
      const ok = await withKey(key, { path: '/api/v1/account/balance' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    }

    // Revoke the second key.
    await table
      .getByRole('row', { name: /app-two/ })
      .getByRole('button', { name: 'Revoke' })
      .click();
    const sheet = page.getByRole('dialog', { name: 'Revoke this key' });
    await sheet.getByLabel('Reason').fill('TEST: no longer used');
    await sheet.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(
      table
        .getByRole('row', { name: /app-two/ })
        .getByRole('cell')
        .nth(7),
    ).toHaveText(/Revoked by you: TEST: no longer used/);
    await expect(
      table
        .getByRole('row', { name: /app-one/ })
        .getByRole('cell')
        .nth(7),
    ).toHaveText('Active');
    // identity holds the same: app-two revoked, app-one still live, scopes unchanged.
    const afterRevoke = await stored();
    expect(afterRevoke.find((k) => k.name === 'app-two').revoked).toBe(true);
    expect(afterRevoke.find((k) => k.name === 'app-one').revoked).toBe(false);
    await expect(
      table
        .getByRole('row', { name: /app-two/ })
        .getByRole('cell')
        .nth(7),
    ).toHaveText(/Revoked by you: TEST: no longer used/);

    // Its next call fails as revoked; the other key still works.
    const refused = await withKey(second, { path: '/api/v1/account/balance' });
    expect({ status: refused.status, code: codeOf(refused.body) }, JSON.stringify(refused.body)).toEqual({
      status: 401,
      code: 'edge.api_key_revoked',
    });
    const still = await withKey(first, { path: '/api/v1/account/balance' });
    expect(still.status, JSON.stringify(still.body)).toBe(200);
  } finally {
    await page.context().close();
  }
});
