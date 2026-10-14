import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { closeSheet, expectFrame, expectSheet, mockApi, noHorizontalScroll, pageErrors, shots } from './house-helpers.mjs';

test('P2P shows the offers board, merchant badges, an escrow trade with chat, and an appeal; every action opens the sheet', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const calls = await mockApi(page);
  await page.goto('/preview/p2p');
  await expectFrame(page, 'P2P');

  // Offers board: buy side, US dollars, USDT, with merchant badges.
  const offers = page.getByTestId('p2p-offer');
  await expect(offers).toHaveCount(4);
  await expect(page.getByTestId('p2p-badge').first()).toBeVisible();
  await expect(page.getByTestId('p2p-offers')).toContainText('Top merchant');
  await expect(page.getByTestId('p2p-offers')).toContainText('Verified merchant');
  await expect(offers.first()).toContainText('$1.0010');
  await expect(page.locator('[data-preview-product="p2p"] [data-slot="preview-chip"]').nth(1)).toBeVisible();
  await page.screenshot({ path: join(shots, 'p2p-offers-loaded-1440.png') });

  // Switching to Sell and to another currency changes the list.
  await page
    .getByRole('radio', { name: 'Sell' })
    .or(page.getByRole('button', { name: 'Sell', exact: true }))
    .first()
    .click();
  await expect(offers.first().getByRole('button', { name: 'Sell USDT' })).toBeVisible();
  await page.screenshot({ path: join(shots, 'p2p-offers-sell-1440.png') });
  await page.getByRole('button', { name: 'Buy', exact: true }).first().click();

  // Empty state: a coin with no offers in a currency.
  await page.getByRole('button', { name: 'BTC', exact: true }).click();
  await page.getByLabel('Currency').click();
  await page.getByRole('option', { name: /Nigerian naira/ }).click();
  await expect(page.getByText('No offers for this choice yet')).toBeVisible();
  await page.screenshot({ path: join(shots, 'p2p-offers-empty-1440.png') });
  await page.getByRole('button', { name: 'USDT', exact: true }).click();
  await page.getByLabel('Currency').click();
  await page.getByRole('option', { name: /US dollar/ }).click();
  await expect(offers).toHaveCount(4);

  // An action on the board opens the sheet and sends nothing.
  const sheet = await expectSheet(page, calls, offers.first().getByRole('button', { name: 'Buy USDT' }), 'p2p', 'P2P');
  await page.screenshot({ path: join(shots, 'p2p-sheet-1440.png') });
  await closeSheet(page, sheet);

  // Trade in escrow: four sample states.
  await page.getByRole('tab', { name: 'Trade in escrow' }).click();
  const trade = page.getByTestId('p2p-trade');
  await expect(trade).toHaveAttribute('data-state', 'awaiting-payment');
  await expect(page.getByTestId('p2p-escrow')).toContainText('Held in escrow: 250 USDT');
  await expect(page.getByTestId('p2p-chat')).toContainText('Order placed');
  await page.screenshot({ path: join(shots, 'p2p-trade-awaiting-1440.png') });
  const sheet2 = await expectSheet(page, calls, page.getByRole('button', { name: 'I have paid' }), 'p2p', 'P2P');
  await closeSheet(page, sheet2);

  await page
    .getByRole('radio', { name: 'Payment sent' })
    .or(page.getByRole('button', { name: 'Payment sent' }))
    .first()
    .click();
  await expect(trade).toHaveAttribute('data-state', 'payment-sent');
  await expect(page.getByRole('button', { name: 'Open an appeal' })).toBeVisible();
  await page.screenshot({ path: join(shots, 'p2p-trade-sent-1440.png') });

  await page
    .getByRole('radio', { name: 'Completed' })
    .or(page.getByRole('button', { name: 'Completed' }))
    .first()
    .click();
  await expect(trade).toHaveAttribute('data-state', 'released');
  await expect(page.getByTestId('p2p-chat')).toContainText('released to your balance');
  await page.screenshot({ path: join(shots, 'p2p-trade-done-1440.png') });

  await page
    .getByRole('radio', { name: 'Appeal' })
    .or(page.getByRole('button', { name: 'Appeal', exact: true }))
    .first()
    .click();
  await expect(trade).toHaveAttribute('data-state', 'appeal');
  await expect(page.getByTestId('p2p-appeal')).toContainText('In review');
  await expect(page.getByTestId('p2p-appeal')).toContainText('Payment receipt');
  await page.screenshot({ path: join(shots, 'p2p-trade-appeal-1440.png') });
  const sheet3 = await expectSheet(page, calls, page.getByRole('button', { name: 'Add evidence' }), 'p2p', 'P2P');
  await closeSheet(page, sheet3);

  expect(await noHorizontalScroll(page), 'no horizontal scroll').toBe(true);
  expect(errors).toEqual([]);
});
