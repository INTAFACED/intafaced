import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #8: a founder opens the effective settings page. Every setting this console reads is a row; each blank one
// says what it stops, and the ones that stop something are listed first. A secret is shown as set or blank, never its value.
// svc-edge's own screening and network settings are read from svc-edge (or refused in its own section), and the staff counts
// the console has no source for name their blocker instead of a number.

const SECRETS = ['ADMIN_SESSION_SECRET', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN', 'ANALYTICS_REPLICA_LEDGER_URL'];

test('J-ops-console-01 #8 the effective settings page lists each blank setting with the action it stops, and no value is invented', async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
  // Found from the command palette like any page.
  await expect(page.getByRole('button', { name: /^Search/ })).toBeEnabled();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('platform settings');
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/system/settings', { timeout: 60_000 });

  const settings = page.getByTestId('effective-settings');
  await expect(settings.getByRole('heading', { level: 1, name: 'Platform settings' })).toBeVisible();
  const rows = page.getByTestId('settings-console').locator('tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(12);
  for (const row of await rows.all()) {
    const state = await row.getAttribute('data-state');
    expect(['set', 'blank']).toContain(state);
    // A blank row always says what it stops (or that blank is a legitimate choice): never an empty cell.
    if (state === 'blank') await expect(row.locator('td').nth(3)).not.toBeEmpty();
  }
  for (const name of SECRETS) {
    const cell = page.getByTestId(`setting-${name}`).locator('td').nth(2);
    await expect(cell).toHaveText(/^(Blank|Set \(secret, not shown\))$/);
  }
  // The stack's console has no analytics replica: that blank is named with what it stops, up top.
  await expect(page.getByTestId('blocking-ANALYTICS_REPLICA_CONFIGURED')).toContainText('Stops: The warehouse cubes');

  // svc-edge's settings answer in svc-edge's words, or refuse in their own section.
  const edge = page.getByTestId('settings-edge-posture');
  await expect(edge.locator('[data-state="read"], [data-state="refused"]').first()).toBeVisible();
  if (await edge.locator('[data-state="read"]').count())
    await expect(page.getByTestId('edge-screening')).toHaveAttribute('data-state', /^(set|blank)$/);

  await expect(page.getByTestId('unwired-settings.staff-counts')).toContainText('no source');
  await expect(page.getByTestId('unwired-settings.staff-counts')).toContainText('ops.settings_read_unavailable');
});
