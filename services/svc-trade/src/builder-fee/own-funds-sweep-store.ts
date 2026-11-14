import type { Sql } from 'postgres';
import { decodeVenueWire, encodeVenueWire, type PreparedVenueAction, type VenueSignature } from '@intafaced/venue-contracts';
import type { OwnFundsSweepRow, OwnFundsSweepStore } from './own-funds-sweep.js';

/** The sweep's number from its key (`own-funds-sweep:<venueId>:<n>`). */
const seqOf = (key: string) => Number(key.slice(key.lastIndexOf(':') + 1));
const OPEN = new Set(['sent', 'held']);

/** `trade.own_funds_sweeps` (drizzle/20261114140000_own_funds_sweeps.sql). */
export class SqlOwnFundsSweepStore implements OwnFundsSweepStore {
  constructor(private readonly sql: Sql) {}

  async open(venueId: string): Promise<OwnFundsSweepRow | null> {
    const [row] = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM trade.own_funds_sweeps WHERE venue_id = ${venueId} AND state IN ('sent', 'held') LIMIT 1`;
    return row ? fromRow(row) : null;
  }

  async count(venueId: string): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`
      SELECT coalesce(max(seq), 0)::int AS n FROM trade.own_funds_sweeps WHERE venue_id = ${venueId}`;
    return row?.n ?? 0;
  }

  async insert(r: OwnFundsSweepRow): Promise<void> {
    await this.sql`
      INSERT INTO trade.own_funds_sweeps (key, venue_id, seq, prepared, signature, state, reason, tx_hash, ledger_tx_id)
      VALUES (${r.key}, ${r.venueId}, ${seqOf(r.key)}, ${this.sql.json(wire(r.prepared))}, ${this.sql.json(wire(r.signature))},
              ${r.state}, ${r.reason}, ${r.txHash}, ${r.ledgerTxId})`;
  }

  async update(key: string, patch: Partial<Pick<OwnFundsSweepRow, 'state' | 'reason' | 'txHash' | 'ledgerTxId'>>): Promise<void> {
    const [row] = await this.sql<Record<string, unknown>[]>`SELECT * FROM trade.own_funds_sweeps WHERE key = ${key}`;
    if (!row) throw new Error(`own-funds sweep ${key} is not stored`);
    const next = { ...fromRow(row), ...patch };
    await this.sql`
      UPDATE trade.own_funds_sweeps
         SET state = ${next.state}, reason = ${next.reason}, tx_hash = ${next.txHash}, ledger_tx_id = ${next.ledgerTxId}, updated_at = now()
       WHERE key = ${key}`;
  }
}

/** The same rules in memory, for the money tests. */
export class MemoryOwnFundsSweepStore implements OwnFundsSweepStore {
  private readonly rows = new Map<string, OwnFundsSweepRow>();

  async open(venueId: string): Promise<OwnFundsSweepRow | null> {
    return [...this.rows.values()].find((r) => r.venueId === venueId && OPEN.has(r.state)) ?? null;
  }

  async count(venueId: string): Promise<number> {
    return Math.max(0, ...[...this.rows.values()].filter((r) => r.venueId === venueId).map((r) => seqOf(r.key)));
  }

  async insert(row: OwnFundsSweepRow): Promise<void> {
    if (this.rows.has(row.key)) throw new Error(`own-funds sweep ${row.key} is already stored`);
    if (await this.open(row.venueId)) throw new Error(`venue ${row.venueId} already has an open sweep`);
    this.rows.set(row.key, row);
  }

  async update(key: string, patch: Partial<Pick<OwnFundsSweepRow, 'state' | 'reason' | 'txHash' | 'ledgerTxId'>>): Promise<void> {
    const row = this.rows.get(key);
    if (!row) throw new Error(`own-funds sweep ${key} is not stored`);
    this.rows.set(key, { ...row, ...patch });
  }
}

const wire = (value: unknown) => JSON.parse(JSON.stringify(encodeVenueWire(value)));

function fromRow(row: Record<string, unknown>): OwnFundsSweepRow {
  return {
    key: String(row.key),
    venueId: String(row.venue_id),
    prepared: decodeVenueWire<PreparedVenueAction>(row.prepared),
    signature: decodeVenueWire<VenueSignature>(row.signature),
    state: row.state as OwnFundsSweepRow['state'],
    reason: (row.reason as string | null) ?? null,
    txHash: (row.tx_hash as string | null) ?? null,
    ledgerTxId: (row.ledger_tx_id as string | null) ?? null,
  };
}
