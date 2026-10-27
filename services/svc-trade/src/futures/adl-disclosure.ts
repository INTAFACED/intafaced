/**
 * ADL in-product disclosure (D26-P1-T1g / DIRECTION:34).
 *
 * "ADL is last resort and must be disclosed in-product before a user opens a
 * position. A user auto-deleveraged without prior disclosure has been treated
 * dishonestly, whatever the docs say."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS / IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IS: a versioned disclosure the desk shows as product information, and a
 * durable, voluntary acknowledgement. No open waits on it (owner decision
 * 2026-10-27, until launch prep). The ADL last-resort pass still only reduces
 * a candidate who acknowledged (`adl-last-resort.ts`).
 *
 * IS NOT: ADL thresholds, ranking, or reduce magnitudes (D5 / owner packet).
 * Those live in `adl-last-resort.ts` and refuse-closed when unset — this file
 * invents no numbers.
 */
import type { Sql } from 'postgres';
import { ADL_DISCLOSURE_COPY, ADL_DISCLOSURE_VERSION } from './futures-policy.js';

export { ADL_DISCLOSURE_COPY, ADL_DISCLOSURE_VERSION } from './futures-policy.js';

export interface AdlDisclosureAck {
  readonly userId: string;
  readonly version: string;
  readonly acknowledgedAt: Date;
}

export interface AdlDisclosureStore {
  getAck(userId: string, version?: string): Promise<AdlDisclosureAck | null>;
  recordAck(userId: string, version: string, at: Date): Promise<AdlDisclosureAck>;
}

export interface AdlDisclosureWire {
  version: string;
  copy: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

export function presentAdlDisclosureWire(ack: AdlDisclosureAck | null): AdlDisclosureWire {
  return {
    version: ADL_DISCLOSURE_VERSION,
    copy: ADL_DISCLOSURE_COPY,
    acknowledged: ack != null && ack.version === ADL_DISCLOSURE_VERSION,
    acknowledgedAt: ack != null && ack.version === ADL_DISCLOSURE_VERSION ? ack.acknowledgedAt.toISOString() : null,
  };
}

/** In-memory store for hermetic / public-door tests. */
export function memoryAdlDisclosureStore(): AdlDisclosureStore {
  const byUser = new Map<string, AdlDisclosureAck>();

  return {
    async getAck(userId, version = ADL_DISCLOSURE_VERSION) {
      const row = byUser.get(userId);
      if (!row || row.version !== version) return null;
      return row;
    },
    async recordAck(userId, version, at) {
      const row: AdlDisclosureAck = { userId, version, acknowledgedAt: at };
      byUser.set(userId, row);
      return row;
    },
  };
}

/** Durable ack store — one row per user (latest version wins). */
export function sqlAdlDisclosureStore(sql: Sql): AdlDisclosureStore {
  return {
    async getAck(userId, version = ADL_DISCLOSURE_VERSION) {
      const rows = await sql<
        {
          user_id: string;
          version: string;
          acknowledged_at: Date;
        }[]
      >`
        SELECT user_id, version, acknowledged_at
          FROM trade.adl_disclosure_acks
         WHERE user_id = ${userId}
           AND version = ${version}
         LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        version: row.version,
        acknowledgedAt: row.acknowledged_at,
      };
    },
    async recordAck(userId, version, at) {
      const rows = await sql<
        {
          user_id: string;
          version: string;
          acknowledged_at: Date;
        }[]
      >`
        INSERT INTO trade.adl_disclosure_acks (user_id, version, acknowledged_at)
        VALUES (${userId}, ${version}, ${at})
        ON CONFLICT (user_id) DO UPDATE
          SET version = EXCLUDED.version,
              acknowledged_at = EXCLUDED.acknowledged_at
        RETURNING user_id, version, acknowledged_at
      `;
      const row = rows[0]!;
      return {
        userId: row.user_id,
        version: row.version,
        acknowledgedAt: row.acknowledged_at,
      };
    },
  };
}
