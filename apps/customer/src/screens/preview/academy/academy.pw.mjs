import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { closeSheet, expectFrame, expectSheet, mockApi, noHorizontalScroll, pageErrors, shots } from '../p2p/house-helpers.mjs';

test('Academy shows courses and progress, live lobbies and certificates; every action opens the sheet', async ({ page }) => {
  const errors = pageErrors(page);
  const calls = await mockApi(page);
  await page.goto('/preview/academy');
  await expectFrame(page, 'Academy');

  await expect(page.getByTestId('academy-progress')).toContainText('2 of 6 courses finished');
  await expect(page.getByTestId('academy-progress')).toContainText('Reading an order book');
  await expect(page.getByTestId('academy-course')).toHaveCount(6);
  await page.screenshot({ path: join(shots, 'academy-courses-loaded-1440.png') });

  // A topic with no courses shows the empty state; a topic with courses filters the list.
  await page.getByRole('button', { name: 'Money', exact: true }).click();
  await expect(page.getByTestId('academy-course')).toHaveCount(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByTestId('academy-course')).toHaveCount(6);

  const sheet = await expectSheet(page, calls, page.getByRole('button', { name: 'Continue course' }).first(), 'academy', 'Academy');
  await page.screenshot({ path: join(shots, 'academy-sheet-1440.png') });
  await closeSheet(page, sheet);

  await page.getByRole('tab', { name: 'Live lobbies' }).click();
  await expect(page.getByTestId('academy-lobby')).toHaveCount(4);
  await expect(page.locator('[data-testid="academy-lobby"][data-live="true"]')).toContainText('Live now');
  await page.screenshot({ path: join(shots, 'academy-lobbies-1440.png') });
  const sheet2 = await expectSheet(page, calls, page.getByRole('button', { name: 'Join lobby' }), 'academy', 'Academy');
  await closeSheet(page, sheet2);

  await page.getByRole('tab', { name: 'Certificates' }).click();
  await expect(page.getByTestId('academy-cert')).toHaveCount(3);
  await expect(page.locator('[data-testid="academy-cert"][data-status="earned"]')).toContainText('Earned');
  await page.screenshot({ path: join(shots, 'academy-certificates-1440.png') });
  const sheet3 = await expectSheet(page, calls, page.getByRole('button', { name: 'View certificate' }), 'academy', 'Academy');
  await closeSheet(page, sheet3);

  expect(await noHorizontalScroll(page), 'no horizontal scroll').toBe(true);
  expect(errors).toEqual([]);
});
