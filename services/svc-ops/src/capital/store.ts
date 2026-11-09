import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OpsCapitalAlert } from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';

/** One version of one asset's threshold. `minimum` null is a cleared threshold: the asset is not monitored. */
export interface StoredThreshold {
  readonly assetId: string;
  readonly version: number;
  readonly minimum: string | null;
  readonly contact: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly setBy: string;
  readonly approvedBy: string;
  readonly setAt: string;
}

export type ThresholdChange = Omit<StoredThreshold, 'version'> & { readonly key: string; readonly fingerprint: string };

export interface CapitalStore {
  /** The latest version per asset, cleared ones included. */
  thresholds(): Promise<ReadonlyMap<string, StoredThreshold>>;
  /** The change stored under this key, or null. Another fingerprint under the same key is a conflict, never a second row. */
  find(key: string, fingerprint: string): Promise<StoredThreshold | null>;
  /** Stores the asset's next version, or returns what a racing call stored under the same key first. */
  append(change: ThresholdChange): Promise<StoredThreshold>;
  /** Opens one breach alert under its key. False when the key already has one: one alert per asset and day. */
  openBreach(alert: OpsCapitalAlert & { readonly thresholdVersion: number }): Promise<boolean>;
  /** Newest first. */
  alerts(limit: number): Promise<readonly OpsCapitalAlert[]>;
}

export const capitalFingerprint = (body: unknown): string => createHash('sha256').update(JSON.stringify(body)).digest('hex');

const conflict = () => new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different threshold change');

export class MemoryCapitalStore implements CapitalStore {
  readonly rows: (StoredThreshold & { key: string; fingerprint: string })[] = [];
  readonly breaches: (OpsCapitalAlert & { thresholdVersion: number })[] = [];

  async thresholds() {
    const out = new Map<string, StoredThreshold>();
    for (const r of this.rows) if ((out.get(r.assetId)?.version ?? 0) < r.version) out.set(r.assetId, strip(r));
    return out;
  }

  async find(key: string, fingerprint: string) {
    const row = this.rows.find((r) => r.key === key);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw conflict();
    return strip(row);
  }

  async append(change: ThresholdChange) {
    const prior = await this.find(change.key, change.fingerprint);
    if (prior) return prior;
    const version = 1 + Math.max(0, ...this.rows.filter((r) => r.assetId === change.assetId).map((r) => r.version));
    const row = { ...change, version };
    this.rows.push(row);
    return strip(row);
  }

  async openBreach(alert: OpsCapitalAlert & { thresholdVersion: number }) {
    if (this.breaches.some((b) => b.key === alert.key)) return false;
    this.breaches.push(alert);
    return true;
  }

  async alerts(limit: number) {
    return [...this.breaches]
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))
      .slice(0, limit)
      .map(({ thresholdVersion: _v, ...a }) => a);
  }
}

function strip(row: StoredThreshold & { key?: string; fingerprint?: string }): StoredThreshold {
  const { key: _k, fingerprint: _f, ...rest } = row;
  return rest;
}

type ThresholdRow = {
  asset_id: string;
  version: number;
  minimum: string | null;
  contact: string;
  reason: string;
  approval_id: string;
  set_by: string;
  approved_by: string;
  set_at: Date;
  fingerprint: string;
};

const fromRow = (r: ThresholdRow): StoredThreshold => ({
  assetId: r.asset_id,
  version: r.version,
  minimum: r.minimum === null ? null : trim(r.minimum),
  contact: r.contact,
  reason: r.reason,
  approvalId: r.approval_id,
  setBy: r.set_by,
  approvedBy: r.approved_by,
  setAt: new Date(r.set_at).toISOString(),
});

/** numeric(38,18) comes back padded: `100.000000000000000000` is `100`. */
export function trim(value: string): string {
  if (!value.includes('.')) return value;
  const out = value.replace(/0+$/, '').replace(/\.$/, '');
  return out === '' ? '0' : out;
}

export class SqlCapitalStore implements CapitalStore {
  constructor(private readonly sql: Sql) {}

  async thresholds() {
    const rows = await this.sql<ThresholdRow[]>`
      SELECT DISTINCT ON (asset_id) asset_id, version, minimum::text AS minimum, contact, reason, approval_id, set_by, approved_by,
             set_at, fingerprint
        FROM ops.capital_thresholds
       ORDER BY asset_id, version DESC`;
    return new Map(rows.map((r) => [r.asset_id, fromRow(r)]));
  }

  async find(key: string, fingerprint: string) {
    const [row] = await this.sql<ThresholdRow[]>`
      SELECT asset_id, version, minimum::text AS minimum, contact, reason, approval_id, set_by, approved_by, set_at, fingerprint
        FROM ops.capital_thresholds WHERE idempotency_key = ${key}`;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw conflict();
    return fromRow(row);
  }

  /** One asset's versions are numbered under an advisory lock, so two changes never take one version. */
  async append(change: ThresholdChange) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.capital_threshold:${change.assetId}`}))`;
      const [prior] = await tx<ThresholdRow[]>`
        SELECT asset_id, version, minimum::text AS minimum, contact, reason, approval_id, set_by, approved_by, set_at, fingerprint
          FROM ops.capital_thresholds WHERE idempotency_key = ${change.key}`;
      if (prior) {
        if (prior.fingerprint !== change.fingerprint) throw conflict();
        return fromRow(prior);
      }
      const [{ next } = { next: 1 }] = await tx<{ next: number }[]>`
        SELECT COALESCE(MAX(version), 0)::int + 1 AS next FROM ops.capital_thresholds WHERE asset_id = ${change.assetId}`;
      const [row] = await tx<ThresholdRow[]>`
        INSERT INTO ops.capital_thresholds
          (asset_id, version, minimum, contact, reason, idempotency_key, fingerprint, approval_id, set_by, approved_by, set_at)
        VALUES (${change.assetId}, ${next}, ${change.minimum}, ${change.contact}, ${change.reason}, ${change.key}, ${change.fingerprint},
          ${change.approvalId}, ${change.setBy}, ${change.approvedBy}, ${change.setAt})
        RETURNING asset_id, version, minimum::text AS minimum, contact, reason, approval_id, set_by, approved_by, set_at, fingerprint`;
      return fromRow(row!);
    }) as Promise<StoredThreshold>;
  }

  async openBreach(alert: OpsCapitalAlert & { thresholdVersion: number }) {
    const rows = await this.sql`
      INSERT INTO ops.capital_breach_alerts (key, asset_id, period, buffer, minimum, escalated_to, threshold_version, opened_at)
      VALUES (${alert.key}, ${alert.assetId}, ${alert.period}, ${alert.buffer}, ${alert.minimum}, ${alert.escalatedTo},
        ${alert.thresholdVersion}, ${alert.openedAt})
      ON CONFLICT (key) DO NOTHING
      RETURNING key`;
    return rows.length === 1;
  }

  async alerts(limit: number) {
    const rows = await this.sql<
      { key: string; asset_id: string; period: string; buffer: string; minimum: string; escalated_to: string; opened_at: Date }[]
    >`
      SELECT key, asset_id, period, buffer::text AS buffer, minimum::text AS minimum, escalated_to, opened_at
        FROM ops.capital_breach_alerts ORDER BY opened_at DESC, key LIMIT ${limit}`;
    return rows.map((r) => ({
      key: r.key,
      assetId: r.asset_id,
      period: r.period,
      buffer: trim(r.buffer),
      minimum: trim(r.minimum),
      escalatedTo: r.escalated_to,
      openedAt: new Date(r.opened_at).toISOString(),
    }));
  }
}
