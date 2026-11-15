// World: none
import { expect, test } from './journey.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-ops-console-02 #6 (OPS-rules-monitoring-12): a founder looks up a ledger object by an id that does not exist. The ledger
// refuses with its own typed not-found, never an empty success, and the lookup is audited with the id searched: svc-ledger
// writes one operator_access_log row naming the founder and that exact id before it reads (or refuses
// `ledger.lookup_unrecorded`). The row is read from the ledger's own table, not taken from the page's copy.

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** One query on svc-ledger's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function ledgerDb(read) {
  const ctx = await makeContext({ log: () => undefined });
  const postgres = createRequire(path.join(REPO, 'services', 'svc-ledger', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  const sql = postgres(`postgres://svc_ledger:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
  try {
    return await read(sql);
  } finally {
    await sql.end();
  }
}

test('J-ops-console-02 #6 looking up an id that does not exist is a typed not-found, recorded under the founder', async ({ page }) => {
  test.setTimeout(240_000);
  const founder = await founderSignIn(page, 'a');
  // A fresh id per run, so the audit row found below can only be this lookup's.
  const missing = `99999999-9999-4999-8999-${String(Date.now()).slice(-12).padStart(12, '0')}`;
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup).toContainText('Each lookup is recorded under your name before the ledger reads it.');
  await lookup.getByLabel('Look up by').selectOption('txId');
  await lookup.getByLabel('Transaction id', { exact: true }).fill(missing);
  await lookup.getByRole('button', { name: 'Look up' }).click();
  // A typed not-found, never an empty success: the ledger's code in the refusal, and no transaction drawn.
  const refused = lookup.getByTestId('ledger-lookup-refused');
  await expect(refused).toContainText('No transaction has that id.', { timeout: 30_000 });
  await expect(refused).toContainText('ledger.tx_not_found');
  await expect(lookup.getByTestId('ledger-lookup-transaction')).toHaveCount(0);

  // Audited with the id searched: exactly one access row in the ledger's own log, under this founder, naming that id.
  const rows = await ledgerDb(
    (sql) => sql`
      SELECT actor_id, action, target_owner_type, target_owner_id FROM ledger.operator_access_log
       WHERE target_owner_id = ${missing}`,
  );
  expect(rows.map((r) => ({ ...r }))).toEqual([
    { actor_id: founder.userId, action: 'transaction.read', target_owner_type: 'transaction', target_owner_id: missing },
  ]);
});
