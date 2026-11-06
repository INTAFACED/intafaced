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
    await expect(apps).toContainText('No outside app can be given access to this account yet');
    await expect(apps.getByRole('listitem')).toHaveCount(0);
    await expect(apps.getByRole('button')).toHaveCount(0);

    // Two keys, both listed with their prefix, permissions and state; neither secret appears anywhere on the page.
    const first = await makeKey(page, { name: 'app-one', preset: 'Read only' });
    const second = await makeKey(page, { name: 'app-two', preset: 'Read only' });
    await page.goto('/uc/safe/api-keys');
    const table = page.getByTestId('api-keys__table');
    for (const [name, key] of [
      ['app-one', first],
      ['app-two', second],
    ]) {
      const row = table.getByRole('row', { name: new RegExp(name) });
      await expect(row).toHaveCount(1);
      const cells = row.getByRole('cell');
      const prefix = (await cells.nth(0).textContent())?.trim() ?? '';
      expect(prefix.length, `${name} shows its prefix`).toBeGreaterThan(0);
      expect(key.startsWith(prefix), `${name}'s prefix is the start of its key`).toBe(true);
      expect(prefix.length, `${name} shows only a prefix, not the key`).toBeLessThan(key.length);
      await expect(cells.nth(2)).not.toHaveText('');
      await expect(row).toContainText('Live');
    }
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
    await expect(table.getByRole('row', { name: /app-two/ })).toContainText('Revoked by you: TEST: no longer used');
    await expect(table.getByRole('row', { name: /app-one/ })).toContainText('Live');

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
