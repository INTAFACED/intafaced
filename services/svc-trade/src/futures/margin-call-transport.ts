/**
 * Futures margin-call transport (D26-P1-T1b / DIRECTION MVP-2).
 *
 * #1211 sealed the C15 port + "no grace without delivery" law with
 * `stubMarginCallNotifier` (always undelivered). This file is the real
 * transport: RAISING the call and ACCEPTING delivery are one durable write
 * the trader can read back. Grace duration stays unset (D3) — delivery alone
 * must not invent a clock.
 *
 * Split mirrors bank's catalog prose without publishing into a void:
 *   · durable row = the call exists and transport accepted it (`delivered_at`)
 *   · bus/notify twin = `tradeMarginCalled`, published once per call after the
 *     row is written (`announced_at` records it; an unsent one is sent on the
 *     next tick while the call is open), so svc-notify tells the trader
 *   · a healthy tick ends the open call (`cleared_at`), so the next fall is a
 *     new call with the next sequence: one notice per crossing (J-derivatives-06 #6)
 *
 * `delivered: true` on {@link MarginCallNotifier} means this store accepted the
 * notice — the sole predicate that may later start grace
 * (`mayStartMarginCallGrace`). A write failure returns `delivered: false`.
 */
import type { EventBus } from '@intafaced/events';
import type { Sql } from 'postgres';
import type { MarginCallNotifier } from './liquidation-tick.js';

export interface MarginCallRecord {
  readonly positionId: string;
  readonly userId: string;
  readonly marketId: string;
  readonly sequence: number;
  /** Health ratio (bps) at the moment of the call — diagnostic, not a grace key. */
  readonly healthBps: number;
  readonly calledAt: Date;
  /** When this in-service transport accepted the notice. */
  readonly deliveredAt: Date;
  readonly clearedAt: Date | null;
  /** When `tradeMarginCalled` for this call was published; null until it was. */
  readonly announcedAt?: Date | null;
}

export interface MarginCallStore {
  /**
   * Persist (or refresh) an open margin call for a position.
   *
   * First raise: sequence 1. Re-ticks while still open: same sequence, refresh
   * health + deliveredAt. Never invents graceExpiresAt.
   */
  recordDelivered(input: { positionId: string; userId: string; marketId: string; healthBps: number; at: Date }): Promise<MarginCallRecord>;

  /** Open (uncleared) call for one position, or null. */
  getOpenForPosition(positionId: string): Promise<MarginCallRecord | null>;

  /** Open calls owned by a user (self-only reads at the REST boundary). */
  listOpenForUser(userId: string): Promise<MarginCallRecord[]>;

  /** Record that this call's notice was published. */
  markAnnounced(positionId: string, sequence: number, at: Date): Promise<void>;

  /** End the position's open call, if any (the position is healthy again). */
  clearOpen(positionId: string, at: Date): Promise<void>;
}

/** Wire shape for GET /api/v1/positions/:id/margin-call — decimal-free, ISO times. */
export interface MarginCallWire {
  positionId: string;
  userId: string;
  marketId: string;
  sequence: number;
  healthBps: number;
  calledAt: string;
  deliveredAt: string;
  /** Always true on this wire — undelivered calls are not exposed as product facts. */
  delivered: true;
}

export function presentMarginCallWire(row: MarginCallRecord): MarginCallWire {
  return {
    positionId: row.positionId,
    userId: row.userId,
    marketId: row.marketId,
    sequence: row.sequence,
    healthBps: row.healthBps,
    calledAt: row.calledAt.toISOString(),
    deliveredAt: row.deliveredAt.toISOString(),
    delivered: true,
  };
}

/**
 * Real notifier: durable write ⇒ delivered. Failures stay undelivered so C15
 * never starts grace off a bounced transport.
 */
export function durableMarginCallNotifier(
  store: MarginCallStore,
  announce: MarginCallAnnouncer | null = null,
  warn: (message: string, fields: Record<string, string>) => void = defaultWarn,
): MarginCallNotifier {
  return {
    async notifyMarginCall(input) {
      let row: MarginCallRecord;
      try {
        row = await store.recordDelivered(input);
      } catch {
        return { delivered: false };
      }
      // The row is the call. Telling the trader comes after it, once per call; a failed send is retried next tick while
      // the call is open, and never undoes the call.
      if (announce && row.announcedAt == null) {
        try {
          await announce(row);
          await store.markAnnounced(row.positionId, row.sequence, input.at);
        } catch (err) {
          warn('trade.margin_call.notice_unsent', { positionId: row.positionId, sequence: String(row.sequence), error: String(err) });
        }
      }
      return { delivered: true };
    },
    async clearMarginCall(input) {
      await store.clearOpen(input.positionId, input.at);
    },
  };
}

/** Publishes one call's notice. Keyed on (position, sequence), so a resend is the same event. */
export type MarginCallAnnouncer = (row: MarginCallRecord) => Promise<void>;

const defaultWarn = (message: string, fields: Record<string, string>): void =>
  console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields }));

export function marginCallIdempotencyKey(positionId: string, sequence: number): string {
  return `trade.margin_call:${positionId}:${sequence}`;
}

/** The bus announcer: `tradeMarginCalled`, with the contract's symbol read from svc-trade's own market row. */
export function busMarginCallAnnouncer(sql: Sql, bus: Pick<EventBus, 'publish'>): MarginCallAnnouncer {
  return async (row) => {
    const markets = await sql<{ symbol: string }[]>`
      SELECT m.symbol FROM trade.positions p JOIN trade.markets m ON m.id = p.market_id WHERE p.id = ${row.positionId}::uuid LIMIT 1
    `;
    const symbol = markets[0]?.symbol;
    if (!symbol) throw new Error(`no market symbol for position ${row.positionId}`);
    await bus.publish(
      'tradeMarginCalled',
      {
        positionId: row.positionId,
        userId: row.userId,
        marketId: row.marketId,
        symbol,
        sequence: row.sequence,
        healthBps: row.healthBps,
        calledAt: row.calledAt.toISOString(),
      },
      { idempotencyKey: marginCallIdempotencyKey(row.positionId, row.sequence) },
    );
  };
}

/** In-memory store for unit / public-door hermetic tests. */
export function memoryMarginCallStore(): MarginCallStore {
  const open = new Map<string, MarginCallRecord>();
  const sequences = new Map<string, number>();

  return {
    async recordDelivered(input) {
      const existing = open.get(input.positionId);
      if (existing) {
        const refreshed: MarginCallRecord = {
          ...existing,
          healthBps: input.healthBps,
          deliveredAt: input.at,
          // calledAt stays the first raise — a re-tick is not a new call.
        };
        open.set(input.positionId, refreshed);
        return refreshed;
      }
      const sequence = (sequences.get(input.positionId) ?? 0) + 1;
      sequences.set(input.positionId, sequence);
      const row: MarginCallRecord = {
        positionId: input.positionId,
        userId: input.userId,
        marketId: input.marketId,
        sequence,
        healthBps: input.healthBps,
        calledAt: input.at,
        deliveredAt: input.at,
        clearedAt: null,
        announcedAt: null,
      };
      open.set(input.positionId, row);
      return row;
    },
    async getOpenForPosition(positionId) {
      return open.get(positionId) ?? null;
    },
    async listOpenForUser(userId) {
      return [...open.values()].filter((r) => r.userId === userId);
    },
    async markAnnounced(positionId, sequence, at) {
      const row = open.get(positionId);
      if (row && row.sequence === sequence) open.set(positionId, { ...row, announcedAt: at });
    },
    async clearOpen(positionId) {
      open.delete(positionId);
    },
  };
}

/**
 * Production store — identity + delivery only. No grace column (D3).
 */
export function sqlMarginCallStore(sql: Sql): MarginCallStore {
  return {
    async recordDelivered(input) {
      const rows = await sql<
        {
          position_id: string;
          user_id: string;
          market_id: string;
          sequence: number;
          health_bps: number;
          called_at: Date;
          delivered_at: Date;
          cleared_at: Date | null;
          announced_at: Date | null;
        }[]
      >`
        WITH next_seq AS (
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
            FROM trade.position_margin_calls
           WHERE position_id = ${input.positionId}
        ),
        upsert AS (
          INSERT INTO trade.position_margin_calls (
            position_id, user_id, market_id, sequence, health_bps, called_at, delivered_at
          )
          SELECT
            ${input.positionId}::uuid,
            ${input.userId}::uuid,
            ${input.marketId},
            next_seq.sequence,
            ${input.healthBps},
            ${input.at.toISOString()}::timestamptz,
            ${input.at.toISOString()}::timestamptz
          FROM next_seq
          ON CONFLICT (position_id) WHERE cleared_at IS NULL
          DO UPDATE SET
            health_bps = EXCLUDED.health_bps,
            delivered_at = EXCLUDED.delivered_at
          RETURNING
            position_id, user_id, market_id, sequence, health_bps,
            called_at, delivered_at, cleared_at, announced_at
        )
        SELECT * FROM upsert
      `;
      const row = rows[0];
      if (!row) throw new Error('trade.margin_call_persist_failed');
      return {
        positionId: row.position_id,
        userId: row.user_id,
        marketId: row.market_id,
        sequence: row.sequence,
        healthBps: row.health_bps,
        calledAt: row.called_at instanceof Date ? row.called_at : new Date(row.called_at),
        deliveredAt: row.delivered_at instanceof Date ? row.delivered_at : new Date(row.delivered_at),
        clearedAt: row.cleared_at == null ? null : row.cleared_at instanceof Date ? row.cleared_at : new Date(row.cleared_at),
        announcedAt: row.announced_at == null ? null : row.announced_at instanceof Date ? row.announced_at : new Date(row.announced_at),
      };
    },

    async getOpenForPosition(positionId) {
      const rows = await sql<
        {
          position_id: string;
          user_id: string;
          market_id: string;
          sequence: number;
          health_bps: number;
          called_at: Date;
          delivered_at: Date;
          cleared_at: Date | null;
        }[]
      >`
        SELECT position_id, user_id, market_id, sequence, health_bps,
               called_at, delivered_at, cleared_at
          FROM trade.position_margin_calls
         WHERE position_id = ${positionId}::uuid
           AND cleared_at IS NULL
         LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        positionId: row.position_id,
        userId: row.user_id,
        marketId: row.market_id,
        sequence: row.sequence,
        healthBps: row.health_bps,
        calledAt: row.called_at instanceof Date ? row.called_at : new Date(row.called_at),
        deliveredAt: row.delivered_at instanceof Date ? row.delivered_at : new Date(row.delivered_at),
        clearedAt: null,
      };
    },

    async listOpenForUser(userId) {
      const rows = await sql<
        {
          position_id: string;
          user_id: string;
          market_id: string;
          sequence: number;
          health_bps: number;
          called_at: Date;
          delivered_at: Date;
          cleared_at: Date | null;
        }[]
      >`
        SELECT position_id, user_id, market_id, sequence, health_bps,
               called_at, delivered_at, cleared_at
          FROM trade.position_margin_calls
         WHERE user_id = ${userId}::uuid
           AND cleared_at IS NULL
         ORDER BY called_at ASC
      `;
      return rows.map((row) => ({
        positionId: row.position_id,
        userId: row.user_id,
        marketId: row.market_id,
        sequence: row.sequence,
        healthBps: row.health_bps,
        calledAt: row.called_at instanceof Date ? row.called_at : new Date(row.called_at),
        deliveredAt: row.delivered_at instanceof Date ? row.delivered_at : new Date(row.delivered_at),
        clearedAt: null,
      }));
    },

    async markAnnounced(positionId, sequence, at) {
      await sql`
        UPDATE trade.position_margin_calls
           SET announced_at = ${at.toISOString()}::timestamptz
         WHERE position_id = ${positionId}::uuid AND sequence = ${sequence} AND announced_at IS NULL
      `;
    },

    async clearOpen(positionId, at) {
      await sql`
        UPDATE trade.position_margin_calls
           SET cleared_at = ${at.toISOString()}::timestamptz
         WHERE position_id = ${positionId}::uuid AND cleared_at IS NULL
      `;
    },
  };
}
