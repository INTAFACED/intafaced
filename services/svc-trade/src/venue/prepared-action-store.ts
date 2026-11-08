import type { Sql } from 'postgres';
import {
  decodeVenueWire,
  encodeVenueWire,
  type PreparedVenueAction,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';

/**
 * One prepared venue action per business key (user-venue.ts `prepare`): stored before the wallet is asked, with the
 * signature once it is given, so a second prepare of the key returns this action and a re-submit re-sends these bytes.
 * `trade.user_venue_actions` (drizzle/20261108192135_user_venue_actions.sql). Nothing here is a balance.
 */
export interface StoredVenueAction {
  readonly userId: string;
  readonly businessKey: string;
  readonly prepared: PreparedVenueAction;
  readonly signature: VenueSignature | null;
  readonly lastOutcome: VenueSubmitOutcome | null;
}

export interface PreparedActionStore {
  find(userId: string, businessKey: string): Promise<StoredVenueAction | null>;
  /** Store `prepared` under the key unless one is there; returns the row that is stored (the first one wins). */
  insertOnce(userId: string, businessKey: string, prepared: PreparedVenueAction, at: Date): Promise<StoredVenueAction>;
  /** Record the first signature; a later call keeps the first. Returns the stored row. */
  signOnce(userId: string, businessKey: string, signature: VenueSignature, at: Date): Promise<StoredVenueAction>;
  recordOutcome(userId: string, businessKey: string, outcome: VenueSubmitOutcome, at: Date): Promise<void>;
}

/** The JSON form both stores keep, so a stored action decodes to the exact action the venue prepared. */
function wire<T>(value: T): T {
  return decodeVenueWire<T>(JSON.parse(JSON.stringify(encodeVenueWire(value))));
}

export class InMemoryPreparedActionStore implements PreparedActionStore {
  private readonly rows = new Map<string, StoredVenueAction>();

  private id(userId: string, key: string) {
    return `${userId}\u0000${key}`;
  }

  async find(userId: string, businessKey: string) {
    return this.rows.get(this.id(userId, businessKey)) ?? null;
  }

  async insertOnce(userId: string, businessKey: string, prepared: PreparedVenueAction) {
    const id = this.id(userId, businessKey);
    const existing = this.rows.get(id);
    if (existing) return existing;
    const row: StoredVenueAction = { userId, businessKey, prepared: wire(prepared), signature: null, lastOutcome: null };
    this.rows.set(id, row);
    return row;
  }

  async signOnce(userId: string, businessKey: string, signature: VenueSignature) {
    const id = this.id(userId, businessKey);
    const row = this.rows.get(id);
    if (!row) throw new Error(`no prepared venue action under ${businessKey}`);
    if (row.signature) return row;
    const signed = { ...row, signature: wire(signature) };
    this.rows.set(id, signed);
    return signed;
  }

  async recordOutcome(userId: string, businessKey: string, outcome: VenueSubmitOutcome) {
    const id = this.id(userId, businessKey);
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastOutcome: wire(outcome) });
  }
}

interface Row {
  user_id: string;
  business_key: string;
  prepared: unknown;
  signature: unknown;
  last_outcome: unknown;
}

function fromRow(row: Row): StoredVenueAction {
  return {
    userId: row.user_id,
    businessKey: row.business_key,
    prepared: decodeVenueWire<PreparedVenueAction>(row.prepared),
    signature: row.signature ? decodeVenueWire<VenueSignature>(row.signature) : null,
    lastOutcome: row.last_outcome ? decodeVenueWire<VenueSubmitOutcome>(row.last_outcome) : null,
  };
}

export class SqlPreparedActionStore implements PreparedActionStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, businessKey: string) {
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE user_id = ${userId} AND business_key = ${businessKey}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async insertOnce(userId: string, businessKey: string, prepared: PreparedVenueAction, at: Date) {
    const json = encodeVenueWire(prepared) as Parameters<Sql['json']>[0];
    await this.sql`
      INSERT INTO trade.user_venue_actions (user_id, business_key, venue_id, kind, prepared, digest, created_at)
      VALUES (${userId}, ${businessKey}, ${prepared.venueId}, ${prepared.intent.kind}, ${this.sql.json(json)}::jsonb, ${prepared.digest}, ${at})
      ON CONFLICT (user_id, business_key) DO NOTHING`;
    const stored = await this.find(userId, businessKey);
    if (!stored) throw new Error(`the prepared venue action under ${businessKey} was not stored`);
    return stored;
  }

  async signOnce(userId: string, businessKey: string, signature: VenueSignature, at: Date) {
    const json = encodeVenueWire(signature) as Parameters<Sql['json']>[0];
    await this.sql`
      UPDATE trade.user_venue_actions SET signature = ${this.sql.json(json)}::jsonb, signed_at = ${at}
      WHERE user_id = ${userId} AND business_key = ${businessKey} AND signature IS NULL`;
    const stored = await this.find(userId, businessKey);
    if (!stored) throw new Error(`no prepared venue action under ${businessKey}`);
    return stored;
  }

  async recordOutcome(userId: string, businessKey: string, outcome: VenueSubmitOutcome, at: Date) {
    const json = encodeVenueWire(outcome) as Parameters<Sql['json']>[0];
    await this.sql`
      UPDATE trade.user_venue_actions SET last_outcome = ${this.sql.json(json)}::jsonb, submitted_at = ${at}
      WHERE user_id = ${userId} AND business_key = ${businessKey}`;
  }
}
