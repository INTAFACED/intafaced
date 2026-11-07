import type { Sql } from 'postgres';
import { getAddress as toChecksum, type Address } from 'viem';
import type { AddressReportKind } from '@intafaced/contracts/protocol-address-risk';
import type { AddressRiskStore, LabelRecord, NewReport, ReportRecord } from './risk.js';

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
};

// The service's client is shared with drizzle, which reads timestamps back as text.
const at = (value: Date | string) => new Date(value);

export class PostgresAddressRiskStore implements AddressRiskStore {
  constructor(private readonly sql: Sql) {}

  async labels(chainId: number, address: Address): Promise<LabelRecord[]> {
    const rows = await this.sql<LabelRow[]>`
      SELECT kind, value, source, reputation, reason, evidence_url, version, updated_at FROM protocol.address_labels
      WHERE chain_id = ${chainId} AND address = ${toChecksum(address)} ORDER BY kind`;
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
      WHERE chain_id = ${chainId} AND address = ${toChecksum(address)} AND status = 'open'`;
    return Number(row?.count ?? '0');
  }

  async insertReport(report: NewReport): Promise<{ kind: 'created'; report: ReportRecord } | { kind: 'duplicate' }> {
    const rows = await this.sql<ReportRow[]>`
      INSERT INTO protocol.address_reports (idempotency_key, chain_id, address, reporter_id, kind, evidence_url, note)
      VALUES (${report.idempotencyKey}, ${report.chainId}, ${toChecksum(report.address)}, ${report.reporterId}, ${report.kind},
              ${report.evidenceUrl}, ${report.note})
      ON CONFLICT (idempotency_key) WHERE status = 'open' DO NOTHING
      RETURNING id, idempotency_key, chain_id, address, reporter_id, kind, evidence_url, note, created_at`;
    const row = rows[0];
    if (!row) return { kind: 'duplicate' };
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
}
