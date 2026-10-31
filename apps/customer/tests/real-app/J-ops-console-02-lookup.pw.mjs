import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-02 #6 (OPS-rules-monitoring-12): a founder looks up a ledger object by an id that does not exist. The ledger
// refuses with its own typed not-found, never an empty success, and the desk says each lookup is recorded under the founder
// before the ledger reads it (svc-ledger writes the access row with the id first, or refuses `ledger.lookup_unrecorded`).

test('J-ops-console-02 #6 looking up an id that does not exist is a typed not-found, recorded under the founder', async ({ page }) => {
  test.setTimeout(240_000);
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup).toContainText('Each lookup is recorded under your name before the ledger reads it.');
  await lookup.getByLabel('Look up by').selectOption('txId');
  await lookup.getByLabel('Transaction id', { exact: true }).fill('99999999-9999-4999-8999-999999999998');
  await lookup.getByRole('button', { name: 'Look up' }).click();
  const refused = lookup.getByTestId('ledger-lookup-refused');
  await expect(refused).toContainText('No transaction has that id.', { timeout: 30_000 });
  await expect(refused).toContainText('ledger.tx_not_found');
  await expect(lookup.getByTestId('ledger-lookup-transaction')).toHaveCount(0);
});
