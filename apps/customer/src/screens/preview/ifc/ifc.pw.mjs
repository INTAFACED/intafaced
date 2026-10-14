import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { closeSheet, expectFrame, expectSheet, mockApi, noHorizontalScroll, pageErrors, shots } from '../p2p/house-helpers.mjs';

test('IFC shows balance, staking, fee tiers, governance and mining In build; rewards are samples, never claims', async ({ page }) => {
  const errors = pageErrors(page);
  const calls = await mockApi(page);
  await page.goto('/preview/ifc');
  await expectFrame(page, 'IFC');

  await expect(page.getByTestId('ifc-balance')).toContainText('12,480.50');
  await expect(page.getByTestId('ifc-balance')).toContainText('no dollar value');
  await expect(page.getByTestId('ifc-tier')).toContainText('20% off trading fees');
  await expect(page.getByTestId('ifc-tier-row')).toHaveCount(5);
  await expect(page.locator('[data-testid="ifc-tier-row"][data-current="true"]')).toContainText('Tier 3');
  await expect(page.getByTestId('ifc-proposal')).toHaveCount(5);
  await expect(page.getByTestId('ifc-mining')).toContainText('In build');
  await expect(page.getByTestId('ifc-not-promises')).toContainText('not a promise');
  await page.screenshot({ path: join(shots, 'ifc-loaded-1440.png') });
  await page.screenshot({ path: join(shots, 'ifc-full-1440.png'), fullPage: true });

  // The reward line is a sample and carries "Not a promise"; it follows the amount and the option.
  const reward = page.getByTestId('ifc-sample-reward');
  await expect(reward).toContainText('Sample reward for this amount: 0.60 IFC a month.');
  await expect(reward).toContainText('Not a promise');
  await page.getByRole('button', { name: /^90 days/ }).click();
  await expect(reward).toContainText('1.80 IFC a month');
  await page.getByLabel('Amount to stake').fill('5000');
  await expect(reward).toContainText('9.00 IFC a month');

  // No yield or buyback is stated as fact anywhere on the page.
  const text = await page.locator('[data-preview-product="ifc"]').innerText();
  expect(text).not.toMatch(/\bAPY\b|\bAPR\b|real yield|revenue share|burn|halving|emission|TGE|upside|holders/i);

  const sheet = await expectSheet(page, calls, page.getByTestId('ifc-staking').getByRole('button', { name: 'Stake' }), 'ifc', 'IFC');
  await page.screenshot({ path: join(shots, 'ifc-sheet-1440.png') });
  await closeSheet(page, sheet);
  const sheet2 = await expectSheet(page, calls, page.getByRole('button', { name: 'Vote for' }).first(), 'ifc', 'IFC');
  await closeSheet(page, sheet2);

  expect(await noHorizontalScroll(page), 'no horizontal scroll').toBe(true);
  expect(errors).toEqual([]);
});
