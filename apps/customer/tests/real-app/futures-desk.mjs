import { expect } from './journey.mjs';
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

/**
 * Opens one of the venue desk's folds (closed by default, off the desk's face) and hands back the scope to read in, so
 * a step reads a moved part where a person finds it: the desk's "Market details" (the contract strip, who may open,
 * the venue's rules and tiers) or the ticket's "Order options" (label, margin asset, slippage cap, price band).
 */
export async function openFold(scope, testId) {
  const fold = scope.getByTestId(testId);
  await expect(fold).toBeAttached({ timeout: 30_000 });
  if (!(await fold.evaluate((d) => d.open))) await fold.locator('summary').first().click();
  await expect(fold).toHaveAttribute('open', '');
  return scope;
}
/** The desk's "Market details", opened: `(await marketDetails(page)).getByTestId('venue-contract-strip')`. */
export const marketDetails = (page) => openFold(page, 'venue-market-details');
/** The ticket's "Order options", opened. */
export const ticketOptions = (ticket) => openFold(ticket, 'venue-ticket-options');
/**
 * A position row's rarer action (Exit orders, Reverse), behind the row's More menu: opens the menu, picks the item.
 * `name` is the action's own name ("Exit orders BTC-PERP"), as the step's words give it.
 */
export async function rowAction(row, name, exact = true) {
  await row.getByTestId('venue-position-more').click();
  await row.page().getByRole('menuitem', { name, exact }).click();
}
