import { expect, test } from './journey.mjs';
import { signUp } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signOutBrowser } from './stack.mjs';

// J-ops-console-02 #2: a founder types a customer's email, then a key, into the cross-desk search, and sees hits grouped by
// desk. Each desk answers in its own section: identity finds the account by its whole email, the ledger and the payments desk
// each say why an email was not sent to them, and search by payment reference names that it has no source. A key that is not an
// email or handle is not sent to identity, and the accounts section says so while the ledger answers it.

test('J-ops-console-02 #2 an email or a key in the cross-desk search, with hits grouped by desk and each desk answering alone', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const customer = await signUp(page, 'xe');

  await signOutBrowser(page.context());
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/search?q=${encodeURIComponent(customer.email.toUpperCase())}`, { waitUntil: 'load' });

  const accounts = page.getByTestId('search-accounts');
  await expect(accounts.getByTestId('search-account-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(accounts.getByTestId('search-account-row')).toContainText(customer.handle);
  // The email is masked: the whole address is never on the page.
  await expect(accounts).not.toContainText(customer.email);
  await expect(accounts).toContainText('That is every match.');

  // The ledger keeps every traced key in its access record, so an email is never sent to it; the section says why.
  await expect(page.getByTestId('search-ledger')).toContainText('An email address is not a business key');
  const payments = page.getByTestId('search-payments');
  await expect(payments).toContainText('An email address is not a transfer id');
  await expect(payments.getByTestId('unwired-payments.reference')).toContainText('no source');

  // The hit opens that customer's record.
  await accounts.getByRole('link', { name: 'Open record' }).click();
  await page.waitForURL(/\/accounts\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByTestId('customer-tab-money')).toBeVisible();

  // A key is not an identity search: that section says so, and the ledger still answers.
  await page.goto(`${ADMIN}/search?q=${encodeURIComponent('withdraw:local-test:never-booked')}`, { waitUntil: 'load' });
  await expect(page.getByTestId('search-accounts')).toContainText('Identity was not asked');
  await expect(page.getByTestId('search-ledger-none')).toContainText('withdraw:local-test:never-booked');

  // An empty search runs nothing and says what to type.
  await page.goto(`${ADMIN}/search?q=`, { waitUntil: 'load' });
  await expect(page.getByTestId('cross-search-problem')).toContainText('Type an email');
});
