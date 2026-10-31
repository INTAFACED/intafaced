import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { signUp } from './desk.mjs';
import { fund, signOutBrowser, toUnits } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-03 (find a transaction on the ledger and trace it to its business key) and the ledger object lookup
// (OPS-rules-monitoring-12, J-ops-console-02 #6). A fresh TEST customer is funded through the real ledger, then founder A
// signs in to the console with their own sign-in and second factor (owner decision 2026-10-23) and, on Ledger ops:
// traces the deposit's business key to its transaction, follows the transaction id to the same transaction, sees every
// posting with the balance after it, and gets honest answers for a key that never booked and an id with no transaction.

const AMOUNT = '25';
const CUSTOMER_BEFORE = '0';
const CUSTOMER_AFTER = '25';

/**
 * The deposit's two postings, cell by cell: the exact decimal-string amount on both sides, the direction each side carries
 * (svc-ledger: a credit is where value came from, a debit where it went), the fresh customer's balance before and
 * after, and the rail side moving by the same amount.
 */
async function expectPostings(postings) {
  // Columns: from or to, account, asset, direction, amount, balance before, balance after.
  await expect(postings.locator('tbody tr')).toHaveCount(2);
  const source = postings.locator('tbody tr[data-side="source"]');
  const destination = postings.locator('tbody tr[data-side="destination"]');
  await expect(source).toHaveCount(1);
  await expect(destination).toHaveCount(1);
  await expect(source.locator('td').nth(0)).toHaveText('Source');
  await expect(source.locator('td').nth(3)).toHaveText('credit');
  await expect(destination.locator('td').nth(0)).toHaveText('Destination');
  await expect(destination.locator('td').nth(3)).toHaveText('debit');
  for (const row of [source, destination]) {
    const cells = row.locator('td');
    await expect(cells.nth(2)).toHaveText('USDT');
    await expect(cells.nth(4)).toHaveText(AMOUNT);
    for (const i of [5, 6]) await expect(cells.nth(i)).toHaveText(/^-?\d+(\.\d{1,18})?$/);
  }
  // The value went to the fresh customer's account (0 to 25); the rail's side moved by exactly the same 25.
  await expect(destination.locator('td').nth(5)).toHaveText(CUSTOMER_BEFORE);
  await expect(destination.locator('td').nth(6)).toHaveText(CUSTOMER_AFTER);
  const [before, after] = await Promise.all([5, 6].map((i) => source.locator('td').nth(i).innerText()));
  expect(toUnits(before) - toUnits(after), `source ${before} to ${after} moves by ${AMOUNT}`).toBe(toUnits(AMOUNT));
}

test('J-ops-console-03 #8 trace a business key to its transaction and look the transaction up by id, as the founder', async ({ page }) => {
  test.setTimeout(240_000);
  const customer = await signUp(page, 'lk');
  const ref = `lookup-${randomBytes(4).toString('hex')}`;
  const funded = fund(customer.email, 'USDT', AMOUNT, ref);
  expect(funded.tx).toBeTruthy();
  const businessKey = `deposit:local-test:LOCAL-TEST-${ref}`;

  await signOutBrowser(page.context());
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup).toBeVisible();

  // Trace the business key: the transaction it booked, with each posting and the balance after it.
  await lookup.getByLabel('Look up by').selectOption('businessKey');
  await lookup.getByLabel('Business key', { exact: true }).fill(businessKey);
  await lookup.getByRole('button', { name: 'Look up' }).click();
  const found = lookup.getByTestId('ledger-lookup-transaction');
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.tx);
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(businessKey);
  const postings = lookup.getByTestId('ledger-lookup-postings');
  await expectPostings(postings);

  // Follow the transaction id: the lookup by id answers the same transaction.
  await lookup.getByTestId('ledger-lookup-tx-id').click();
  await expect(lookup.getByLabel('Transaction id', { exact: true })).toHaveValue(funded.tx);
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(businessKey, { timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.tx);
  await expectPostings(lookup.getByTestId('ledger-lookup-postings'));

  // A key that never booked is said in words, never an empty transaction.
  await lookup.getByLabel('Look up by').selectOption('businessKey');
  await lookup.getByLabel('Business key', { exact: true }).fill(`deposit:local-test:never-${ref}`);
  await lookup.getByRole('button', { name: 'Look up' }).click();
  await expect(lookup.getByTestId('ledger-lookup-not-found')).toContainText(`never-${ref}`, { timeout: 30_000 });

  // An id with no transaction is refused by the ledger with its own code.
  await lookup.getByLabel('Look up by').selectOption('txId');
  await lookup.getByLabel('Transaction id', { exact: true }).fill('99999999-9999-4999-8999-999999999999');
  await lookup.getByRole('button', { name: 'Look up' }).click();
  await expect(lookup.getByTestId('ledger-lookup-refused')).toContainText('No transaction has that id.', { timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-refused')).toContainText('ledger.tx_not_found');

  // A typed id that is not a UUID is never sent.
  await lookup.getByLabel('Transaction id', { exact: true }).fill('not-an-id');
  await expect(lookup.getByRole('button', { name: 'Look up' })).toBeDisabled();
});
