import type { Sql } from 'postgres';
import type { Amount } from '@intafaced/ledger-client/money';
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
  /** When the row was stored: the order a list of orders pages in (with the key as the tie-break). */
  readonly createdAt: Date;
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
  /**
   * Record the venue's latest answer, except that a definite outcome is never replaced by a not-definite one. Returns the
   * outcome now stored (the earlier definite one when it was kept).
   */
  recordOutcome(userId: string, businessKey: string, outcome: VenueSubmitOutcome, at: Date): Promise<VenueSubmitOutcome>;
  /**
   * Claim the right to send this key's action now, until `until`. False while another request holds an unexpired claim:
   * that request is the one sending (DV-auth-03 `idempotency.in_progress`). A claim that ran out (a crashed request) is
   * taken over.
   */
  claimSend(userId: string, businessKey: string, at: Date, until: Date): Promise<boolean>;
  /** Give the claim back once the venue answered (or the send failed), so the next retry runs at once. */
  releaseSend(userId: string, businessKey: string): Promise<void>;
  /**
   * The signed order actions of one venue account, oldest first, strictly after `after` (created time, then key), at
   * most `limit` of them.
   */
  listSignedOrders(
    userId: string,
    account: { venueId: string; owner: string },
    after: { createdAt: Date; businessKey: string } | null,
    limit: number,
  ): Promise<StoredVenueAction[]>;
  /**
   * The orders we routed on `venueId` with our builder fee attached, among `venueClientOrderIds`: each venue client order
   * id with the fee rate it carried (scaled decimal bps). Only an order signed and accepted by the venue through our door
   * counts; a prepared order never sent is not routed. Where two share an id, the first prepared wins. The routed-volume
   * recon reads it (J-derivatives-17 #4).
   */
  builderFeeOrders(venueId: string, venueClientOrderIds: readonly string[]): Promise<ReadonlyMap<string, Amount>>;
}

/** The builder fee rate a routed order carried, or null for an action that is not an accepted order with our fee. */
function builderFeeRate({ prepared, signature, lastOutcome }: StoredVenueAction): Amount | null {
  if (!signature || !lastOutcome?.definite || !lastOutcome.accepted) return null;
  return prepared.intent.kind === 'place_order' && prepared.venueClientOrderId !== null && prepared.builderFee
    ? prepared.builderFee.feeBps
    : null;
}

const afterCursor = (row: StoredVenueAction, after: { createdAt: Date; businessKey: string } | null) =>
  !after ||
  row.createdAt.getTime() > after.createdAt.getTime() ||
  (row.createdAt.getTime() === after.createdAt.getTime() && row.businessKey > after.businessKey);

/** The JSON form both stores keep, so a stored action decodes to the exact action the venue prepared. */
function wire<T>(value: T): T {
  return decodeVenueWire<T>(JSON.parse(JSON.stringify(encodeVenueWire(value))));
}

export class InMemoryPreparedActionStore implements PreparedActionStore {
  private readonly rows = new Map<string, StoredVenueAction>();
  private readonly claims = new Map<string, number>();

  private id(userId: string, key: string) {
    return `${userId}\u0000${key}`;
  }

  async find(userId: string, businessKey: string) {
    return this.rows.get(this.id(userId, businessKey)) ?? null;
  }

  async insertOnce(userId: string, businessKey: string, prepared: PreparedVenueAction, at: Date) {
    const id = this.id(userId, businessKey);
    const existing = this.rows.get(id);
    if (existing) return existing;
    const row: StoredVenueAction = {
      userId,
      businessKey,
      createdAt: new Date(at.getTime()),
      prepared: wire(prepared),
      signature: null,
      lastOutcome: null,
    };
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
    if (!row) throw new Error(`no prepared venue action under ${businessKey}`);
    if (row.lastOutcome?.definite && !outcome.definite) return row.lastOutcome;
    const next = { ...row, lastOutcome: wire(outcome) };
    this.rows.set(id, next);
    return next.lastOutcome;
  }

  async claimSend(userId: string, businessKey: string, at: Date, until: Date) {
    const id = this.id(userId, businessKey);
    const held = this.claims.get(id);
    if (held !== undefined && held > at.getTime()) return false;
    this.claims.set(id, until.getTime());
    return true;
  }

  async releaseSend(userId: string, businessKey: string) {
    this.claims.delete(this.id(userId, businessKey));
  }

  async listSignedOrders(
    userId: string,
    account: { venueId: string; owner: string },
    after: { createdAt: Date; businessKey: string } | null,
    limit: number,
  ) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.userId === userId &&
          r.signature !== null &&
          r.prepared.intent.kind === 'place_order' &&
          r.prepared.venueId === account.venueId &&
          r.prepared.account.owner === account.owner &&
          afterCursor(r, after),
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.businessKey < b.businessKey ? -1 : a.businessKey > b.businessKey ? 1 : 0),
      )
      .slice(0, limit);
  }

  async builderFeeOrders(venueId: string, venueClientOrderIds: readonly string[]) {
    const wanted = new Set(venueClientOrderIds);
    const out = new Map<string, Amount>();
    for (const row of this.rows.values()) {
      const rate = builderFeeRate(row);
      const id = row.prepared.venueClientOrderId!;
      if (row.prepared.venueId === venueId && rate !== null && wanted.has(id) && !out.has(id)) out.set(id, rate);
    }
    return out;
  }
}

interface Row {
  user_id: string;
  business_key: string;
  created_at: Date;
  prepared: unknown;
  signature: unknown;
  last_outcome: unknown;
}

function fromRow(row: Row): StoredVenueAction {
  return {
    userId: row.user_id,
    businessKey: row.business_key,
    createdAt: new Date(row.created_at),
    prepared: decodeVenueWire<PreparedVenueAction>(row.prepared),
    signature: row.signature ? decodeVenueWire<VenueSignature>(row.signature) : null,
    lastOutcome: row.last_outcome ? decodeVenueWire<VenueSubmitOutcome>(row.last_outcome) : null,
  };
}

export class SqlPreparedActionStore implements PreparedActionStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, businessKey: string) {
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, created_at, prepared, signature, last_outcome FROM trade.user_venue_actions
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
      WHERE user_id = ${userId} AND business_key = ${businessKey}
        AND (${outcome.definite} OR last_outcome IS NULL OR last_outcome->>'definite' IS DISTINCT FROM 'true')`;
    const stored = await this.find(userId, businessKey);
    if (!stored?.lastOutcome) throw new Error(`no prepared venue action under ${businessKey}`);
    return stored.lastOutcome;
  }

  async claimSend(userId: string, businessKey: string, at: Date, until: Date) {
    const rows = await this.sql`
      UPDATE trade.user_venue_actions SET sending_until = ${until}
      WHERE user_id = ${userId} AND business_key = ${businessKey} AND (sending_until IS NULL OR sending_until <= ${at})
      RETURNING 1`;
    return rows.length === 1;
  }

  async releaseSend(userId: string, businessKey: string) {
    await this.sql`
      UPDATE trade.user_venue_actions SET sending_until = NULL WHERE user_id = ${userId} AND business_key = ${businessKey}`;
  }

  async listSignedOrders(
    userId: string,
    account: { venueId: string; owner: string },
    after: { createdAt: Date; businessKey: string } | null,
    limit: number,
  ) {
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, created_at, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE user_id = ${userId} AND kind = 'place_order' AND signature IS NOT NULL AND venue_id = ${account.venueId}
        AND prepared->'account'->>'owner' = ${account.owner}
        AND (${after === null} OR (created_at, business_key) > (${after?.createdAt ?? new Date(0)}, ${after?.businessKey ?? ''}))
      ORDER BY created_at, business_key
      LIMIT ${limit}`;
    return rows.map(fromRow);
  }

  async builderFeeOrders(venueId: string, venueClientOrderIds: readonly string[]) {
    const out = new Map<string, Amount>();
    if (venueClientOrderIds.length === 0) return out;
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, created_at, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE venue_id = ${venueId} AND kind = 'place_order'
        AND prepared->>'venueClientOrderId' = ANY(${this.sql.array([...venueClientOrderIds])})
        AND signature IS NOT NULL
      ORDER BY created_at, user_id, business_key`;
    for (const row of rows.map(fromRow)) {
      const rate = builderFeeRate(row);
      const id = row.prepared.venueClientOrderId!;
      if (rate !== null && !out.has(id)) out.set(id, rate);
    }
    return out;
  }
}
