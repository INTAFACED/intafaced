import type { Sql } from 'postgres';
import { z } from 'zod';
import { getAddress as toChecksum, type Address } from 'viem';
import type { AddressReportKind } from '@intafaced/contracts/protocol-address-risk';
import type { AddressRiskStore, LabelRecord, NewReport, ReportRecord, TokenStanding } from './risk.js';

/**
 * Postgres `AddressRiskStore` over `protocol.address_labels` and `protocol.address_reports` (20261107073648). A report is
 * one row whose open-unique index on its business key refuses a second open report by the same person for the same address;
 * the row is the compliance queue's row, so the write and the queue are one statement.
 */
type LabelRow = {
  kind: LabelRecord['kind'];
  value: string;
  source: LabelRecord['source'];
  reputation: LabelRecord['reputation'];
  reason: string;
  evidence_url: string | null;
  version: number;
  updated_at: Date | string;
};
type ReportRow = {
  id: string;
  idempotency_key: string;
  chain_id: number;
  address: string;
  reporter_id: string;
  kind: AddressReportKind;
  evidence_url: string | null;
  note: string | null;
  created_at: Date | string;
  inserted: boolean;
};

// The service's client is shared with drizzle, which reads timestamps back as text.
const at = (value: Date | string) => new Date(value);

const stamp = z.union([z.date(), z.string()]);
const BlockedStanding = z.object({ reason: z.string(), added_at: stamp });
const GatedStanding = z.object({ pool: z.string(), checker: z.string(), approved_at: stamp });

export class PostgresAddressRiskStore implements AddressRiskStore {
  constructor(private readonly sql: Sql) {}

  async labels(chainId: number, address: Address): Promise<LabelRecord[]> {
    const rows = await this.sql<LabelRow[]>`
      SELECT kind, value, source, reputation, reason, evidence_url, version, updated_at FROM protocol.address_labels
      WHERE chain_id = ${chainId} AND lower(address) = ${address.toLowerCase()} ORDER BY kind`;
    return rows.map((r) => ({
      kind: r.kind,
      value: r.value,
      source: r.source,
      reputation: r.reputation,
      reason: r.reason,
      evidenceUrl: r.evidence_url,
      version: r.version,
      setAt: at(r.updated_at),
    }));
  }

  async openReportCount(chainId: number, address: Address): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM protocol.address_reports
      WHERE chain_id = ${chainId} AND lower(address) = ${address.toLowerCase()} AND status = 'open'`;
    return Number(row?.count ?? '0');
  }

  async insertReport(report: NewReport): Promise<{ kind: 'created'; report: ReportRecord } | { kind: 'duplicate' }> {
    const rows = await this.sql<ReportRow[]>`
      INSERT INTO protocol.address_reports (idempotency_key, chain_id, address, reporter_id, kind, evidence_url, note)
      VALUES (${report.idempotencyKey}, ${report.chainId}, ${toChecksum(report.address)}, ${report.reporterId}, ${report.kind},
              ${report.evidenceUrl}, ${report.note})
      ON CONFLICT (idempotency_key) WHERE status = 'open'
        DO UPDATE SET duplicates_refused = protocol.address_reports.duplicates_refused + 1, updated_at = now()
      RETURNING id, idempotency_key, chain_id, address, reporter_id, kind, evidence_url, note, created_at, (xmax = 0) AS inserted`;
    const row = rows[0];
    // A second open report by the same person is refused, and counted on the open one so the queue can say so.
    if (!row || !row.inserted) return { kind: 'duplicate' };
    return {
      kind: 'created',
      report: {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        chainId: row.chain_id,
        address: toChecksum(row.address),
        reporterId: row.reporter_id,
        kind: row.kind,
        evidenceUrl: row.evidence_url,
        note: row.note,
        createdAt: at(row.created_at),
      },
    };
  }

  async tokenStanding(chainId: number, address: Address): Promise<TokenStanding> {
    const token = address.toLowerCase();
    const [blocked] = BlockedStanding.array().parse(
      await this.sql`SELECT reason, added_at FROM protocol.token_blocklist WHERE chain_id = ${chainId} AND token = ${token}`,
    );
    const [gated] = GatedStanding.array().parse(
      await this.sql`
        SELECT pool, checker_address AS checker, approved_at FROM protocol.pool_onboarding
        WHERE chain_id = ${chainId} AND status = 'approved' AND token_contract = ${token} ORDER BY approved_at DESC LIMIT 1`,
    );
    return {
      blocked: blocked ? { reason: blocked.reason, since: at(blocked.added_at).toISOString() } : null,
      permissioned: gated ? { pool: gated.pool, checkerAddress: gated.checker, approvedAt: at(gated.approved_at).toISOString() } : null,
    };
  }
}
