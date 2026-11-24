import type { Sql } from 'postgres';

/**
 * A person's acknowledgement of a venue's auto-deleveraging rules (J-derivatives-07 #5): the version of the venue's own
 * words they read, per venue. The venue publishes the rules and runs its auto-deleveraging; we keep only what the person
 * said they read. A newer version the venue publishes leaves the stored one stale: `acknowledged` is true only when the
 * stored version is the one the venue publishes now. Nothing here waits on it to open a position (owner decision
 * 2026-10-27, as the engine's own ADL disclosure: `futures/adl-disclosure.ts`).
 */
export interface VenueAdlAck {
  readonly version: string;
  readonly acknowledgedAt: Date;
}

export interface VenueAdlAcks {
  get(userId: string, venueId: string): Promise<VenueAdlAck | null>;
  /** Stores `version` as the one read, replacing any earlier one for this venue. */
  record(userId: string, venueId: string, version: string, at: Date): Promise<VenueAdlAck>;
}

export function memoryVenueAdlAcks(): VenueAdlAcks {
  const rows = new Map<string, VenueAdlAck>();
  return {
    async get(userId, venueId) {
      return rows.get(`${userId}/${venueId}`) ?? null;
    },
    async record(userId, venueId, version, at) {
      const row = { version, acknowledgedAt: at };
      rows.set(`${userId}/${venueId}`, row);
      return row;
    },
  };
}

export function sqlVenueAdlAcks(sql: Sql): VenueAdlAcks {
  return {
    async get(userId, venueId) {
      const rows = await sql<{ version: string; acknowledged_at: Date }[]>`
        SELECT version, acknowledged_at FROM trade.venue_adl_acks WHERE user_id = ${userId} AND venue_id = ${venueId}
      `;
      const row = rows[0];
      return row ? { version: row.version, acknowledgedAt: row.acknowledged_at } : null;
    },
    async record(userId, venueId, version, at) {
      const rows = await sql<{ version: string; acknowledged_at: Date }[]>`
        INSERT INTO trade.venue_adl_acks (user_id, venue_id, version, acknowledged_at)
        VALUES (${userId}, ${venueId}, ${version}, ${at})
        ON CONFLICT (user_id, venue_id) DO UPDATE SET version = EXCLUDED.version, acknowledged_at = EXCLUDED.acknowledged_at
        RETURNING version, acknowledged_at
      `;
      const row = rows[0]!;
      return { version: row.version, acknowledgedAt: row.acknowledged_at };
    },
  };
}
