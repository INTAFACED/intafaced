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
 *   · bus/notify twin = not wired here (no `tradeMarginCalled` consumer yet);
 *     REST observability is the honest public door until that event exists
 *
 * `delivered: true` on {@link MarginCallNotifier} means this store accepted the
 * notice — the sole predicate that may later start grace
 * (`mayStartMarginCallGrace`). A write failure returns `delivered: false`.
 */
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
export function durableMarginCallNotifier(store: MarginCallStore): MarginCallNotifier {
  return {
    async notifyMarginCall(input) {
      try {
        await store.recordDelivered(input);
        return { delivered: true };
      } catch {
        return { delivered: false };
      }
    },
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
  };
}

function isSequenceClash(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505' &&
    'constraint_name' in err &&
    err.constraint_name === 'position_margin_calls_seq_uidx'
  );
}

/**
 * Production store — identity + delivery only. No grace column (D3).
 */
export function sqlMarginCallStore(sql: Sql): MarginCallStore {
  async function upsertDelivered(input: Parameters<MarginCallStore['recordDelivered']>[0]): Promise<MarginCallRecord> {
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
          called_at, delivered_at, cleared_at
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
    };
  }

  return {
    async recordDelivered(input) {
      // Two raises on one position at once read the same MAX(sequence); the loser clashes on
      // position_margin_calls_seq_uidx, which upsertDelivered's ON CONFLICT does not name, only after the winner's row is
      // committed. Running the write again then meets that open call and refreshes it.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await upsertDelivered(input);
        } catch (err) {
          if (attempt >= 3 || !isSequenceClash(err)) throw err;
        }
      }
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
  };
}
