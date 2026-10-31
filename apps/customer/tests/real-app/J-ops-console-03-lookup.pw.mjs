import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { signUp } from './desk.mjs';
import { fund, signOutBrowser } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-03 (find a transaction on the ledger and trace it to its business key) and the ledger object lookup
// (OPS-rules-monitoring-12, J-ops-console-02 #6). A fresh TEST customer is funded through the real ledger, then founder A
// signs in to the console with their own sign-in and second factor (owner decision 2026-10-23) and, on Ledger ops:
// traces the deposit's business key to its transaction, follows the transaction id to the same transaction, sees every
// posting with the balance after it, and gets honest answers for a key that never booked and an id with no transaction.

test('J-ops-console-03 #8 trace a business key to its transaction and look the transaction up by id, as the founder', async ({ page }) => {
  test.setTimeout(240_000);
  const customer = await signUp(page, 'lk');
  const ref = `lookup-${randomBytes(4).toString('hex')}`;
  const funded = fund(customer.email, 'USDT', '25', ref);
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
  await expect(postings.locator('tbody tr')).toHaveCount(2);
  await expect(postings).toContainText('credit');
  await expect(postings).toContainText('debit');
  await expect(postings).toContainText('USDT');
  await expect(postings).toContainText('25');

  // Follow the transaction id: the lookup by id answers the same transaction.
  await lookup.getByTestId('ledger-lookup-tx-id').click();
  await expect(lookup.getByLabel('Transaction id', { exact: true })).toHaveValue(funded.tx);
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(businessKey, { timeout: 30_000 });

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
