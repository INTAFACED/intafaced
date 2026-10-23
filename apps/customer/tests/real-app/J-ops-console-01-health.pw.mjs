import { expect, test } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #3: the module health board. Every platform module is a row: read figures with what they count, or
// "no source" with the blocker, or that module's own refusal. One row's failure never blanks the others.
test('J-ops-console-01 #3 the module health board shows every module, read, refused on its own row, or no source with the blocker', async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/`);
  await page.getByRole('link', { name: /^Module health/ }).click();
  await expect(page).toHaveURL(/\/health$/);
  const board = page.getByTestId('health-board');
  await expect(board.getByRole('heading', { level: 1, name: 'Module health' })).toBeVisible();
  const rows = board.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(20);
  for (const row of await rows.all()) {
    const state = await row.getAttribute('data-state');
    expect(['read', 'refused', 'unwired']).toContain(state);
    if (state === 'unwired') await expect(row).toContainText('ops.health_source_unwired');
    if (state === 'refused') await expect(row).toContainText('ops.health_source_unavailable');
    if (state === 'read') for (const cell of ['volume', 'failures', 'oldest']) await expect(row.getByTestId(cell)).not.toBeEmpty();
  }
  // Modules with a source on this board: each is either read or refused on its own row, never "no source".
  for (const module of ['bank', 'p2p', 'market', 'mining-pool'])
    await expect(board.getByTestId(`health-${module}`)).not.toHaveAttribute('data-state', 'unwired');
});
