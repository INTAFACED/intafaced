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
  /** Every action of this person whose business key starts with `prefix` (the session keys of one venue account, say). Unordered. */
  listByPrefix(userId: string, prefix: string): Promise<readonly StoredVenueAction[]>;
  /** Every `approve_agent` this person ever prepared for `agentAddress`, under any key, on any venue account. */
  agentApprovals(userId: string, agentAddress: string): Promise<readonly StoredVenueAction[]>;
  /**
   * The orders we routed on `venueId` with our builder fee attached, among `venueClientOrderIds`: each venue client order
   * id with the fee rate it carried (scaled decimal bps). Only an order signed and accepted by the venue through our door
   * counts; a prepared order never sent is not routed. Where two share an id, the first prepared wins. The routed-volume
   * recon reads it (J-derivatives-17 #4).
   */
  builderFeeOrders(venueId: string, venueClientOrderIds: readonly string[]): Promise<ReadonlyMap<string, Amount>>;
  /**
   * Among `venueClientOrderIds`, the ones of orders our door stored for this venue account with our builder fee attached
   * and signed for sending (OWNER 288 change 1b). A fill of any other order carries a builder fee that is not ours. Unlike
   * `builderFeeOrders`, an order whose submit answer was lost still counts: the venue's fill of it is the answer.
   */
  sentBuilderFeeOrders(
    venueId: string,
    account: { readonly owner: string; readonly subAccount: string | null },
    venueClientOrderIds: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /**
   * The venue accounts on `venueId` whose OWNER wallet signed an action this person prepared: the door checked that each
   * stored signature recovers to its signer, so the person controls that wallet (J-cex-spot-01 #11). An agent's
   * signature, and an action never signed, name no account. Sorted by owner, then sub-account (main account first).
   */
  ownerSignedAccounts(userId: string, venueId: string): Promise<OwnerSignedAccount[]>;
}

export interface OwnerSignedAccount {
  readonly owner: string;
  readonly subAccount: string | null;
}

/** One account per owner and sub-account, sorted, from the stored actions that name it. */
function signedAccountsOf(rows: Iterable<StoredVenueAction>, userId: string, venueId: string): OwnerSignedAccount[] {
  const seen = new Map<string, OwnerSignedAccount>();
  for (const row of rows) {
    const p = row.prepared;
    if (row.userId !== userId || p.venueId !== venueId || !row.signature) continue;
    const owner = p.account.owner.toLowerCase();
    if (p.signer.role !== 'owner' || p.signer.address.toLowerCase() !== owner) continue;
    if (row.signature.signedBy.toLowerCase() !== owner) continue;
    const subAccount = p.account.subAccount ?? null;
    seen.set(`${owner}\u0000${subAccount ?? ''}`, { owner, subAccount });
  }
  return [...seen.values()].sort((a, b) => a.owner.localeCompare(b.owner) || (a.subAccount ?? '').localeCompare(b.subAccount ?? ''));
}

/** The builder fee rate a routed order carried, or null for an action that is not an accepted order with our fee. */
function builderFeeRate({ prepared, signature, lastOutcome }: StoredVenueAction): Amount | null {
  if (!signature || !lastOutcome?.definite || !lastOutcome.accepted) return null;
  return prepared.intent.kind === 'place_order' && prepared.venueClientOrderId !== null && prepared.builderFee
    ? prepared.builderFee.feeBps
    : null;
}

/** One venue address, whatever its letter case: a hex address names the same account in upper or lower case. */
const sameAddress = (a: string | null, b: string | null) => (a === null || b === null ? a === b : a.toLowerCase() === b.toLowerCase());

/** True for an order this door stored for `account` with our builder fee attached and signed for sending. */
function sentWithOurFee(row: StoredVenueAction, venueId: string, account: { owner: string; subAccount: string | null }): boolean {
  const p = row.prepared;
  return (
    !!row.signature &&
    p.venueId === venueId &&
    p.intent.kind === 'place_order' &&
    p.venueClientOrderId !== null &&
    !!p.builderFee &&
    sameAddress(p.account.owner, account.owner) &&
    sameAddress(p.account.subAccount ?? null, account.subAccount)
  );
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
    if (!row) throw new Error(`no prepared venue action under ${businessKey}`);
    if (row.lastOutcome?.definite && !outcome.definite) return row.lastOutcome;
    const next = { ...row, lastOutcome: wire(outcome) };
    this.rows.set(id, next);
    return next.lastOutcome;
  }

  async listByPrefix(userId: string, prefix: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.businessKey.startsWith(prefix));
  }

  async agentApprovals(userId: string, agentAddress: string) {
    const address = agentAddress.toLowerCase();
    return [...this.rows.values()].filter(
      (r) => r.userId === userId && r.prepared.intent.kind === 'approve_agent' && r.prepared.intent.agentAddress.toLowerCase() === address,
    );
  }

  async ownerSignedAccounts(userId: string, venueId: string) {
    return signedAccountsOf(this.rows.values(), userId, venueId);
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

  async sentBuilderFeeOrders(
    venueId: string,
    account: { owner: string; subAccount: string | null },
    venueClientOrderIds: readonly string[],
  ) {
    const wanted = new Set(venueClientOrderIds);
    const out = new Set<string>();
    for (const row of this.rows.values()) {
      if (sentWithOurFee(row, venueId, account) && wanted.has(row.prepared.venueClientOrderId!)) out.add(row.prepared.venueClientOrderId!);
    }
    return out;
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
      WHERE user_id = ${userId} AND business_key = ${businessKey}
        AND (${outcome.definite} OR last_outcome IS NULL OR last_outcome->>'definite' IS DISTINCT FROM 'true')`;
    const stored = await this.find(userId, businessKey);
    if (!stored?.lastOutcome) throw new Error(`no prepared venue action under ${businessKey}`);
    return stored.lastOutcome;
  }

  async listByPrefix(userId: string, prefix: string) {
    // starts_with, not LIKE: a key may hold `_` or `%`, which LIKE would read as wildcards.
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE user_id = ${userId} AND starts_with(business_key, ${prefix})
      ORDER BY created_at, business_key`;
    return rows.map(fromRow);
  }

  async agentApprovals(userId: string, agentAddress: string) {
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE user_id = ${userId} AND kind = 'approve_agent'
        AND lower(prepared #>> '{intent,agentAddress}') = ${agentAddress.toLowerCase()}
      ORDER BY created_at, business_key`;
    return rows.map(fromRow);
  }

  async ownerSignedAccounts(userId: string, venueId: string) {
    // Every signed row of this person on this venue; the owner checks are the same code as the in-memory store's.
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE user_id = ${userId} AND venue_id = ${venueId} AND signature IS NOT NULL`;
    return signedAccountsOf(rows.map(fromRow), userId, venueId);
  }

  async builderFeeOrders(venueId: string, venueClientOrderIds: readonly string[]) {
    const out = new Map<string, Amount>();
    if (venueClientOrderIds.length === 0) return out;
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
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

  async sentBuilderFeeOrders(
    venueId: string,
    account: { owner: string; subAccount: string | null },
    venueClientOrderIds: readonly string[],
  ) {
    const out = new Set<string>();
    if (venueClientOrderIds.length === 0) return out;
    const rows = await this.sql<Row[]>`
      SELECT user_id, business_key, prepared, signature, last_outcome FROM trade.user_venue_actions
      WHERE venue_id = ${venueId} AND kind = 'place_order'
        AND prepared->>'venueClientOrderId' = ANY(${this.sql.array([...venueClientOrderIds])})
        AND lower(prepared->'account'->>'owner') = lower(${account.owner})
        AND signature IS NOT NULL`;
    for (const row of rows.map(fromRow)) if (sentWithOurFee(row, venueId, account)) out.add(row.prepared.venueClientOrderId!);
    return out;
  }
}
