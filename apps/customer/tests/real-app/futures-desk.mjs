import { expect } from '@playwright/test';
import { UNBUILT } from './dex.mjs';

// The futures desk (/trade/futures) as the Web3 futures journeys (J-dex-protocol-18, -19) drive it: the ticket, the
// open sheet and the contract chooser, located the way J-derivatives-01 locates them.

/** Types a size and the TEST leverage in the ticket and presses Review, as the desk asks before an open. */
export async function fillTicket(page, size, { review = true } = {}) {
  const ticket = page.getByRole('region', { name: 'Order ticket' });
  await ticket.getByRole('textbox', { name: 'Size' }).fill(size);
  await ticket.getByRole('textbox', { name: 'Leverage' }).fill('5');
  if (review) await ticket.getByRole('button', { name: 'Review', exact: true }).click({ timeout: 15_000 });
  return ticket;
}

/** Confirms the open sheet, accepting a new margin tier, and waits for the fill (J-derivatives-01 #8). */
export async function confirmOpen(page) {
  const confirm = page.getByRole('alertdialog');
  const tier = confirm.getByRole('region', { name: 'New margin tier' });
  const filled = page.getByText('Order filled');
  for (let attempt = 0; attempt < 2 && !(await filled.isVisible()); attempt++) {
    if ((await tier.count()) > 0) await tier.getByRole('checkbox').click();
    await confirm.getByRole('button', { name: 'Confirm open long' }).click();
    await expect(filled.or(confirm.getByText('The numbers moved since you reviewed'))).toBeVisible({ timeout: 20_000 });
  }
  await expect(filled).toBeVisible();
}

/** Picks a contract in the desk's contract chooser. */
export async function chooseContract(page, name) {
  await page.getByRole('combobox', { name: 'Choose a contract' }).click();
  await page.getByRole('option', { name }).click(UNBUILT);
}
