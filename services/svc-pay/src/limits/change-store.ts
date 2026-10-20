import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { LimitFigures } from './change-policy.js';

/**
 * Row access for `pay.withdrawal_limits` and its audit trail. SQL only; every
 * rule lives in change-policy.ts and change-service.ts. A writer reads the row
 * with `FOR UPDATE` inside its transaction and compares the version before it
 * writes, so two founders editing one entry cannot overwrite each other.
 */
export interface StoredLimit {
  readonly tier: string;
  readonly assetId: string;
  /** `null` is unset. */
  readonly figures: LimitFigures | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

interface LimitRow {
  tier: string;
  asset_id: string;
  per_tx: string | null;
  rolling_24h: string | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}

const stored = (r: LimitRow): StoredLimit => ({
  tier: r.tier,
  assetId: r.asset_id,
  figures: r.per_tx === null || r.rolling_24h === null ? null : { perTx: parseAmount(r.per_tx), rolling24h: parseAmount(r.rolling_24h) },
  version: r.version,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

export async function listLimits(sql: Sql): Promise<StoredLimit[]> {
  return (await sql<LimitRow[]>`SELECT * FROM pay.withdrawal_limits ORDER BY tier, asset_id`).map(stored);
}

export async function getLimit(sql: Sql, tier: string, assetId: string, forUpdate = false): Promise<StoredLimit | null> {
  const rows = forUpdate
    ? await sql<LimitRow[]>`SELECT * FROM pay.withdrawal_limits WHERE tier = ${tier} AND asset_id = ${assetId} FOR UPDATE`
    : await sql<LimitRow[]>`SELECT * FROM pay.withdrawal_limits WHERE tier = ${tier} AND asset_id = ${assetId}`;
  return rows[0] ? stored(rows[0]) : null;
}

export async function insertLimit(
  sql: Sql,
  tier: string,
  assetId: string,
  figures: LimitFigures | null,
  actorId: string,
): Promise<StoredLimit> {
  const rows = await sql<LimitRow[]>`
    INSERT INTO pay.withdrawal_limits (tier, asset_id, per_tx, rolling_24h, updated_by)
    VALUES (${tier}, ${assetId}, ${figures && formatAmount(figures.perTx)}, ${figures && formatAmount(figures.rolling24h)}, ${actorId})
    RETURNING *`;
  return stored(rows[0] as LimitRow);
}

export async function updateLimit(
  sql: Sql,
  tier: string,
  assetId: string,
  figures: LimitFigures | null,
  actorId: string,
): Promise<StoredLimit> {
  const rows = await sql<LimitRow[]>`
    UPDATE pay.withdrawal_limits
       SET per_tx = ${figures && formatAmount(figures.perTx)}, rolling_24h = ${figures && formatAmount(figures.rolling24h)},
           version = version + 1, updated_at = now(), updated_by = ${actorId}
     WHERE tier = ${tier} AND asset_id = ${assetId}
    RETURNING *`;
  return stored(rows[0] as LimitRow);
}

const json = (f: LimitFigures | null) => (f === null ? null : { perTx: formatAmount(f.perTx), rolling24h: formatAmount(f.rolling24h) });

export async function appendEvent(
  sql: Sql,
  e: {
    tier: string;
    assetId: string;
    actorId: string;
    approverId: string | null;
    before: LimitFigures | null;
    after: LimitFigures | null;
    reason: string;
  },
): Promise<void> {
  const before = json(e.before);
  const after = json(e.after);
  await sql`
    INSERT INTO pay.withdrawal_limit_events (tier, asset_id, action, actor_id, approver_id, dual_control, before, after, reason)
    VALUES (${e.tier}, ${e.assetId}, ${e.after === null ? 'clear' : 'set'}, ${e.actorId}, ${e.approverId}, ${e.approverId !== null},
            ${before === null ? null : sql.json(before)}, ${after === null ? null : sql.json(after)}, ${e.reason})`;
}

export interface EventRow {
  id: string;
  seq: string;
  tier: string;
  asset_id: string;
  action: 'set' | 'clear';
  actor_id: string;
  approver_id: string | null;
  dual_control: boolean;
  before: { perTx: string; rolling24h: string } | null;
  after: { perTx: string; rolling24h: string } | null;
  reason: string;
  created_at: Date;
}

export async function listEvents(sql: Sql, tier: string | undefined, assetId: string | undefined, limit: number): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT * FROM pay.withdrawal_limit_events
     WHERE (${tier ?? null}::text IS NULL OR tier = ${tier ?? null})
       AND (${assetId ?? null}::text IS NULL OR asset_id = ${assetId ?? null})
     ORDER BY seq DESC LIMIT ${limit}`;
}
