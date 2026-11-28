import { expect } from './journey.mjs';

// Shared pieces of the venue futures desk's journeys (J-derivatives-34): how a figure is written, and a position's exit orders.

/** A figure as the app writes it (displayAmount): thousands grouped, every decimal kept. */
export function displayedAmount(v) {
  const [whole, fraction] = v.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** A venue position's exit-orders dialog on the futures desk, opened from its row on the Positions table. */
export async function openExitOrders(page, symbol) {
  await page
    .getByTestId('venue-positions')
    .locator(`tr[data-symbol="${symbol}"]`)
    .getByRole('button', { name: `Exit orders ${symbol}`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: `Exit orders for ${symbol}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
