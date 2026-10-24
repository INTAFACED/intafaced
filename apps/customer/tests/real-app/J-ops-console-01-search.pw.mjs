import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { signUp } from './desk.mjs';
import { fund } from './stack.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-01 #7: a founder types a business key into the console's cross-desk search. A fresh TEST customer is funded
// through the real ledger, so the key booked a transaction. The ledger section shows that transaction and links back to it on
// Ledger ops; the payments desk answers in its own section (svc-bank has no transfer with that id, and search by payment
// reference has no source yet, named with its blocker), and its answer never blanks the ledger's.

test('J-ops-console-01 #7 a business key in the cross-desk search shows the ledger transaction and links back to it', async ({ page }) => {
  test.setTimeout(240_000);
  const customer = await signUp(page, 'xs');
  const ref = `xsearch-${randomBytes(4).toString('hex')}`;
  const funded = fund(customer.email, 'USDT', '15', ref);
  expect(funded.tx).toBeTruthy();
  const businessKey = `deposit:local-test:LOCAL-TEST-${ref}`;

  await page.context().clearCookies();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/crm`, { waitUntil: 'load' });
  const box = page.getByTestId('console-search');
  await box.getByLabel('Search accounts, ledger and payments').fill(businessKey);
  await box.getByLabel('Search accounts, ledger and payments').press('Enter');
  await page.waitForURL((url) => url.pathname === '/search', { timeout: 60_000 });
  await expect(page.getByTestId('cross-search-q')).toHaveText(businessKey);

  // Ledger: the transaction the key booked, with its postings.
  const ledger = page.getByTestId('search-ledger');
  await expect(ledger.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.tx, { timeout: 30_000 });
  await expect(ledger.getByTestId('ledger-lookup-business-key')).toHaveText(businessKey);
  await expect(ledger.getByTestId('ledger-lookup-postings').locator('tbody tr')).toHaveCount(2);

  // Payments answers on its own: the transfer read refuses or finds nothing, and search by reference names its blocker.
  const payments = page.getByTestId('search-payments');
  await expect(payments.getByTestId('read-pay.transfer-detail')).toBeVisible();
  await expect(payments.getByTestId('unwired-payments.reference')).toContainText('Payments by reference: no source');
  await expect(payments.getByTestId('unwired-payments.reference')).toContainText('ops.search_source_unavailable');
  // Accounts says why identity was not asked, rather than an empty result.
  await expect(page.getByTestId('search-accounts')).toContainText('Identity was not asked');

  // The link back opens the same transaction on Ledger ops, looked up again there.
  await ledger.getByTestId('search-ledger-open').click();
  await page.waitForURL((url) => url.pathname === '/ledger' && url.searchParams.get('txId') === funded.tx, { timeout: 60_000 });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup.getByTestId('ledger-lookup-business-key')).toHaveText(businessKey, { timeout: 30_000 });
  await expect(lookup.getByTestId('ledger-lookup-tx-id')).toHaveText(funded.tx);
});
