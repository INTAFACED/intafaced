import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from './codes.js';
import { OPS_LIST_LIMIT_CAP } from './list-limit.js';
import type { WatermarkStamp } from './operator-desks.js';

export interface RestoreStampStore {
  /** The stored stamp for this key. A different fingerprint is a conflict, never a second row. */
  find(key: string, fingerprint: string): Promise<WatermarkStamp | null>;
  /** Appends the stamp, or returns the row a racing call stored first under the same key. */
  append(key: string, fingerprint: string, stamp: WatermarkStamp): Promise<WatermarkStamp>;
  list(): Promise<readonly WatermarkStamp[]>;
}

/** Digest of the request body, so a reused key with another body is told apart without storing the body twice. */
export function stampFingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

const conflict = () => new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different request');

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryRestoreStore(): RestoreStampStore {
  const rows = new Map<string, { fingerprint: string; stamp: WatermarkStamp }>();
  return {
    async find(key, fingerprint) {
      const hit = rows.get(key);
      if (!hit) return null;
      if (hit.fingerprint !== fingerprint) throw conflict();
      return hit.stamp;
    },
    async append(key, fingerprint, stamp) {
      const hit = rows.get(key);
      if (hit) {
        if (hit.fingerprint !== fingerprint) throw conflict();
        return hit.stamp;
      }
      rows.set(key, { fingerprint, stamp });
      return stamp;
    },
    async list() {
      return [...rows.values()].map((row) => row.stamp).reverse();
    },
  };
}

interface StampRow {
  service: string;
  kind: string;
  watermark: string;
  recorded_at: Date;
  recorded_by: string;
  approver_id: string;
  fingerprint?: string;
}

const toStamp = (row: StampRow): WatermarkStamp => ({
  service: row.service,
  kind: row.kind,
  watermark: row.watermark,
  recordedAt: row.recorded_at.toISOString(),
  recordedBy: row.recorded_by,
  approverId: row.approver_id,
});

/** Stamps live in `ops.restore_stamps`: append-only, one row per idempotency key, in the same schema as the CRM. */
export function createPgRestoreStore(sql: Sql): RestoreStampStore {
  const byKey = async (key: string, fingerprint: string): Promise<WatermarkStamp | null> => {
    const [row] = await sql<StampRow[]>`SELECT service,kind,watermark,recorded_at,recorded_by,approver_id,fingerprint
      FROM ops.restore_stamps WHERE idempotency_key=${key}`;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw conflict();
    return toStamp(row);
  };
  return {
    find: byKey,
    async append(key, fingerprint, stamp) {
      const [row] = await sql<StampRow[]>`INSERT INTO ops.restore_stamps
        (idempotency_key,fingerprint,service,kind,watermark,recorded_by,approver_id,recorded_at)
        VALUES (${key},${fingerprint},${stamp.service},${stamp.kind},${stamp.watermark},${stamp.recordedBy},${stamp.approverId},${stamp.recordedAt})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING service,kind,watermark,recorded_at,recorded_by,approver_id`;
      if (row) return toStamp(row);
      const prior = await byKey(key, fingerprint);
      if (!prior) throw new Error('ops.restore_stamp_vanished');
      return prior;
    },
    async list() {
      const rows = await sql<StampRow[]>`SELECT service,kind,watermark,recorded_at,recorded_by,approver_id
        FROM ops.restore_stamps ORDER BY recorded_at DESC, id DESC LIMIT ${OPS_LIST_LIMIT_CAP}`;
      return rows.map(toStamp);
    },
  };
}
