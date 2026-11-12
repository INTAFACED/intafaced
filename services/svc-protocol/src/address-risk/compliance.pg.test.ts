import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { assertTestDatabase, createDb, postgresAvailable } from '@intafaced/db';
import { PostgresAddressRiskStore } from './risk.pg.js';
import { PostgresComplianceStore } from './compliance.pg.js';
import { approveLabel, askLabel, readQueue } from './compliance.js';
import { readAddressRisk, submitReport } from './risk.js';

/** The compliance queue (20261112090000) on a real test database. Deletes only this file's rows. */
// CI provides the database; this test runs unconditionally and fails where none answers.
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrations = ['20261107073648_protocol_address_risk.sql', '20261112090000_protocol_compliance_queue.sql'].map((f) =>
  join(here, '..', '..', 'drizzle', f),
);
if (!(await postgresAvailable(URL))) throw new Error('postgres unavailable');
const db = createDb({ url: URL, schema: 'protocol', max: 4 }, {});
const sql: Sql = db.sql;
const CHAIN_ID = 84532;
const SUSPECT = getAddress('0x000000000000000000000000000000000000bad2');
const REPORTER = '55555555-5555-4555-8555-555555555555';
const FIRST = 'founder-a';
const SECOND = 'founder-b';

describe('compliance queue (Postgres)', () => {
  const cleanup = async () => {
    await sql`DELETE FROM protocol.address_label_reviews WHERE report_id IN (SELECT id FROM protocol.address_reports WHERE address = ${SUSPECT})`;
    await sql`DELETE FROM protocol.address_reports WHERE address = ${SUSPECT}`;
    await sql`DELETE FROM protocol.address_label_history WHERE label_id IN (SELECT id FROM protocol.address_labels WHERE lower(address) = ${SUSPECT.toLowerCase()})`;
    await sql`DELETE FROM protocol.address_labels WHERE lower(address) = ${SUSPECT.toLowerCase()}`;
  };
  beforeAll(async () => {
    await assertTestDatabase(sql, 'svc-protocol compliance.pg.test');
    await sql`CREATE SCHEMA IF NOT EXISTS protocol`;
    for (const file of migrations) await sql.unsafe(readFileSync(file, 'utf8'));
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it('counts a refused duplicate on the open report, and the queue shows who reported', async () => {
    const risk = new PostgresAddressRiskStore(sql);
    const input = { chainId: CHAIN_ID, reporterId: REPORTER, address: SUSPECT, kind: 'phishing' as const, note: 'TEST phishing report' };
    await submitReport(risk, input);
    await expect(submitReport(risk, input)).rejects.toMatchObject({ code: 'protocol.reports.duplicate' });
    const queue = await readQueue(new PostgresComplianceStore(sql), CHAIN_ID, new Date());
    const row = queue.reports.find((r) => r.address === SUSPECT)!;
    expect(row).toMatchObject({ reporterId: REPORTER, note: 'TEST phishing report', status: 'open', duplicatesRefused: 1, reviews: [] });
  });

  it('publishes a label only after a second person approves, once, with a history row', async () => {
    const store = new PostgresComplianceStore(sql);
    const report = (await readQueue(store, CHAIN_ID, new Date())).reports.find((r) => r.address === SUSPECT)!;
    const review = await askLabel(store, {
      chainId: CHAIN_ID,
      reportId: report.id,
      kind: 'phishing',
      reason: 'TEST drains',
      requesterId: FIRST,
    });
    expect(review).toMatchObject({ status: 'pending', requesterId: FIRST, approverId: null });
    await expect(
      askLabel(store, { chainId: CHAIN_ID, reportId: report.id, kind: 'phishing', reason: 'again', requesterId: SECOND }),
    ).rejects.toMatchObject({ code: 'protocol.compliance.review_pending' });
    const risk = new PostgresAddressRiskStore(sql);
    expect((await readAddressRisk(risk, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false })).labels).toEqual([]);
    await expect(approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: FIRST })).rejects.toMatchObject({
      code: 'protocol.compliance.same_reviewer',
    });
    // Two approvals at once publish it once.
    const [a, b] = await Promise.all([
      approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: SECOND }),
      approveLabel(store, { chainId: CHAIN_ID, reviewId: review.id, approverId: SECOND }),
    ]);
    expect(a).toMatchObject({ status: 'published', approverId: SECOND });
    expect(b).toEqual(a);
    const card = await readAddressRisk(risk, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false });
    expect(card.reputation).toBe('UNSAFE');
    expect(card.labels).toMatchObject([{ kind: 'phishing', value: 'Phishing', source: 'user_report', reason: 'TEST drains', version: 1 }]);
    expect(card.openReports).toBe(0);
    const [history] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM protocol.address_label_history h JOIN protocol.address_labels l ON l.id = h.label_id
      WHERE lower(l.address) = ${SUSPECT.toLowerCase()}`;
    expect(history!.count).toBe('1');
  });

  it('refuses an approver who asked, in the table itself', async () => {
    const [report] = await sql<{ id: string }[]>`SELECT id FROM protocol.address_reports WHERE address = ${SUSPECT}`;
    await expect(
      sql`INSERT INTO protocol.address_label_reviews (report_id, kind, reason, status, requester_id, approver_id, decided_at)
          VALUES (${report!.id}, 'risk', 'TEST', 'published', ${FIRST}, ${FIRST}, now())`,
    ).rejects.toThrow(/four_eyes/);
  });
});
