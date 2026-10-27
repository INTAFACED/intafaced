import { P2P_DELIST_REASONS, type P2pDelistReason } from '@intafaced/contracts';
import { P2pError } from './p2p-service.js';
import type { Sql } from 'postgres';
import { isSupportedFiat } from '@intafaced/config';
import {
  ANY_COUNTRY,
  InstrumentError,
  fingerprintDetails,
  methodIdKey,
  normaliseCountry,
  normaliseMethodId,
  parseFieldSpecs,
  pickSchema,
  SETTLEMENT_WINDOW_MAX_SECONDS,
  SETTLEMENT_WINDOW_MIN_SECONDS,
  takeRefused,
  validateDetails,
  type FieldSpec,
  type InstrumentDetails,
  type MethodSchema,
  type MethodSettlement,
} from './instruments.js';
import { unwiredHolderNameRule, type HolderNameRule } from './holder-name.js';
import { recordSwallowed, withSpan } from './tracing.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';
import {
  instrumentDetailsAad,
  isSealedInstrumentDetails,
  parseOpenedInstrumentDetails,
  type InstrumentKeyProvider,
} from './instrument-key-provider.js';

/**
 * PAYMENT INSTRUMENTS — storage, disclosure, and the record of both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS FILE IS FOR
 *
 * A seller's account details are visible to exactly one person, for exactly as
 * long as that person has to pay them, and every look is on the record.
 *
 * Stated as the invariant the code actually implements:
 *
 *     An instrument is disclosed only while the escrow it is attached to is
 *     HELD — and a disclosure that is not logged cannot happen.
 *
 * "While the escrow is held" is `ESCROW_HOLDING_STATUSES` — `escrowed`,
 * `fiat_sent`, `disputed`. It is a better boundary than "while the trade
 * exists" in both directions:
 *
 *   · not at `created`, so a taker cannot harvest a seller's bank details in
 *     the two-minute window before the lock is even known to have posted;
 *   · not at `released` / `cancelled`, so a completed trade is not a permanent
 *     licence to read the account of someone you dealt with once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW "NOT LOGGED" IS MADE IMPOSSIBLE
 *
 * Not by discipline. The reveal is ONE statement, in which the SELECT of the
 * details is cross-joined to a data-modifying CTE that writes the access log.
 * The details row is only produced when the log row was produced. There is no
 * ordering of a crash, no early return, and no future edit to this file that
 * reads the details and forgets the log, because they are the same statement.
 *
 * The database holds up the other end: `instrument_access_log` has a BEFORE
 * UPDATE OR DELETE trigger that raises. The log cannot be tidied afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE ARE TWO COPIES OF THE DETAILS
 *
 * `payment_instruments.details` is the live one the owner maintains.
 * `trade_payment_instruments.details` is a snapshot frozen when the trade was
 * opened. The duplication is deliberate and it buys two things:
 *
 *   · the owner may edit or remove the live one at any time without breaking a
 *     trade whose buyer is halfway through a bank transfer;
 *   · **the destination cannot change mid-trade.** Show account A, let the
 *     buyer start paying, switch to account B, then truthfully report that
 *     nothing arrived — that is a scam that leaves a clean audit trail, and a
 *     live pointer instead of a snapshot is what makes it possible.
 *
 * The snapshot is not permanent: `purgeExpiredSnapshots()` wipes the values off
 * closed trades past the retention window and keeps the fingerprint, so an
 * appeal can still ask "was this the account the buyer was shown" without us
 * still holding the account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Doctrine §0.6: there is no money in this file. An instrument is a
 * destination; the value is in svc-ledger and moves only through recipes.
 */

export interface InstrumentServiceOptions {
  /**
   * How long a closed trade keeps the account details it showed the buyer.
   *
   * An operator number, not an engineering one — it trades the ability to
   * adjudicate a late appeal against holding personal data we no longer need.
   * Blank / omit is unset: purge refuses rather than inventing 90d.
   */
  retentionDays?: number | null;
  /**
   * Local-test seal. Absent: new rows stay plaintext, and a sealed row refuses
   * `p2p.instrument_kms_required` instead of returning the blob as details.
   */
  keyProvider?: InstrumentKeyProvider | null;
  /**
   * P-ads-merchant-18, the own-name rule, for methods with an account-holder field. Absent: every such destination
   * refuses `p2p.holder_name_unverifiable`, never "any name".
   */
  holderNames?: HolderNameRule;
}

/** Who was looking. Recorded on every access-log row, allowed or refused. */
export type ViewerRole = 'owner' | 'counterparty' | 'moderator' | 'other';

/**
 * WHERE A REFUSAL WAITS FOR A FREE CONNECTION.
 *
 * A refused take has to be written down (#805) and it has to survive the abort
 * that the refusal itself causes — so the row cannot be written on the caller's
 * transaction, which is the one being rolled back. The first fix wrote it on
 * `this.sql` instead. That is right about durability and wrong about
 * connections: `refuseTake` runs INSIDE `reserveTrade`'s transaction, that
 * transaction is holding a pool connection, and asking the same pool for a
 * second one is a request that only completes when somebody lets go.
 *
 * Nobody lets go. `DATABASE_POOL_MAX` defaults to 10, so ten concurrent refused
 * takes against ten DIFFERENT offers hold all ten connections and each queues
 * for an eleventh. The transactions then sit `idle in transaction` — no
 * statement is running, so `statement_timeout` cannot fire, and postgres.js's
 * own queue has no timeout at all. The service does not recover, and the ten
 * offer rows stay locked, so those offers die with it. Cost to the attacker:
 * ten `trades.take` calls naming a method the offers do not list. `methodAllowed`
 * is checked before the bounds check, so no funds, no valid amount, and no
 * instrument are required.
 *
 * So the row is neither written inside the transaction nor written while it is
 * open. It is COLLECTED here — a plain in-memory push, no connection — and
 * flushed by `duringTake` once the transaction has ended and handed its
 * connection back. Durable across the abort, and never contending for the pool
 * with the transaction it is describing.
 */
export interface DenialSink {
  readonly pending: PendingDenial[];
}

/** One access-log row, held until a connection is free to write it. */
export interface PendingDenial {
  instrumentId?: string;
  ownerId?: string;
  viewerId: string;
  viewerRole: ViewerRole;
  tradeId?: string | null;
  reason: string;
}

/** What a list endpoint may return: everything EXCEPT the field values. */
export interface InstrumentHeader {
  id: string;
  ownerId: string;
  methodId: string;
  country: string;
  fiatCurrency: string;
  label: string;
  fingerprint: string;
  status: 'active' | 'removed';
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}

/** The header PLUS the values. Only ever produced by a logged read. */
export interface RevealedInstrument extends InstrumentHeader {
  details: InstrumentDetails;
  /** The instant the access-log row was written — the same statement. */
  loggedAt: Date;
}

/** What the payer sees on a live trade. Frozen at take. */
export interface TradeInstrumentView {
  tradeId: string;
  instrumentId: string;
  ownerId: string;
  methodId: string;
  country: string;
  fiatCurrency: string;
  label: string;
  details: InstrumentDetails;
  /** Each detail key's label from the method schema, in the schema's order; a key the schema no longer names keeps its key. */
  fields: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  fingerprint: string;
  attachedAt: Date;
  loggedAt: Date;
  /**
   * The seller's saved destination no longer matches what this order was placed with: edited (another fingerprint) or
   * removed. The order still pays the snapshot above; this only says so. Null while they match.
   */
  payeeChange: { readonly kind: 'changed' | 'removed' } | null;
}

export interface AccessLogEntry {
  id: string;
  instrumentId: string | null;
  ownerId: string | null;
  viewerId: string;
  viewerRole: ViewerRole;
  tradeId: string | null;
  outcome: 'revealed' | 'denied';
  denyReason: string | null;
  at: Date;
}

interface InstrumentRow {
  id: string;
  owner_id: string;
  method_id: string;
  country: string;
  fiat_currency: string;
  label: string;
  /**
   * NULL exactly when `status = 'removed'` — enforced by
   * `payment_instruments_details_ck`, not by this type. Every read below that
   * dereferences it has already filtered `status = 'active'`.
   */
  details: Record<string, string> | null;
  fingerprint: string;
  status: 'active' | 'removed';
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
}

/** Why an operator retired a payment method in a market: the one list in contracts, which customer copy words. */
export const DELIST_REASONS = P2P_DELIST_REASONS;
export type DelistReason = P2pDelistReason;

interface SchemaRow {
  method_id: string;
  country: string;
  label: string;
  fields: unknown;
  enabled: boolean;
  instant: boolean;
  settlement_window_seconds: number | null;
}

/**
 * The statuses in which a trade's payment instrument may be disclosed.
 *
 * Identical to `ESCROW_HOLDING_STATUSES` in `state.ts` and repeated as a SQL
 * literal because it is applied inside the reveal statement's WHERE clause —
 * the check has to be part of the same statement that writes the log, or a
 * trade that terminated a millisecond ago could still be read.
 */
const DISCLOSABLE_STATUSES = ['escrowed', 'fiat_sent', 'disputed'] as const;

/** Owner-published instruments.list page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertInstrumentListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.instrumentListLimitUnset), 'p2p.instrument_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.instrumentListLimitUnset), 'p2p.instrument_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Operator registry instruments.methods.list page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertMethodSchemaListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.methodSchemaListLimitUnset), 'p2p.method_schema_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.methodSchemaListLimitUnset), 'p2p.method_schema_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published instruments.accessLog page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertAccessLogLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.accessLogLimitUnset), 'p2p.access_log_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.accessLogLimitUnset), 'p2p.access_log_limit_unset');
  }
  return Math.min(500, n);
}

/** Owner-published purgeExpiredSnapshots batch. Blank / non-finite / <1 refuses. Never invent 500. */
export function assertPurgeExpiredSnapshotsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.purgeSnapshotsLimitUnset), 'p2p.purge_snapshots_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new InstrumentError(resolveP2pCopy(P2P_COPY.purgeSnapshotsLimitUnset), 'p2p.purge_snapshots_limit_unset');
  }
  return Math.min(5_000, n);
}

export class InstrumentService {
  private readonly retentionDays: number | null;
  private readonly keyProvider: InstrumentKeyProvider | null;
  private readonly holderNames: HolderNameRule;

  constructor(
    private readonly sql: Sql,
    options: InstrumentServiceOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? null;
    this.keyProvider = options.keyProvider ?? null;
    this.holderNames = options.holderNames ?? unwiredHolderNameRule();
  }

  /** The own-name rule, when the method names an account-holder field: before anything is stored. */
  private async assertOwnName(schema: MethodSchema, ownerId: string, details: InstrumentDetails): Promise<void> {
    const holder = schema.fields.find((field) => field.holderName === true);
    if (!holder) return;
    const name = details[holder.key];
    if (name === undefined) throw new InstrumentError(`"${holder.label}" is required`, 'p2p.instrument_field_missing', holder.key);
    await this.holderNames.assertOwnName(ownerId, name);
  }

  /** Fingerprint is already computed from plaintext. Seal only the stored copy. */
  private detailsForStore(instrumentId: string, ownerId: string, details: InstrumentDetails): InstrumentDetails {
    if (!this.keyProvider) return details;
    const sealed = this.keyProvider.seal(JSON.stringify(details), instrumentDetailsAad(instrumentId, ownerId));
    return Object.freeze({ _sealed: sealed });
  }

  /**
   * Plaintext rows pass through with or without a provider. A sealed row opens
   * with this instrument's id and owner id, or refuses. The sealed text is
   * never returned as account details.
   */
  private detailsFromStore(instrumentId: string, ownerId: string, stored: Record<string, string> | null): InstrumentDetails {
    if (stored == null) throw notFound(instrumentId);
    if (!isSealedInstrumentDetails(stored)) return Object.freeze({ ...stored });
    if (!this.keyProvider) {
      throw new P2pError(resolveP2pCopy(P2P_COPY.instrumentKmsRequired), 'p2p.instrument_kms_required');
    }
    const plain = this.keyProvider.open(stored._sealed, instrumentDetailsAad(instrumentId, ownerId));
    return parseOpenedInstrumentDetails(plain);
  }

  // ── The operator's registry (§6.2 "any payment method", as data) ───────────

  /**
   * Register or replace what a method requires in a country.
   *
   * `admin:compliance` at the router, because this is the record of what a
   * market's rails actually need — the same class of content as a sanctions
   * list, and equally not something a service should be guessing at.
   */
  async registerMethodSchema(input: {
    methodId: string;
    country: string;
    label: string;
    fields: unknown;
    enabled?: boolean;
    /** P-disputes-security-09. Omitted on a replace keeps the row's profile; a new row is instant. */
    settlement?: MethodSettlement;
  }): Promise<MethodSchema> {
    const methodId = normaliseMethodId(input.methodId);
    const country = normaliseCountry(input.country);
    const label = input.label.trim();
    if (label.length === 0) {
      throw new InstrumentError('A method schema needs a display label', 'p2p.instrument_schema_invalid');
    }
    const fields = parseFieldSpecs(input.fields);
    const settlement = input.settlement === undefined ? null : parseSettlement(input.settlement);
    const instant = settlement?.instant ?? true;
    const windowSeconds = settlement && !settlement.instant ? settlement.windowSeconds : null;

    // A new row still defaults to enabled. A replace that omits `enabled` must
    // not copy that default onto a row `setMethodSchemaEnabled` turned off:
    // EXCLUDED.enabled would be true, and schemaFor would accept the rail again.
    const writeEnabled = input.enabled !== undefined;
    const rows = await this.sql<SchemaRow[]>`
      INSERT INTO p2p.payment_method_schemas (method_id, country, label, fields, enabled, instant, settlement_window_seconds)
      VALUES (
        ${methodId}, ${country}, ${label}, ${this.sql.json(fields as never)}, ${input.enabled ?? true}, ${instant}, ${windowSeconds}
      )
      ON CONFLICT (method_id, country) DO UPDATE SET
        label = EXCLUDED.label,
        fields = EXCLUDED.fields,
        instant = CASE WHEN ${settlement !== null}::boolean THEN EXCLUDED.instant ELSE payment_method_schemas.instant END,
        settlement_window_seconds = CASE
          WHEN ${settlement !== null}::boolean THEN EXCLUDED.settlement_window_seconds
          ELSE payment_method_schemas.settlement_window_seconds
        END,
        enabled = CASE
          WHEN ${writeEnabled}::boolean THEN EXCLUDED.enabled
          ELSE payment_method_schemas.enabled
        END,
        -- A register that switches the method on brings it back: the retirement reason goes with it.
        delist_reason = CASE WHEN ${writeEnabled}::boolean AND EXCLUDED.enabled THEN NULL ELSE payment_method_schemas.delist_reason END,
        delisted_at = CASE WHEN ${writeEnabled}::boolean AND EXCLUDED.enabled THEN NULL ELSE payment_method_schemas.delisted_at END,
        updated_at = now()
      -- A live method is switched off only by setMethodSchemaEnabled, which records why; a register cannot do it.
      WHERE NOT (payment_method_schemas.enabled AND ${input.enabled === false}::boolean)
      RETURNING *
    `;
    if (!rows[0]) {
      throw new InstrumentError(
        'A live payment method is retired with a reason through setEnabled, not by registering it switched off',
        'p2p.delist_reason_required',
      );
    }
    return toSchema(rows[0]);
  }

  /**
   * The registry, for the "add a payment method" screen.
   *
   * Carries field specs — labels, formats, help text — and no instrument data
   * of any kind. It is the one instrument-adjacent surface a browsing user may
   * read, and it is about methods, not about people.
   */
  async listMethodSchemas(
    filter: { country?: string; methodId?: string; includeDisabled?: boolean; limit?: number } = {},
  ): Promise<MethodSchema[]> {
    const lim = assertMethodSchemaListLimit(filter.limit);
    const country = filter.country ? normaliseCountry(filter.country) : null;
    const methodId = filter.methodId ? normaliseMethodId(filter.methodId) : null;

    const rows = await this.sql<SchemaRow[]>`
      SELECT * FROM p2p.payment_method_schemas
       WHERE (${filter.includeDisabled === true}::boolean OR enabled = true)
         AND (${methodId}::text IS NULL OR method_id = ${methodId})
         AND (${country}::text IS NULL OR country IN (${country ?? ANY_COUNTRY}, ${ANY_COUNTRY}))
       ORDER BY method_id ASC, country ASC
       LIMIT ${lim}
    `;
    if (rows.length === 0 && filter.includeDisabled !== true) {
      // An empty catalogue is not "pick a method". It is no rail. Returning []
      // here is how a seller/register/pay screen still looks live against zero
      // operator methods. Operator `includeDisabled` stays a listing of rows.
      await this.refuseIfRegistryEmpty();
    }
    return rows.map(toSchema);
  }

  /**
   * Turning a method off in a market retires it there (P-trade-orders-03), and the reason is required: a take on it
   * then refuses `p2p.method_delisted` with that reason. Turning it on again clears the reason.
   */
  async setMethodSchemaEnabled(methodId: string, country: string, enabled: boolean, reason?: DelistReason): Promise<MethodSchema> {
    if (!enabled && !reason) throw new InstrumentError('Retiring a payment method needs a reason', 'p2p.delist_reason_required');
    const why = enabled ? null : (reason ?? null);
    const rows = await this.sql<SchemaRow[]>`
      UPDATE p2p.payment_method_schemas
         SET enabled = ${enabled},
             delist_reason = ${why},
             delisted_at = CASE WHEN ${enabled}::boolean THEN NULL ELSE now() END,
             updated_at = now()
       WHERE method_id = ${normaliseMethodId(methodId)} AND country = ${normaliseCountry(country)}
      RETURNING *
    `;
    if (!rows[0]) throw new InstrumentError(`No schema for "${methodId}" in ${country}`, 'p2p.instrument_method_unknown');
    return toSchema(rows[0]);
  }

  /** The applicable schema, exact country beating the wildcard. */
  private async schemaFor(methodId: string, country: string): Promise<MethodSchema> {
    const schema = await this.lookupSchema(methodId, country);

    if (!schema) {
      // The honest refusal. We do not know what this market needs, so we cannot
      // accept a destination for it — rather than accept a plausible-looking one
      // that turns out to be unpayable when a buyer tries. Empty registry uses
      // the same code (`p2p.instrument_method_unknown`) so a missing catalog
      // cannot look like a rail the seller merely has not filled in yet.
      throw emptyRegistry();
    }
    if (!schema.enabled) {
      throw new InstrumentError(`Payment method "${methodId}" is not currently accepted in ${country}`, 'p2p.instrument_method_disabled');
    }
    return schema;
  }

  /** The schema that applies to a method in a country (exact country beating the wildcard), or null when none is registered. */
  private async lookupSchema(methodId: string, country: string): Promise<MethodSchema | null> {
    const rows = await this.sql<SchemaRow[]>`
      SELECT * FROM p2p.payment_method_schemas
       WHERE method_id = ${methodId} AND country IN (${country}, ${ANY_COUNTRY})
    `;
    return pickSchema(rows.map(toSchema), methodId, country);
  }

  // ── The owner's instruments ────────────────────────────────────────────────

  async createInstrument(input: {
    ownerId: string;
    methodId: string;
    country: string;
    fiatCurrency: string;
    label?: string;
    details: unknown;
    instrumentId: string;
  }): Promise<InstrumentHeader> {
    const instrumentId = typeof input.instrumentId === 'string' ? input.instrumentId.trim() : '';
    if (!instrumentId) {
      throw new InstrumentError('instrumentId is required; adding an instrument does not mint one', 'p2p.instrument_id_required');
    }

    const methodId = normaliseMethodId(input.methodId);
    const country = normaliseCountry(input.country);
    if (country === ANY_COUNTRY) {
      // The wildcard is a property of a SCHEMA ("this method works the same
      // everywhere"), never of an instrument. A real account is in a country.
      throw new InstrumentError('An instrument must name a real country', 'p2p.instrument_country_invalid');
    }

    const fiatCurrency = input.fiatCurrency.trim().toUpperCase();
    if (!isSupportedFiat(fiatCurrency)) {
      throw new InstrumentError(`Fiat currency "${fiatCurrency}" is not enabled`, 'p2p.instrument_field_invalid', 'fiatCurrency');
    }

    const schema = await this.schemaFor(methodId, country);
    const details = validateDetails(schema, input.details);
    await this.assertOwnName(schema, input.ownerId, details);
    const fingerprint = fingerprintDetails(methodId, country, details);
    const stored = this.detailsForStore(instrumentId, input.ownerId, details);

    try {
      const rows = await this.sql<InstrumentRow[]>`
        INSERT INTO p2p.payment_instruments (id, owner_id, method_id, country, fiat_currency, label, details, fingerprint, status)
        VALUES (
          ${instrumentId}, ${input.ownerId}, ${methodId}, ${country}, ${fiatCurrency},
          ${(input.label ?? '').trim().slice(0, 120)}, ${this.sql.json(stored as never)}, ${fingerprint}, 'active'
        )
        RETURNING *
      `;
      return toHeader(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new InstrumentError(
          `You already have an active ${methodId} destination for ${fiatCurrency} — remove it before adding another`,
          'p2p.instrument_slot_taken',
        );
      }
      throw err;
    }
  }

  /**
   * Edit an instrument.
   *
   * Deliberately does NOT touch any trade already holding a snapshot of it. A
   * buyer copying an account number out of the screen must not have it change
   * under them, and a seller must not be able to redirect a payment already in
   * flight (see the file header).
   */
  async updateInstrument(input: { instrumentId: string; ownerId: string; label?: string; details?: unknown }): Promise<InstrumentHeader> {
    const current = await this.ownedInstrument(input.instrumentId, input.ownerId);

    let details: InstrumentDetails | null = null;
    let fingerprint = current.fingerprint;

    if (input.details !== undefined) {
      const schema = await this.schemaFor(current.method_id, current.country);
      details = validateDetails(schema, input.details);
      await this.assertOwnName(schema, input.ownerId, details);
      fingerprint = fingerprintDetails(current.method_id, current.country, details);
    }
    const stored = details === null ? current.details : this.detailsForStore(input.instrumentId, input.ownerId, details);

    const rows = await this.sql<InstrumentRow[]>`
      UPDATE p2p.payment_instruments
         SET label = ${input.label === undefined ? current.label : input.label.trim().slice(0, 120)},
             details = ${this.sql.json(stored as never)},
             fingerprint = ${fingerprint},
             updated_at = now()
       WHERE id = ${input.instrumentId} AND owner_id = ${input.ownerId} AND status = 'active'
      RETURNING *
    `;
    if (!rows[0]) throw notFound(input.instrumentId);
    return toHeader(rows[0]);
  }

  /**
   * Remove an instrument. **The account number goes with it.**
   *
   * A state change, never a DELETE. Three things still need the row after the
   * owner is done with it: an in-flight trade's snapshot points at it, the
   * access log points at it, and an appeal months later may ask which
   * destination a trade used. A DELETE would break the first and orphan the
   * other two — and "the seller deleted their account details" is exactly the
   * moment the log becomes worth having.
   *
   * WHAT THE ROW KEEPS AND WHAT IT LOSES, because "soft delete" is the phrase
   * under which personal data usually survives being deleted:
   *
   *   lost  · `details` — the account number, the name on it, every declared
   *           field. Nulled in the same statement that flips the status, so
   *           there is no window and no second job that has to run.
   *   kept  · the fingerprint, so an appeal can still be told whether the
   *           account a seller now names is the one the buyer was shown;
   *           the header (method, country, currency, label, timestamps), which
   *           is what the access log needs in order to still mean something;
   *           the row itself, for the two references above.
   *
   * This used to set the status alone. Nothing else nulled it either — the
   * retention sweep only touches `trade_payment_instruments` — so a removed
   * instrument kept its details forever, in a state where `revealOwn` (which
   * filters `status = 'active'`) would not let the owner so much as look at
   * what was still being held. Retained and unreadable is the worst of both:
   * no delete, and no export.
   *
   * A trade already in flight is unaffected: its own frozen snapshot is a
   * separate copy, deliberately, so the buyer halfway through a bank transfer
   * still has somewhere to send the money. `purgeExpiredSnapshots` clears that
   * copy once the trade has been closed for the retention window.
   */
  async removeInstrument(input: { instrumentId: string; ownerId: string }, db: Sql = this.sql): Promise<InstrumentHeader> {
    const rows = await db<InstrumentRow[]>`
      UPDATE p2p.payment_instruments
         SET status = 'removed', details = NULL, removed_at = now(), updated_at = now()
       WHERE id = ${input.instrumentId} AND owner_id = ${input.ownerId} AND status = 'active'
      RETURNING *
    `;
    if (!rows[0]) throw notFound(input.instrumentId);
    return toHeader(rows[0]);
  }

  /**
   * The owner's own list. **Headers only — no field values, ever.**
   *
   * There is no "masked last four" here on purpose. A mask is still the data,
   * it is served on a path that is not access-logged, and it is one refactor
   * away from being the whole value. The owner tells two destinations apart by
   * the label they chose; seeing the numbers is `reveal`, and `reveal` is
   * logged like every other read.
   */
  async listInstruments(ownerId: string, includeRemoved = false, limit?: number): Promise<InstrumentHeader[]> {
    const lim = assertInstrumentListLimit(limit);
    const rows = await this.sql<InstrumentRow[]>`
      SELECT * FROM p2p.payment_instruments
       WHERE owner_id = ${ownerId}
         AND (${includeRemoved}::boolean OR status = 'active')
       ORDER BY created_at DESC
       LIMIT ${lim}
    `;
    return rows.map(toHeader);
  }

  /**
   * Why a method is retired, when no market accepts it any more and the latest retirement named a reason; otherwise
   * `null` (still accepted somewhere, never registered, or switched off before reasons were kept). Catalogue facts
   * only: nothing here is about anyone's account.
   */
  async retiredMethod(methodId: string): Promise<{ reason: DelistReason; delistedAt: Date } | null> {
    const rows = await this.sql<Array<{ enabled: boolean; delist_reason: DelistReason | null; delisted_at: Date | null }>>`
      SELECT enabled, delist_reason, delisted_at FROM p2p.payment_method_schemas WHERE method_id = ${methodIdKey(methodId)}
       ORDER BY delisted_at DESC NULLS LAST
    `;
    if (rows.length === 0 || rows.some((row) => row.enabled)) return null;
    const latest = rows[0];
    return latest?.delist_reason && latest.delisted_at ? { reason: latest.delist_reason, delistedAt: latest.delisted_at } : null;
  }

  /**
   * Method ids an operator has actually registered and left enabled.
   *
   * The registry ships empty. An empty set is not "any rail" — it is no rail.
   * Offer create and the public board consult this so a missing schema cannot
   * look like a destination the seller merely forgot to fill in.
   */
  async enabledMethodKeys(): Promise<ReadonlySet<string>> {
    const rows = await this.sql<Array<{ method_id: string }>>`
      SELECT DISTINCT method_id FROM p2p.payment_method_schemas WHERE enabled = true
    `;
    return new Set(rows.map((r) => methodIdKey(r.method_id)));
  }

  /**
   * Active method ids for one owner in one fiat — the board's "can they be paid?"
   * answer without disclosing destinations.
   *
   * Method ids are already stored lowercased; returned keys match `methodIdKey`.
   * A destination whose method has no enabled schema is not payable: the
   * operator registry is the rail, not a leftover instrument row.
   *
   * `db` reads inside the caller's transaction; `exceptInstrumentId` answers as if that one destination were already
   * gone (P-ads-merchant-18: which ads a removal would take off the board).
   */
  async liveMethodKeys(
    ownerId: string,
    fiatCurrency: string,
    opts: { db?: Sql; exceptInstrumentId?: string } = {},
  ): Promise<ReadonlySet<string>> {
    const fiat = fiatCurrency.trim().toUpperCase();
    const db = opts.db ?? this.sql;
    const except = opts.exceptInstrumentId;
    const rows = await db<Array<{ method_id: string }>>`
      SELECT DISTINCT i.method_id
        FROM p2p.payment_instruments i
        JOIN p2p.payment_method_schemas s
          ON s.method_id = i.method_id
         AND s.enabled = true
         AND (s.country = i.country OR s.country = ${ANY_COUNTRY})
       WHERE i.owner_id = ${ownerId}
         AND i.fiat_currency = ${fiat}
         AND i.status = 'active'
         ${except === undefined ? db`` : db`AND i.id <> ${except}`}
    `;
    return new Set(rows.map((r) => methodIdKey(r.method_id)));
  }

  /**
   * P-disputes-security-09: what the board says about each method before anyone takes. A method is non-instant when any
   * market's enabled row says so; its window is the longest of those (null when any of them is blank). The order itself
   * carries the exact profile of the market it pays into. The ad's consent check reads this too, so its answer never
   * depends on where the seller is paid.
   */
  async boardSettlements(methodIds: readonly string[], db: Sql = this.sql): Promise<ReadonlyMap<string, MethodSettlement>> {
    const keys = [...new Set(methodIds.map((id) => methodIdKey(id)))];
    const out = new Map<string, MethodSettlement>();
    if (keys.length === 0) return out;
    const rows = await db<Array<{ method_id: string; any_blank: boolean; longest: number | null }>>`
      SELECT method_id, bool_or(settlement_window_seconds IS NULL) AS any_blank, max(settlement_window_seconds) AS longest
        FROM p2p.payment_method_schemas
       WHERE enabled = true AND NOT instant AND method_id = ANY(${keys})
       GROUP BY method_id
    `;
    for (const row of rows) {
      out.set(methodIdKey(row.method_id), { instant: false, windowSeconds: row.any_blank ? null : Number(row.longest) });
    }
    return out;
  }

  /**
   * The owner reads their own details. Logged like everyone else's read.
   *
   * The owner is not exempt, because an account takeover reads exactly like an
   * owner: it holds the session. A log with a hole shaped like "the owner" is a
   * log that says nothing about the one attack it most needs to describe.
   */
  async revealOwn(input: { instrumentId: string; viewerId: string }): Promise<RevealedInstrument> {
    return withSpan('p2p.instrument.revealOwn', async () => {
      const rows = await this.sql<Array<InstrumentRow & { logged_at: Date }>>`
        WITH src AS (
          SELECT * FROM p2p.payment_instruments
           WHERE id = ${input.instrumentId} AND owner_id = ${input.viewerId} AND status = 'active'
        ),
        logged AS (
          INSERT INTO p2p.instrument_access_log (instrument_id, owner_id, viewer_id, viewer_role, trade_id, outcome)
          SELECT src.id, src.owner_id, ${input.viewerId}, 'owner', NULL, 'revealed' FROM src
          RETURNING id, at
        )
        SELECT src.*, logged.at AS logged_at FROM src, logged
      `;

      const row = rows[0];
      if (!row) {
        await this.logDenied({ viewerId: input.viewerId, viewerRole: 'other', reason: 'not_the_owner' });
        throw notFound(input.instrumentId);
      }
      return { ...toHeader(row), details: this.detailsFromStore(row.id, row.owner_id, row.details), loggedAt: row.logged_at };
    });
  }

  /**
   * The owner's own details, masked (J-p2p-04 #3): the account holder whole, since it is the person's own verified name,
   * and every other value as its last four characters at most (`maskedValue`). Logged as a reveal in the same statement
   * as any read, because a mask is still the data. The full values never leave the service on this path: a person who
   * only wants to tell their methods apart never puts a whole account number in their browser.
   */
  async revealOwnMasked(input: { instrumentId: string; viewerId: string }): Promise<RevealedInstrument> {
    const revealed = await this.revealOwn(input);
    const schema = await this.lookupSchema(revealed.methodId, revealed.country);
    const holders = new Set((schema?.fields ?? []).filter((field) => field.holderName === true).map((field) => field.key));
    const details: Record<string, string> = {};
    for (const [key, value] of Object.entries(revealed.details)) details[key] = holders.has(key) ? value : maskedValue(value);
    return { ...revealed, details };
  }

  /** "Who has looked at my account details, and when." Owner-scoped. */
  async accessLogFor(ownerId: string, limit?: number): Promise<AccessLogEntry[]> {
    const lim = assertAccessLogLimit(limit);
    const rows = await this.sql<
      Array<{
        id: string;
        instrument_id: string | null;
        owner_id: string | null;
        viewer_id: string;
        viewer_role: ViewerRole;
        trade_id: string | null;
        outcome: 'revealed' | 'denied';
        deny_reason: string | null;
        at: Date;
      }>
    >`
      SELECT * FROM p2p.instrument_access_log
       WHERE owner_id = ${ownerId}
       ORDER BY at DESC
       LIMIT ${lim}
    `;
    return rows.map((r) => ({
      id: r.id,
      instrumentId: r.instrument_id,
      ownerId: r.owner_id,
      viewerId: r.viewer_id,
      viewerRole: r.viewer_role,
      tradeId: r.trade_id,
      outcome: r.outcome,
      denyReason: r.deny_reason,
      at: r.at,
    }));
  }

  // ── Attaching a destination to a trade ─────────────────────────────────────

  /**
   * Freeze the seller's destination onto a trade, inside the caller's
   * transaction.
   *
   * Called from `reserveTrade` — BEFORE any lock, alongside every other reason
   * a take can be refused. A seller who cannot be paid should not have their
   * asset escrowed against a payment the buyer has nowhere to send: that trade
   * can only end in a timeout or a dispute, and both of those cost the seller
   * fifteen minutes of locked balance to discover something knowable up front.
   *
   * Same transaction as the trade row, so a trade with no destination is not a
   * state that can be committed.
   *
   * THE METHOD ID IS KEYED, NOT COMPARED RAW. Every write path stores the id
   * through `normaliseMethodId`, so what is in this column is always lowercase.
   * The id arriving here is not: it is the taker's copy of a string the MAKER
   * typed into their offer's `methods`, which is stored verbatim. A maker who
   * declared `"Bank_Transfer"` therefore produced takes carrying
   * `Bank_Transfer`, which matched no row — and the seller was told they had no
   * destination for a method they were holding one for, on every single take of
   * that offer. Comparing raw here was the difference between an offer that
   * works and an offer that cannot be taken by anyone, decided by a capital
   * letter nobody was ever told mattered.
   */
  /**
   * RUN A TAKE, AND WRITE DOWN ANY REFUSAL IT PRODUCED — AFTERWARDS.
   *
   * The flush point, and the only way to get a `DenialSink`. `refuseTake` needs
   * one and the compiler will not let you call it without one, so a refusal
   * cannot be raised outside a scope that ends by flushing it. That is the
   * property worth having: #805's guarantee ("a refused take is logged") is not
   * re-established by remembering to log at each throw site, it is
   * re-established by there being nowhere to throw from that is not wrapped.
   *
   * The `finally` runs after `run` has settled. When `run` is a
   * `transaction(…)`, settling means postgres.js has already issued the
   * ROLLBACK and returned the connection to the pool — so the INSERT below asks
   * for a connection the caller is no longer holding. That ordering is the
   * whole fix; see `DenialSink`.
   *
   * The row lands after the abort rather than before it, which moves the
   * crash window rather than closing it: a process that dies between the
   * rollback and the INSERT loses the row. It is the same best-effort contract
   * `logDenied` already documents, the window is microseconds of local work
   * with no I/O ordering in it, and the alternative on offer was a service that
   * stops answering after ten requests.
   */
  async duringTake<T>(run: (sink: DenialSink) => Promise<T>): Promise<T> {
    const sink: DenialSink = { pending: [] };
    try {
      return await run(sink);
    } finally {
      // Sequential, not `Promise.all`: N denials must not become N simultaneous
      // demands on the pool — that is a smaller copy of the bug being fixed.
      for (const denial of sink.pending) await this.logDenied(denial);
    }
  }

  async attachToTrade(
    tx: Sql,
    input: { tradeId: string; sellerId: string; takerId: string; methodId: string; fiatCurrency: string; sink: DenialSink },
  ): Promise<{ instrumentId: string; fingerprint: string; settlement: MethodSettlement }> {
    const methodId = methodIdKey(input.methodId);
    // Same payable rule as `liveMethodKeys`: an active row is not a rail once
    // the operator has emptied or disabled the schema. EXISTS, not JOIN, so a
    // country row plus a `*` wildcard cannot duplicate the instrument and pick
    // by an ordering nobody designed. A leftover destination still refuses
    // through `refuseTake` — same sentence as "no destination" — so the take
    // path cannot become an oracle for "schema gone vs dest gone".
    const rows = await tx<InstrumentRow[]>`
      SELECT * FROM p2p.payment_instruments i
       WHERE i.owner_id = ${input.sellerId}
         AND i.method_id = ${methodId}
         AND i.fiat_currency = ${input.fiatCurrency}
         AND i.status = 'active'
         AND EXISTS (
           SELECT 1 FROM p2p.payment_method_schemas s
            WHERE s.method_id = i.method_id
              AND s.enabled = true
              AND (s.country = i.country OR s.country = ${ANY_COUNTRY})
         )
    `;

    const instrument = rows[0];
    if (!instrument) {
      // THE ORACLE, CLOSED. This used to echo the method id and the currency
      // back — a self-describing answer to a question about someone else's
      // bank accounts — and it wrote nothing down. Now it says the same
      // sentence every other method-refused take says, and it is logged.
      //
      // `refuseTake` writes on NEITHER `tx` NOR `this.sql`. Not `tx`, because
      // the throw aborts the caller's reserve transaction and a log row written
      // inside it would roll back with everything else — rolling back cleanly
      // is exactly what made the probe free. Not `this.sql` either, because
      // that asks the pool for a second connection while this transaction is
      // still holding the first; ten of those and the service is gone. The row
      // goes on the sink and `duringTake` writes it once the transaction has
      // let go. See `DenialSink`.
      await this.refuseTake({ takerId: input.takerId, sellerId: input.sellerId, tradeId: input.tradeId, sink: input.sink });
      // `refuseTake` is typed `Promise<never>`; this is unreachable and exists
      // only so the narrowing below is a fact rather than an assertion.
      throw takeRefused();
    }

    await tx`
      INSERT INTO p2p.trade_payment_instruments (
        trade_id, instrument_id, owner_id, method_id, country, fiat_currency, label, details, fingerprint
      )
      VALUES (
        ${input.tradeId}, ${instrument.id}, ${instrument.owner_id}, ${instrument.method_id}, ${instrument.country},
        ${instrument.fiat_currency}, ${instrument.label}, ${tx.json(instrument.details as never)}, ${instrument.fingerprint}
      )
      ON CONFLICT (trade_id) DO NOTHING
    `;

    // The profile of the market the buyer pays into: exact country beating the wildcard, as every schema read does.
    const [profile] = await tx<Array<{ instant: boolean; settlement_window_seconds: number | null }>>`
      SELECT instant, settlement_window_seconds FROM p2p.payment_method_schemas
       WHERE method_id = ${instrument.method_id} AND enabled = true AND country IN (${instrument.country}, ${ANY_COUNTRY})
       ORDER BY (country = ${ANY_COUNTRY}) ASC
       LIMIT 1
    `;
    return {
      instrumentId: instrument.id,
      fingerprint: instrument.fingerprint,
      settlement: profile ? settlementOf(profile) : { instant: true },
    };
  }

  /**
   * REFUSE A TAKE, IDENTICALLY, AND WRITE IT DOWN. Never returns.
   *
   * Every reason a take could not name a destination comes through here — the
   * offer not accepting the method, and the seller not holding an instrument
   * for it — so the caller cannot tell them apart from the response, and
   * neither can anyone reading a transcript of a thousand of them.
   *
   * `deny_reason` is the SAME string for both, deliberately. The access log is
   * the owner's, and the owner already knows which of their own instruments
   * exist; what a uniform reason buys is that nothing downstream — a support
   * view, an export, a future admin screen — can reconstruct the distinction
   * this method exists to erase.
   *
   * It does NOT write. Both call sites are inside `reserveTrade`'s transaction,
   * which is holding a pool connection; a write from here — on `tx` or on
   * `this.sql` — is either rolled back with the abort or deadlocked against the
   * connection this very call stack owns. It queues the row on the sink and
   * `duringTake` writes it the moment the transaction has ended. The sink
   * parameter is required so that a refusal cannot be raised anywhere the flush
   * does not reach. See `DenialSink`.
   */
  async refuseTake(input: { takerId: string; sellerId: string; tradeId?: string; sink: DenialSink }): Promise<never> {
    input.sink.pending.push({
      ownerId: input.sellerId,
      viewerId: input.takerId,
      viewerRole: 'other',
      // No trade id: the take rolled back, so there is no trade to point at.
      // Recording the id it WOULD have had would put a row in the owner's log
      // referring to something that does not exist.
      tradeId: null,
      reason: 'take_refused',
    });
    throw takeRefused();
  }

  /**
   * THE DISCLOSURE. One statement, and it writes the log as it reads.
   *
   * `WITH src AS (SELECT … WHERE the escrow is held), logged AS (INSERT …
   * SELECT FROM src RETURNING …) SELECT src.*, logged.at FROM src, logged`
   *
   * The cross join is the point: `src` alone would return the details whether
   * or not the INSERT produced anything, so the join is what makes an unlogged
   * disclosure not merely discouraged but unrepresentable. And the status test
   * lives inside `src` rather than in a check above, so a trade that terminated
   * between the authorisation read and this statement discloses nothing.
   *
   * Everything this refuses is refused as NOT_FOUND. "This trade exists but you
   * may not see its payment details" tells a stranger that a trade with that id
   * exists and has a seller with a bank account; there is no version of that
   * sentence a legitimate caller needs.
   */
  async revealForTrade(input: { tradeId: string; viewerId: string; isModerator?: boolean }): Promise<TradeInstrumentView> {
    return withSpan('p2p.instrument.revealForTrade', async () => {
      // 1 · Authorisation, from the trade and the snapshot HEADER. This read
      //     deliberately does not select `details`.
      const context = await this.sql<
        Array<{
          trade_id: string;
          instrument_id: string;
          owner_id: string;
          status: string;
          seller_id: string;
          buyer_id: string;
          purged_at: Date | null;
          dispute_status: string | null;
          original_terms_claimed_at: Date | null;
          method_id: string;
          country: string;
        }>
      >`
        SELECT tpi.trade_id, tpi.instrument_id, tpi.owner_id, tpi.purged_at, tpi.method_id, tpi.country,
               t.status, t.seller_id, t.buyer_id, t.original_terms_claimed_at, d.status AS dispute_status
          FROM p2p.trade_payment_instruments tpi
          JOIN p2p.p2p_trades t ON t.id = tpi.trade_id
          LEFT JOIN p2p.p2p_disputes d ON d.trade_id = tpi.trade_id
         WHERE tpi.trade_id = ${input.tradeId}
      `;

      const ctx = context[0];
      if (!ctx) {
        // No trade, or no destination on it. Nothing to attribute a denial to
        // beyond the attempt itself.
        await this.logDenied({
          viewerId: input.viewerId,
          viewerRole: 'other',
          tradeId: null,
          reason: 'no_instrument_on_trade',
        });
        throw notFound(input.tradeId);
      }

      const decision = decideRole(ctx, input.viewerId, input.isModerator === true);

      if (decision.role === null) {
        await this.logDenied({
          instrumentId: ctx.instrument_id,
          ownerId: ctx.owner_id,
          viewerId: input.viewerId,
          viewerRole: 'other',
          tradeId: ctx.trade_id,
          reason: decision.reason,
        });
        throw notFound(input.tradeId);
      }

      if (ctx.original_terms_claimed_at === null) {
        await this.logDenied({
          instrumentId: ctx.instrument_id,
          ownerId: ctx.owner_id,
          viewerId: input.viewerId,
          viewerRole: decision.role,
          tradeId: ctx.trade_id,
          reason: 'original_terms_unproven',
        });
        throw new P2pError(
          'Original escrow terms are unproven; the legacy pay-to snapshot is preserved without disclosure',
          'p2p.escrow_terms_unproven',
        );
      }

      // Display labels, read before the disclosure so that nothing can fail after it is logged. Labels only: whatever
      // goes wrong here (a malformed stored schema, no schema at all) the buyer still gets the details under their keys.
      let labels: ReadonlyArray<{ readonly key: string; readonly label: string }> = [];
      try {
        labels = (await this.lookupSchema(ctx.method_id, ctx.country))?.fields.map((f) => ({ key: f.key, label: f.label })) ?? [];
      } catch (err) {
        recordSwallowed('p2p.instrument.reveal_labels', err);
      }

      // 2 · The disclosure. Read and log, or neither.
      const rows = await this.sql<
        Array<{
          trade_id: string;
          instrument_id: string;
          owner_id: string;
          method_id: string;
          country: string;
          fiat_currency: string;
          label: string;
          details: Record<string, string>;
          fingerprint: string;
          attached_at: Date;
          logged_at: Date;
          current_fingerprint: string | null;
          current_status: string | null;
        }>
      >`
        WITH src AS (
          SELECT tpi.trade_id, tpi.instrument_id, tpi.owner_id, tpi.method_id, tpi.country,
                 tpi.fiat_currency, tpi.label, tpi.details, tpi.fingerprint, tpi.attached_at,
                 pi.fingerprint AS current_fingerprint, pi.status AS current_status
            FROM p2p.trade_payment_instruments tpi
            JOIN p2p.p2p_trades t ON t.id = tpi.trade_id
            LEFT JOIN p2p.payment_instruments pi ON pi.id = tpi.instrument_id
           WHERE tpi.trade_id = ${input.tradeId}
             AND tpi.details IS NOT NULL
             AND t.status IN ('escrowed', 'fiat_sent', 'disputed')
             AND t.original_terms_claimed_at IS NOT NULL
        ),
        logged AS (
          INSERT INTO p2p.instrument_access_log (instrument_id, owner_id, viewer_id, viewer_role, trade_id, outcome)
          SELECT src.instrument_id, src.owner_id, ${input.viewerId}, ${decision.role}, src.trade_id, 'revealed' FROM src
          RETURNING id, at
        )
        SELECT src.*, logged.at AS logged_at FROM src, logged
      `;

      const row = rows[0];
      if (!row) {
        // The trade terminated (or was purged) between the two statements.
        await this.logDenied({
          instrumentId: ctx.instrument_id,
          ownerId: ctx.owner_id,
          viewerId: input.viewerId,
          viewerRole: decision.role,
          tradeId: ctx.trade_id,
          reason: 'escrow_not_held',
        });
        throw notFound(input.tradeId);
      }

      const details = this.detailsFromStore(row.instrument_id, row.owner_id, row.details);
      return {
        tradeId: row.trade_id,
        instrumentId: row.instrument_id,
        ownerId: row.owner_id,
        methodId: row.method_id,
        country: row.country,
        fiatCurrency: row.fiat_currency,
        label: row.label,
        details,
        fields: labelledFields(labels, Object.keys(details)),
        fingerprint: row.fingerprint,
        attachedAt: row.attached_at,
        loggedAt: row.logged_at,
        payeeChange: payeeChangeOf(row),
      };
    });
  }

  // ── Retention ──────────────────────────────────────────────────────────────

  /**
   * Wipe the account details off closed trades past the retention window.
   *
   * The API already refuses to disclose a terminal trade's snapshot, so this is
   * not an access control — it is the other half of the same promise. "You
   * cannot read it" and "we no longer have it" are different statements, and
   * only the second one survives a database being copied.
   *
   * The fingerprint stays, so an appeal can still be told whether the account a
   * seller now names is the one the buyer was shown, without us holding the
   * account to say so.
   */
  async purgeExpiredSnapshots(limit?: number): Promise<{ purged: number }> {
    const lim = assertPurgeExpiredSnapshotsLimit(limit);
    if (this.retentionDays == null) {
      throw new InstrumentError(
        'P2P_INSTRUMENT_RETENTION_DAYS is unset — refusing rather than inventing 90d',
        'p2p.instrument_retention_unset',
      );
    }
    const rows = await this.sql<Array<{ trade_id: string }>>`
      UPDATE p2p.trade_payment_instruments
         SET details = NULL, purged_at = now()
       WHERE trade_id IN (
         SELECT tp.trade_id
           FROM p2p.trade_payment_instruments tp
           JOIN p2p.p2p_trades t ON t.id = tp.trade_id
          WHERE tp.purged_at IS NULL
            AND t.resolution IS NOT NULL
            AND t.resolved_at < now() - ${`${this.retentionDays} days`}::interval
          ORDER BY tp.attached_at ASC
          LIMIT ${lim}
       )
      RETURNING trade_id
    `;
    return { purged: rows.length };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Zero enabled schemas is not an empty picker — it is no payable rail.
   * Same code as an unknown method, so a catalog screen cannot tell "none yet"
   * apart from "this string is not a rail" and paper over the gap with UX.
   */
  private async refuseIfRegistryEmpty(): Promise<void> {
    const enabled = await this.enabledMethodKeys();
    if (enabled.size === 0) throw emptyRegistry();
  }

  private async ownedInstrument(instrumentId: string, ownerId: string): Promise<InstrumentRow> {
    const rows = await this.sql<InstrumentRow[]>`
      SELECT * FROM p2p.payment_instruments WHERE id = ${instrumentId} AND owner_id = ${ownerId} AND status = 'active'
    `;
    if (!rows[0]) throw notFound(instrumentId);
    return rows[0];
  }

  /**
   * A refused attempt is a log line too.
   *
   * Written on its own rather than inside the reveal statement, because there
   * is nothing to read and therefore nothing to join to. It is best-effort by
   * design: a failure to record a refusal must not turn a refusal into an
   * error the caller can distinguish from "no such trade".
   *
   * Best-effort is not the same as unobservable, and here the difference
   * matters more than the swallow does. This is the half of the log that shows
   * harvesting; if it silently stopped writing, the first anyone would know is
   * an empty table during the incident it exists to describe. So the failure
   * goes on the span — nothing reaches the caller, and the control's own
   * failure is still something an operator can alert on.
   */
  private async logDenied(input: PendingDenial): Promise<void> {
    try {
      await this.sql`
        INSERT INTO p2p.instrument_access_log (instrument_id, owner_id, viewer_id, viewer_role, trade_id, outcome, deny_reason)
        VALUES (
          ${input.instrumentId ?? null}, ${input.ownerId ?? null}, ${input.viewerId}, ${input.viewerRole},
          ${input.tradeId ?? null}, 'denied', ${input.reason}
        )
      `;
    } catch (err) {
      // Swallowed on purpose, recorded on purpose — see the doc comment.
      recordSwallowed('p2p.instrument.log_denied', err);
    }
  }
}

// ── Authorisation, as a pure decision ────────────────────────────────────────

/**
 * WHO MAY SEE A TRADE'S PAYMENT DESTINATION.
 *
 *   the seller  — it is their own account, on their own trade
 *   the buyer   — they are the one who has to pay it
 *   a moderator — ONLY while a dispute on this trade is open
 *   everyone else — no, and the refusal is `NOT_FOUND`
 *
 * The moderator case is the one judgement call in this file, and it is made
 * deliberately. §A2 requires a human to resolve a disputed release and requires
 * both sides to see the same evidence set; a human asked to rule on "I paid" /
 * "nothing arrived" without being able to see the account the payment was
 * supposed to reach is being asked to guess. It is bounded to an OPEN dispute
 * on this specific trade, it is logged with `viewer_role = 'moderator'`, and it
 * is visible to the owner in their own access log. Compliance access that
 * nobody can see afterwards would be the thing to object to.
 */
function decideRole(
  ctx: { status: string; seller_id: string; buyer_id: string; dispute_status: string | null; purged_at: Date | null },
  viewerId: string,
  isModerator: boolean,
): { role: ViewerRole; reason?: undefined } | { role: null; reason: string } {
  const live = (DISCLOSABLE_STATUSES as readonly string[]).includes(ctx.status);

  if (ctx.seller_id === viewerId) {
    return live ? { role: 'owner' } : { role: null, reason: 'escrow_not_held' };
  }
  if (ctx.buyer_id === viewerId) {
    return live ? { role: 'counterparty' } : { role: null, reason: 'escrow_not_held' };
  }
  if (isModerator) {
    if (ctx.status === 'disputed' && ctx.dispute_status === 'open') return { role: 'moderator' };
    return { role: null, reason: 'moderator_without_open_dispute' };
  }
  return { role: null, reason: 'not_a_party' };
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Labels for a snapshot's keys, from the method's schema whether or not the method is still accepted: a buyer paying an
 * order placed before a retirement still needs to know which value is the account holder. Schema order first, then any
 * key the schema does not name, under its own key.
 */
function labelledFields(
  labels: ReadonlyArray<{ readonly key: string; readonly label: string }>,
  keys: readonly string[],
): ReadonlyArray<{ readonly key: string; readonly label: string }> {
  const present = new Set(keys);
  const named = labels.filter((field) => present.has(field.key));
  const known = new Set(named.map((field) => field.key));
  return [...named, ...keys.filter((key) => !known.has(key)).map((key) => ({ key, label: key }))];
}

/**
 * Whether the seller's saved destination still matches the order's snapshot: the fingerprint decides, never the label.
 * No time is given: the row's `updated_at` also moves on a rename, so it does not say when the payee changed.
 */
function payeeChangeOf(row: {
  fingerprint: string;
  current_fingerprint: string | null;
  current_status: string | null;
}): TradeInstrumentView['payeeChange'] {
  if (row.current_status === 'removed') return { kind: 'removed' };
  if (row.current_fingerprint !== null && row.current_fingerprint !== row.fingerprint) return { kind: 'changed' };
  return null;
}

function toHeader(row: InstrumentRow): InstrumentHeader {
  return {
    id: row.id,
    ownerId: row.owner_id,
    methodId: row.method_id,
    country: row.country,
    fiatCurrency: row.fiat_currency,
    label: row.label,
    fingerprint: row.fingerprint,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

/**
 * A STORED ROW IS NOT A TRUSTED ROW.
 *
 * This used to `as FieldSpec[]` whatever was in the column. That made every
 * rule in `instruments.ts` — the length cap, the field cap, the key shape, and
 * above all the check that a pattern is one this engine can run in linear time
 * — a property of ONE code path (`registerMethodSchema`) rather than a property
 * of the data. Anything that reached the column another way inherited none of
 * them: a migration, a fix-up script, a psql session, a future writer in this
 * same service. The row would then be cast straight into the validator and its
 * pattern handed to the matcher.
 *
 * "Only `admin:compliance` can get here" is not the control. It is an argument
 * about who is holding the door, and it stops being true the first time a scope
 * widens or a data-fix writes the row directly.
 *
 * So the parse runs again, on the way out of the database. `parseFieldSpecs` is
 * idempotent over anything this service wrote — it trims, lower-cases and
 * bounds, and re-running it on its own output changes nothing — so this costs a
 * re-parse and buys the guarantee that a `MethodSchema` in memory has been
 * through the same gate however it arrived.
 *
 * It FAILS CLOSED, and deliberately loudly: a schema we cannot re-validate is a
 * schema we cannot honour, and a listing that silently omitted the bad row would
 * hide the exact thing an operator needs to see. The refusal names the method
 * and country so the offending row can be found.
 *
 * The database enforces the structural half of the same rules — see
 * `payment_method_fields_are_well_formed` in
 * `drizzle/0001_p2p_payment_instruments.sql`. The two are not redundant: SQL can
 * check the shape of a field list at write time no matter who is writing, and
 * cannot decide whether a regular expression is safe to run without running this
 * service's matcher. Neither half covers the other.
 */
function toSchema(row: SchemaRow): MethodSchema {
  let fields: FieldSpec[];
  try {
    fields = parseFieldSpecs(row.fields);
  } catch (err) {
    const why = err instanceof InstrumentError ? err.message : String(err);
    throw new InstrumentError(
      `The stored field list for "${row.method_id}" in ${row.country} is not one this service can accept: ${why}`,
      'p2p.instrument_schema_invalid',
    );
  }

  return {
    methodId: row.method_id,
    country: row.country,
    label: row.label,
    fields,
    enabled: row.enabled,
    settlement: settlementOf(row),
  };
}

/** A row's settlement profile. Rows written before the profile existed read as instant (the column default). */
function settlementOf(row: { instant: boolean; settlement_window_seconds: number | null }): MethodSettlement {
  return row.instant ? { instant: true } : { instant: false, windowSeconds: row.settlement_window_seconds ?? null };
}

/** An operator's settlement profile, checked before it is stored: an instant method has no window. */
function parseSettlement(input: MethodSettlement): MethodSettlement {
  if (input.instant) return { instant: true };
  const window = input.windowSeconds;
  if (window !== null && (!Number.isInteger(window) || window < SETTLEMENT_WINDOW_MIN_SECONDS || window > SETTLEMENT_WINDOW_MAX_SECONDS)) {
    throw new InstrumentError(
      `A settlement window is a whole number of seconds from ${SETTLEMENT_WINDOW_MIN_SECONDS} to ${SETTLEMENT_WINDOW_MAX_SECONDS}`,
      'p2p.instrument_schema_invalid',
    );
  }
  return { instant: false, windowSeconds: window };
}

/**
 * One refusal for every "you may not see this".
 *
 * NOT_FOUND rather than FORBIDDEN, everywhere, and the message never varies by
 * cause: the difference between "no such instrument" and "not yours" is itself
 * information about someone else's account.
 */
function emptyRegistry(): InstrumentError {
  return new InstrumentError(resolveP2pCopy(P2P_COPY.methodUnknown), 'p2p.instrument_method_unknown');
}

function notFound(id: string): InstrumentError {
  return new InstrumentError(`No payment instrument is available for ${id}`, 'p2p.instrument_not_found');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export { InstrumentError };
export type { InstrumentDetails, MethodSchema, FieldSpec };

/**
 * A saved value as the owner's masked view shows it: `•••• ` and its last four characters, with spaces dropped. A value
 * of six characters or fewer shows none of itself, so the mask never gives most of a short value away.
 */
export function maskedValue(value: string): string {
  const compact = value.replace(/\s+/g, '');
  return compact.length > 6 ? `•••• ${compact.slice(-4)}` : '••••';
}
