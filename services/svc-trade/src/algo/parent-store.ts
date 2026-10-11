import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { OrderSide } from '../spot/types.js';
import type { AlgoPlaceGrant } from './durable-principal.js';
import { parseAlgoPlaceGrant } from './durable-principal.js';
import type { AlgoChildRef, AlgoMiss, AlgoScheduleStretchReason, AlgoStatus, TwapParent } from './types.js';

/**
 * Durable TWAP parent schedule store (D-S-04 residual after #1002).
 *
 * In-memory Map on TwapEngine loses schedules on process restart. This store
 * keeps the impoverished parent + plan slices so tick can resume. Never stores
 * filledQty / avgPrice / progressPct — those are not parent fields.
 */

export interface TwapParentRecord {
  readonly parent: TwapParent;
  readonly plan: readonly Amount[];
  /** Presented at createTwap. Absent on pre-migration rows → place still halts. */
  readonly grant?: AlgoPlaceGrant | null;
}

export interface TwapParentStore {
  save(record: TwapParentRecord, onlyIfMissing?: boolean): Promise<void>;
  load(id: string): Promise<TwapParentRecord | null>;
  listForUser(userId: string): Promise<TwapParent[]>;
  listActive(): Promise<TwapParentRecord[]>;
}

type ChildJson = {
  sliceIndex: number;
  orderId: string;
  clientOrderId: string;
  qty: string;
  placedAt: string;
};

type MissJson = {
  sliceIndex: number;
  code: string;
  reason: string;
  at: string;
};

function childrenToJson(children: readonly AlgoChildRef[]): ChildJson[] {
  return children.map((c) => ({
    sliceIndex: c.sliceIndex,
    orderId: c.orderId,
    clientOrderId: c.clientOrderId,
    qty: formatAmount(c.qty),
    placedAt: c.placedAt.toISOString(),
  }));
}

function childrenFromJson(raw: unknown): AlgoChildRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const row = c as ChildJson;
    return {
      sliceIndex: row.sliceIndex,
      orderId: row.orderId,
      clientOrderId: row.clientOrderId,
      qty: parseAmount(row.qty),
      placedAt: new Date(row.placedAt),
    };
  });
}

function missesToJson(misses: readonly AlgoMiss[]): MissJson[] {
  return misses.map((m) => ({
    sliceIndex: m.sliceIndex,
    code: m.code,
    reason: m.reason,
    at: m.at.toISOString(),
  }));
}

function missesFromJson(raw: unknown): AlgoMiss[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const row = m as MissJson;
    return {
      sliceIndex: row.sliceIndex,
      code: row.code as AlgoMiss['code'],
      reason: row.reason,
      at: new Date(row.at),
    };
  });
}

function planToJson(plan: readonly Amount[]): string[] {
  return plan.map((q) => formatAmount(q));
}

function planFromJson(raw: unknown): Amount[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => parseAmount(String(s)));
}

function stretchFromRow(raw: unknown): AlgoScheduleStretchReason | null {
  if (raw === 'user_pause' || raw === 'tick_outage') return raw;
  return null;
}

export class SqlTwapParentStore implements TwapParentStore {
  constructor(private readonly sql: Sql) {}

  async save(record: TwapParentRecord, onlyIfMissing = false): Promise<void> {
    const p = record.parent;
    const existing = record.grant === undefined ? (await this.load(p.id))?.grant : record.grant;
    const grantJson = existing
      ? this.sql.json({
          scopes: [...existing.scopes],
          sid: existing.sid,
          tier: existing.tier,
          mfa: existing.mfa,
          ...(existing.sub_account ? { sub_account: existing.sub_account } : {}),
          ...(existing.kid ? { kid: existing.kid } : {}),
          ...(existing.key_env ? { key_env: existing.key_env } : {}),
        })
      : null;
    await this.sql`
      INSERT INTO algo_parents (
        id, user_id, sub_account_id, market_id, symbol, side, kind,
        total_qty, duration_ms, slice_interval_ms, limit_price,
        status, created_at, started_at, next_due_at, projected_ends_at,
        schedule_stretch_reason, paused_at, halt_reason,
        slices_planned, next_slice_index, plan_slices, children, misses, grant_claims,
        participation_bps, lot_size, updated_at
      ) VALUES (
        ${p.id},
        ${p.userId},
        ${p.subAccountId},
        ${p.marketId},
        ${p.symbol},
        ${p.side},
        ${p.kind},
        ${formatAmount(p.totalQty)},
        ${p.durationMs},
        ${p.sliceIntervalMs},
        ${p.limitPrice === null ? null : formatAmount(p.limitPrice)},
        ${p.status},
        ${p.createdAt},
        ${p.startedAt},
        ${p.nextDueAt},
        ${p.projectedEndsAt},
        ${p.scheduleStretchReason},
        ${p.pausedAt},
        ${p.haltReason},
        ${p.slicesPlanned},
        ${p.nextSliceIndex},
        ${this.sql.json(planToJson(record.plan))},
        ${this.sql.json(childrenToJson(p.children))},
        ${this.sql.json(missesToJson(p.misses))},
        ${grantJson},
        ${p.participationBps},
        ${p.lotSize === null ? null : formatAmount(p.lotSize)},
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        paused_at = EXCLUDED.paused_at,
        halt_reason = EXCLUDED.halt_reason,
        next_slice_index = EXCLUDED.next_slice_index,
        next_due_at = EXCLUDED.next_due_at,
        projected_ends_at = EXCLUDED.projected_ends_at,
        schedule_stretch_reason = EXCLUDED.schedule_stretch_reason,
        plan_slices = EXCLUDED.plan_slices,
        children = EXCLUDED.children,
        misses = EXCLUDED.misses,
        grant_claims = COALESCE(EXCLUDED.grant_claims, algo_parents.grant_claims),
        participation_bps = EXCLUDED.participation_bps,
        lot_size = COALESCE(EXCLUDED.lot_size, algo_parents.lot_size),
        updated_at = now()
      WHERE NOT ${onlyIfMissing}
    `;
  }

  async load(id: string): Promise<TwapParentRecord | null> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM algo_parents WHERE id = ${id}
    `;
    if (!rows[0]) return null;
    return rowToRecord(rows[0]);
  }

  async listForUser(userId: string): Promise<TwapParent[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM algo_parents WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    return rows.map((r) => rowToRecord(r).parent);
  }

  async listActive(): Promise<TwapParentRecord[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM algo_parents WHERE status = 'active' ORDER BY started_at ASC
    `;
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: Record<string, unknown>): TwapParentRecord {
  const startedAt = new Date(String(row.started_at));
  const durationMs = Number(row.duration_ms);
  const sliceIntervalMs = Number(row.slice_interval_ms);
  const nextSliceIndex = Number(row.next_slice_index);
  // Pre-migration rows: derive nextDueAt the old (broken) way only as a hydrate
  // fallback — engine re-spaces on the next place/miss/resume/outage event.
  const nextDueAt = row.next_due_at ? new Date(String(row.next_due_at)) : new Date(startedAt.getTime() + nextSliceIndex * sliceIntervalMs);
  const projectedEndsAt = row.projected_ends_at ? new Date(String(row.projected_ends_at)) : new Date(startedAt.getTime() + durationMs);

  const parent: TwapParent = {
    id: String(row.id),
    userId: String(row.user_id),
    subAccountId: row.sub_account_id === null || row.sub_account_id === undefined ? null : String(row.sub_account_id),
    marketId: String(row.market_id),
    symbol: String(row.symbol),
    side: row.side as OrderSide,
    kind: row.kind === 'vwap' || row.kind === 'pov' ? row.kind : 'twap',
    totalQty: parseAmount(String(row.total_qty)),
    durationMs,
    sliceIntervalMs,
    limitPrice: row.limit_price === null || row.limit_price === undefined ? null : parseAmount(String(row.limit_price)),
    status: row.status as AlgoStatus,
    createdAt: new Date(String(row.created_at)),
    startedAt,
    nextDueAt,
    projectedEndsAt,
    scheduleStretchReason: stretchFromRow(row.schedule_stretch_reason),
    pausedAt: row.paused_at ? new Date(String(row.paused_at)) : null,
    haltReason: row.halt_reason === null || row.halt_reason === undefined ? null : String(row.halt_reason),
    lotSize: row.lot_size === null || row.lot_size === undefined ? null : parseAmount(String(row.lot_size)),
    participationBps: row.participation_bps === null || row.participation_bps === undefined ? null : Number(row.participation_bps),
    slicesPlanned: Number(row.slices_planned),
    nextSliceIndex,
    children: childrenFromJson(row.children),
    misses: missesFromJson(row.misses),
  };
  return { parent, plan: planFromJson(row.plan_slices), grant: parseAlgoPlaceGrant(row.grant_claims) };
}

/** In-memory store for unit tests (process-local). */
export class MemoryTwapParentStore implements TwapParentStore {
  private readonly byId = new Map<string, TwapParentRecord>();

  async save(record: TwapParentRecord, onlyIfMissing = false): Promise<void> {
    if (onlyIfMissing && this.byId.has(record.parent.id)) return;
    const prev = this.byId.get(record.parent.id);
    const grant = record.grant !== undefined ? record.grant : (prev?.grant ?? null);
    this.byId.set(record.parent.id, {
      parent: record.parent,
      plan: [...record.plan],
      grant,
    });
  }

  async load(id: string): Promise<TwapParentRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listForUser(userId: string): Promise<TwapParent[]> {
    return [...this.byId.values()].filter((r) => r.parent.userId === userId).map((r) => r.parent);
  }

  async listActive(): Promise<TwapParentRecord[]> {
    return [...this.byId.values()].filter((r) => r.parent.status === 'active');
  }
}
