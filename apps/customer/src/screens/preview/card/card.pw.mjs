import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { closeSheet, expectFrame, expectSheet, mockApi, noHorizontalScroll, pageErrors, shots } from '../p2p/house-helpers.mjs';

test('Card shows a virtual card with brand slots only, spending, limits, controls and transactions; every action opens the sheet', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const calls = await mockApi(page);
  await page.goto('/preview/card');
  await expectFrame(page, 'Card');

  const visual = page.getByTestId('card-visual');
  await expect(visual).toContainText('Your brand mark');
  await expect(visual).toContainText('Card network');
  await expect(visual).toContainText('•••• •••• •••• 4821');
  await expect(visual).not.toContainText(/visa|mastercard/i);
  await expect(page.getByTestId('card-spent')).toHaveText('$1,284.60');
  await expect(page.getByTestId('card-limit')).toHaveCount(4);
  await expect(page.getByTestId('card-control')).toHaveCount(4);
  await expect(page.getByTestId('card-transactions')).toContainText('−$23.90');
  await expect(page.getByTestId('card-transactions')).toContainText('Pending');
  await expect(page.getByTestId('card-transactions')).toContainText('Settled');
  await expect(page.getByTestId('card-transactions')).toContainText('IFC cashback (sample)');
  await page.screenshot({ path: join(shots, 'card-loaded-1440.png') });

  // The frozen look is a sample state; the real Freeze button only opens the sheet.
  await page
    .getByRole('radio', { name: 'Frozen' })
    .or(page.getByRole('button', { name: 'Frozen', exact: true }))
    .first()
    .click();
  await expect(visual).toHaveAttribute('data-status', 'frozen');
  await expect(visual).toContainText('Frozen. Nothing can be spent.');
  await expect(page.getByRole('button', { name: 'Unfreeze card' })).toBeVisible();
  await page.screenshot({ path: join(shots, 'card-frozen-1440.png') });

  const sheet = await expectSheet(page, calls, page.getByRole('button', { name: 'Unfreeze card' }), 'card', 'Card');
  await page.screenshot({ path: join(shots, 'card-sheet-1440.png') });
  await closeSheet(page, sheet);
  await expect(visual).toHaveAttribute('data-status', 'frozen'); // the sheet changed nothing

  const sheet2 = await expectSheet(page, calls, page.getByRole('button', { name: 'Change' }).first(), 'card', 'Card');
  await closeSheet(page, sheet2);
  const sheet3 = await expectSheet(page, calls, page.getByRole('button', { name: 'Turn off' }).first(), 'card', 'Card');
  await closeSheet(page, sheet3);

  expect(await noHorizontalScroll(page), 'no horizontal scroll').toBe(true);
  expect(errors).toEqual([]);
});
