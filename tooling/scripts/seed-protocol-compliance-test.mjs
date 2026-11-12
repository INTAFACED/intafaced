/**
 * Local TEST compliance queue row (J-dex-protocol-30 #1 #2). Not production data.
 *
 * svc-protocol's compliance queue starts empty on a fresh stack, so the trust desk would have no report to read and no
 * label to publish. `local-test-gates.mjs apply` files one TEST phishing report about the TEST address below, as a TEST
 * reporter, and then the same report again, which svc-protocol's own statement refuses as a duplicate and counts on the
 * open report. The note says TEST. A report already there (an earlier run) is left as it is, and no second duplicate is
 * counted. The database name must look local or test, and NODE_ENV production refuses.
 */
import { TEST_CHAIN_ID } from './local-test-facts.mjs';

export { localTestDatabaseUrl } from './seed-spot-test-listing.mjs';

export const TEST_COMPLIANCE_REPORT = Object.freeze({
  chainId: TEST_CHAIN_ID,
  address: '0x00000000000000000000000000000000000ba5E0',
  reporterId: 'local-test-reporter',
  kind: 'phishing',
  note: 'TEST phishing report',
});

const key = (r) => `report:${r.reporterId}:${r.chainId}:${r.address.toLowerCase()}`;

/**
 * The same statement svc-protocol runs for a report (PostgresAddressRiskStore.insertReport): a second open report by the
 * same person is refused and counted on the open one.
 */
async function fileReport(sql, r) {
  const [row] = await sql`
    INSERT INTO protocol.address_reports (idempotency_key, chain_id, address, reporter_id, kind, evidence_url, note)
    VALUES (${key(r)}, ${r.chainId}, ${r.address}, ${r.reporterId}, ${r.kind}, ${null}, ${r.note})
    ON CONFLICT (idempotency_key) WHERE status = 'open'
      DO UPDATE SET duplicates_refused = protocol.address_reports.duplicates_refused + 1, updated_at = now()
    RETURNING id, (xmax = 0) AS inserted`;
  return row;
}

/** File the TEST report once, then its refused duplicate. Returns whether anything was written. */
export async function insertComplianceTestReport(sql, r = TEST_COMPLIANCE_REPORT) {
  const [existing] = await sql`SELECT id FROM protocol.address_reports WHERE idempotency_key = ${key(r)} LIMIT 1`;
  if (existing) return { id: existing.id, changed: false };
  const first = await fileReport(sql, r);
  const second = await fileReport(sql, r);
  if (!first.inserted || second.inserted) throw new Error('the TEST duplicate report was not refused');
  return { id: first.id, changed: true };
}
