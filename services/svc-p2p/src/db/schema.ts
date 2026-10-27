import { bigint, boolean, index, integer, jsonb, numeric, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { amount, bps, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * PEER-TO-PEER TRADING (§6.2).
 *
 * Doctrine §0.6, and here it is load-bearing: **this service holds no balances**.
 * Escrowed value lives in the ledger's `escrow` account kind, put there by
 * `escrowLock` and taken out by exactly one of `escrowRelease` / `escrowRefund`.
 * These tables hold the *terms* and the *decisions* — never the money.
 *
 * Which means the interesting column in this file is `p2p_trades.resolution`.
 * It is the recorded decision, written and committed BEFORE the ledger post
 * that acts on it. One row, one resolution, immutable once set: that is what
 * makes "released to both parties" impossible rather than merely unlikely.
 *
 * 100+ fiat currencies are `packages/config/src/fiat.ts`, not a table here
 * (§6.2: "config, not code"). `fiat_currency` is a plain ISO-4217 code
 * validated against that registry at the edge.
 */
export const p2p = pgSchema('p2p');

/** Which way the MAKER trades. A `sell` offer escrows the maker's asset; a `buy` offer escrows the taker's. */
export const offerSideEnum = p2p.enum('offer_side', ['buy', 'sell']);

/** §6.2 `price_type enum[fixed,float]`. */
export const priceTypeEnum = p2p.enum('price_type', ['fixed', 'float']);

/**
 * `paused` is a distinct state, not a flag: a paused offer is invisible to
 * takers but its open trades continue, and a closed offer can never re-open.
 */
export const offerStatusEnum = p2p.enum('offer_status', ['active', 'paused', 'closed']);

/** §6.2, exactly: `created,escrowed,fiat_sent,released,cancelled,disputed`. */
export const tradeStatusEnum = p2p.enum('trade_status', ['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']);

/**
 * WHERE THE LOCKED VALUE WENT. Non-null exactly on a terminal trade.
 *
 *   released — escrow went to the buyer (minus fee)
 *   refunded — escrow went back to the seller, in full
 *   voided   — nothing was ever locked, so nothing had to move
 *
 * `voided` exists because a trade can die between "reserved" and "escrowed",
 * and a terminal trade with a NULL resolution would be a row nobody can explain.
 */
export const tradeResolutionEnum = p2p.enum('trade_resolution', ['released', 'refunded', 'voided']);

export const disputeStatusEnum = p2p.enum('dispute_status', ['open', 'resolved']);

/** A moderator has exactly two options. There is deliberately no third. */
export const disputeResolutionEnum = p2p.enum('dispute_resolution', ['release', 'refund']);

/**
 * §6.2 `offers`.
 *
 * `total_amt` / `remaining_amt` are not in §6.2's sketch and are added
 * deliberately. Without inventory an offer is infinitely takeable, and the only
 * thing stopping the tenth concurrent taker is the seller's available balance
 * running out mid-`escrowLock` — i.e. nine takers discovering the failure one
 * at a time, after committing to a price. Reserving inventory under a row lock
 * moves that rejection to before any value moves (§5: every failure branch).
 */
export const offers = p2p.table(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    makerId: text('maker_id').notNull(),
    side: offerSideEnum('side').notNull(),
    /** Ledger asset id, e.g. 'USDT'. The crypto leg. */
    asset: text('asset').notNull(),
    /** ISO-4217, validated against `packages/config` FIAT_CURRENCIES. */
    fiatCurrency: text('fiat_currency').notNull(),
    priceType: priceTypeEnum('price_type').notNull(),
    /**
     * `fixed` — fiat per one unit of asset.
     * `float` — a multiplier on the reference price supplied at take time
     *           (1.02 = 2% over). This service never *sources* a price; §4.3's
     *           rule that svc-token never decides a price applies here too.
     */
    price: amount('price').notNull(),
    /** Per-trade bounds. A take outside them is rejected before any lock. */
    minAmt: amount('min_amt').notNull(),
    maxAmt: amount('max_amt').notNull(),
    /** Offer inventory. `remaining_amt` is reserved under a row lock on take. */
    totalAmt: amount('total_amt').notNull(),
    remainingAmt: amount('remaining_amt').notNull(),
    /** Payment methods the maker accepts, e.g. `[{"id":"sepa","label":"SEPA"}]`. */
    methods: jsonb('methods').notNull().default([]),
    /** The seller's consent at post to non-instant methods (P-disputes-security-09). */
    acceptsNonInstant: boolean('accepts_non_instant').notNull().default(false),
    terms: text('terms').notNull().default(''),
    /**
     * Verification tier of the maker at create. Null on older rows: a published
     * buy cap refuses that fill rather than treating the maker as uncapped.
     */
    makerTier: text('maker_tier'),
    status: offerStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The board query: live offers for a pair, best price first. */
    index('offers_book_idx').on(t.asset, t.fiatCurrency, t.side, t.status),
    index('offers_maker_idx').on(t.makerId, t.status),
  ],
);

/**
 * §6.2 `p2p_trades` — one taken offer, and the escrow it owns.
 *
 * `seller_id` / `buyer_id` are stored rather than derived from `offers.side` at
 * read time. Every ledger post keys off `seller_id` (escrow lives in the
 * seller's `escrow` account), so a change to the offer must never be able to
 * re-point an open escrow at a different person.
 */
export const p2pTrades = p2p.table(
  'p2p_trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    takerId: text('taker_id').notNull(),
    /** Denormalised so the reputation sweep does not join a closed offer. */
    makerId: text('maker_id').notNull(),
    /** THE ESCROW OWNER. Snapshotted at take; never recomputed. */
    sellerId: text('seller_id').notNull(),
    buyerId: text('buyer_id').notNull(),
    asset: text('asset').notNull(),
    fiatCurrency: text('fiat_currency').notNull(),
    /** Crypto quantity held in escrow. */
    amount: amount('amount').notNull(),
    /** Initial terms claimed before the first post. Legacy NULL is unproven. */
    originalTermsClaimedAt: tstz('original_terms_claimed_at'),
    escrowLockAttempts: bigint('escrow_lock_attempts', { mode: 'bigint' }),
    /** Effective price at take — snapshotted so a float offer cannot re-price mid-trade. */
    price: amount('price').notNull(),
    /** What the buyer owes off-platform, already quantised to the currency's minor units. */
    fiatAmount: amount('fiat_amount').notNull(),
    method: text('method').notNull(),
    /** Snapshotted at take, for the same reason `token.stakes.multiplier_bps` is. */
    feeBps: bps('fee_bps').notNull().default('0'),
    /** The method's settlement profile in the market it pays into, copied at take (P-disputes-security-09). */
    nonInstant: boolean('non_instant').notNull().default(false),
    settlementWindowSeconds: integer('settlement_window_seconds'),
    /** P-ads-merchant-19: the release window of a cash-in-person method row, copied at take (300 s to 24 h). */
    cashReleaseSeconds: integer('cash_release_seconds'),
    status: tradeStatusEnum('status').notNull().default('created'),
    /**
     * THE DECISION. Written and committed before the ledger post it authorises.
     *
     * Non-null ⇒ terminal ⇒ no further movement is permitted, by CHECK.
     */
    resolution: tradeResolutionEnum('resolution'),
    resolutionReason: text('resolution_reason'),
    chatThreadId: uuid('chat_thread_id'),
    /** §6.2 `deadlines jsonb` — the full record, for the UI and the audit trail. */
    deadlines: jsonb('deadlines').notNull().default({}),
    /**
     * The one deadline that currently applies, mirrored out of `deadlines` on
     * every transition and NULLed when terminal. The sweeper scans this: a
     * sweeper that has to parse jsonb per row is a sweeper that gets skipped,
     * and a sweep that gets skipped is funds sitting in escrow forever.
     */
    deadlineAt: tstz('deadline_at'),
    createdAt: createdAt(),
    escrowedAt: tstz('escrowed_at'),
    fiatSentAt: tstz('fiat_sent_at'),
    /** When the resolution was recorded. Always ≤ `settled_at`. */
    resolvedAt: tstz('resolved_at'),
    /**
     * When the ledger post for the resolution was confirmed.
     *
     * `resolved_at IS NOT NULL AND settled_at IS NULL` is the settlement
     * sweeper's work queue — a decision that has been made but not yet acted
     * on. It is the only window in which value can be *late*, and it is
     * self-healing because every recipe is keyed on the trade id.
     */
    settledAt: tstz('settled_at'),
    /**
     * Last failure from `settle()` while still late. Survives process restart
     * so operators do not need grepped logs (ADR surface permanent fail).
     * Cleared when `settled_at` is stamped.
     */
    lastSettleError: text('last_settle_error'),
    lastSettleErrorAt: tstz('last_settle_error_at'),
  },
  (t) => [
    /** The sweeper: what is overdue, oldest first. */
    index('p2p_trades_deadline_idx').on(t.deadlineAt),
    /** The settlement sweeper: decided but not yet posted. */
    index('p2p_trades_unsettled_idx').on(t.resolvedAt, t.settledAt),
    index('p2p_trades_offer_idx').on(t.offerId),
    index('p2p_trades_seller_idx').on(t.sellerId, t.status),
    index('p2p_trades_buyer_idx').on(t.buyerId, t.status),
  ],
);

/**
 * §6.2 `p2p_disputes`.
 *
 * One dispute per trade, ever (unique index). A second dispute row would mean
 * two moderators could reach two decisions about one escrow.
 */
export const p2pDisputes = p2p.table(
  'p2p_disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => p2pTrades.id),
    openedBy: text('opened_by').notNull(),
    /**
     * Who filed the dispute. `party` = a buyer/seller called `disputes.open`.
     * `timeout` = the fiat_sent clock opened it. `opened_by` is still the party
     * of interest (the buyer who marked fiat sent on a timeout open) — never a
     * system principal — so this column is what stops the audit trail lying.
     */
    openedVia: text('opened_via').notNull().default('party'),
    reason: text('reason').notNull().default(''),
    /**
     * Same identifier space as `p2p_trades.chat_thread_id`. Copied from the
     * trade at open when set; allocated and written onto both rows when not.
     * An id, not a transcript — empty chat stays empty.
     */
    chatThreadId: uuid('chat_thread_id'),
    /**
     * APPEND-ONLY, and the database enforces it
     * (`p2p_disputes_evidence_append_only_trg`). A jsonb array of attributed
     * envelopes: `{ seq, submittedBy, submittedAt, item }`. Evidence that can be
     * edited after the fact is not a record of a dispute, it is a draft.
     */
    evidence: jsonb('evidence').notNull().default([]),
    moderatorId: text('moderator_id'),
    resolution: disputeResolutionEnum('resolution'),
    resolutionNotes: text('resolution_notes'),
    status: disputeStatusEnum('status').notNull().default('open'),
    /**
     * Moderator SLA. Past it the dispute ESCALATES — it is never resolved by a
     * clock. A disputed escrow terminates only on a ruling attributed to a
     * human (`p2p_trades_disputed_needs_ruling_trg`).
     */
    deadlineAt: tstz('deadline_at').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    resolvedAt: tstz('resolved_at'),
    /**
     * Written by the statement that SERVES this row to a moderator, and by
     * nothing else. "A queue exists" and "a human reached this dispute" are
     * different claims, and only one of them is a fact about the world.
     */
    lastSeenByModeratorAt: tstz('last_seen_by_moderator_at'),
    moderatorViews: integer('moderator_views').notNull().default(0),
    /** SLA breached: re-armed and raised, never disposed of. */
    escalatedAt: tstz('escalated_at'),
    escalations: integer('escalations').notNull().default(0),
    /** Set by disputes.escalate. The timeout sweep leaves this null. */
    escalatedBy: text('escalated_by'),
    escalationReason: text('escalation_reason'),
    /** Written at resolve. false is the default-off single-moderator ruling. */
    fourEyes: boolean('four_eyes'),
  },
  (t) => [
    uniqueIndex('p2p_disputes_trade_idx').on(t.tradeId),
    /** THE MODERATOR QUEUE — `disputes.list` orders by exactly this. */
    index('p2p_disputes_open_idx').on(t.status, t.deadlineAt),
  ],
);

/**
 * §6.2 `p2p_reputation` — completion rate, average release time, disputes lost.
 *
 * Counters, not a derived view, because the read is on the hot path of every
 * offer render and the XP award that follows a trade must see the post-trade
 * numbers in the same transaction that wrote them.
 *
 * This feeds `intafaced.identity.xp.earned` — §6.2 → §4.1, one graph: a
 * spotless P2P record raises limits everywhere.
 */
export const p2pReputation = p2p.table(
  'p2p_reputation',
  {
    userId: text('user_id').primaryKey(),
    /** Trades this user was a party to that reached escrow. */
    tradesTotal: integer('trades_total').notNull().default(0),
    completed: integer('completed').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
    disputed: integer('disputed').notNull().default(0),
    disputesLost: integer('disputes_lost').notNull().default(0),
    /** completed / trades_total, 0..1. Not money — but still not a float. */
    completionRate: numeric('completion_rate', { precision: 6, scale: 4 }).notNull().default('0'),
    /** Accumulators, so the average is exact and does not drift on update. */
    totalReleaseSecs: bigint('total_release_secs', { mode: 'number' }).notNull().default(0),
    releaseSamples: integer('release_samples').notNull().default(0),
    avgReleaseSecs: integer('avg_release_secs').notNull().default(0),
    badges: text('badges').array().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [index('p2p_reputation_completed_idx').on(t.completed)],
);

/**
 * PAYMENT INSTRUMENTS (0001) — where the buyer actually sends the money.
 *
 * Everything above this line is a decision about value that lives in
 * svc-ledger. Everything below it is **personal data**, and it is the most
 * attractive thing in this service to steal: an account number, a name, and the
 * knowledge that its owner trades crypto.
 *
 * So the design question is not "can we store it" but "who can read it, for how
 * long, and can we prove afterwards who did". The answer, in one line and
 * enforced in `instrument-service.ts`:
 *
 *   An instrument is disclosed only while the escrow it is attached to is HELD,
 *   and a disclosure that is not logged cannot happen.
 */

/**
 * WHAT A METHOD NEEDS, PER COUNTRY — supplied by an operator, not by us.
 *
 * Ships EMPTY, and that is the design. What a payer needs in order to send
 * money differs by method and by country and it is not this repo's knowledge to
 * invent; a seeded list of plausible field names is a wrong answer wearing the
 * costume of a right one. An operator registers what a market really requires;
 * until they do, that market refuses instruments — loudly, which is the point.
 *
 * `country` is ISO 3166-1 alpha-2 or `*` ("the same everywhere"). An exact
 * country always beats the wildcard.
 */
export const paymentMethodSchemas = p2p.table(
  'payment_method_schemas',
  {
    methodId: text('method_id').notNull(),
    country: text('country').notNull(),
    label: text('label').notNull(),
    /** `FieldSpec[]` — key, label, required, pattern, lengths, sensitive, help. */
    fields: jsonb('fields').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Why the operator switched it off (0022): regulation | provider_withdrawn | fraud_risk | low_demand. */
    delistReason: text('delist_reason'),
    delistedAt: tstz('delisted_at'),
    /** Settlement profile (P-disputes-security-09): instant, or a window of 60 s to 30 days (null = the published deadline). */
    instant: boolean('instant').notNull().default(true),
    settlementWindowSeconds: integer('settlement_window_seconds'),
    /** Payment-note rules (P-ads-merchant-19): `{ guidance, forbidden[] }`, or null when none is registered. */
    noteRules: jsonb('note_rules'),
    /** Cash-in-person rules (P-ads-merchant-19): `{ meetingGuidance, proof, releaseWindowSeconds }`; set = cash in person. */
    cashRules: jsonb('cash_rules'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.methodId, t.country] })],
);

/**
 * One destination a seller will accept money at.
 *
 * `status` is `active | removed`, and removal is a state rather than a DELETE:
 * an in-flight trade's snapshot points here, the access log points here, and an
 * appeal months later may ask which destination a trade used. "The seller
 * deleted their account details" is precisely the moment those records matter.
 *
 * Removal keeps the row and NOT the data: `details` goes NULL in the same
 * statement that sets the status, and `payment_instruments_details_ck` makes
 * `removed` with details a row Postgres will not accept. The fingerprint stays,
 * so an appeal can still ask "was the buyer shown this account" without us
 * holding the account in order to answer.
 *
 * The unique partial index below is the load-bearing one — see the migration.
 * One active destination per `(owner, method, currency)` is what makes "which
 * account does the buyer pay?" have exactly one answer at take time, on the one
 * field where picking the wrong row sends a stranger's money to a stranger.
 */
export const paymentInstruments = p2p.table(
  'payment_instruments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    methodId: text('method_id').notNull(),
    country: text('country').notNull(),
    /** The currency this destination can actually receive. Part of the match key. */
    fiatCurrency: text('fiat_currency').notNull(),
    /** The owner's own name for it. Shown to the payer, so it is not a public handle. */
    label: text('label').notNull().default(''),
    /**
     * THE PERSONAL DATA. Exactly the declared fields — an undeclared key is
     * refused, not dropped. NULL exactly when `status = 'removed'`; the CHECK
     * constraint, not this column, is what enforces both halves.
     */
    details: jsonb('details'),
    /** sha256 over the canonical details. Outlives them, so an appeal survives the purge. */
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    removedAt: tstz('removed_at'),
  },
  (t) => [
    uniqueIndex('payment_instruments_active_slot_idx')
      .on(t.ownerId, t.methodId, t.fiatCurrency)
      .where(sql`status = 'active'`),
    index('payment_instruments_owner_idx').on(t.ownerId, t.status),
  ],
);

/**
 * WHAT THE BUYER WAS TOLD TO PAY, FROZEN WHEN THE TRADE WAS OPENED.
 *
 * A snapshot rather than a pointer, for two reasons and the second is the
 * bigger one:
 *
 *   1. the owner may edit or remove their instrument without blanking the
 *      screen a buyer is copying an account number out of;
 *   2. **the destination cannot change mid-trade.** Show account A, let the
 *      buyer start paying, switch to account B, then truthfully report that
 *      nothing arrived — a scam with a clean audit trail, and a live pointer is
 *      what makes it possible.
 *
 * `details` goes NULL when the retention sweep purges a closed trade; the
 * fingerprint stays, so "was this the account the buyer was shown" is still
 * answerable without us still holding the account.
 */
export const tradePaymentInstruments = p2p.table(
  'trade_payment_instruments',
  {
    tradeId: uuid('trade_id')
      .primaryKey()
      .references(() => p2pTrades.id),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => paymentInstruments.id),
    /** Denormalised: an authorisation check must not join a row that may since have been removed. */
    ownerId: text('owner_id').notNull(),
    methodId: text('method_id').notNull(),
    country: text('country').notNull(),
    fiatCurrency: text('fiat_currency').notNull(),
    label: text('label').notNull().default(''),
    details: jsonb('details'),
    fingerprint: text('fingerprint').notNull(),
    attachedAt: tstz('attached_at').notNull().defaultNow(),
    purgedAt: tstz('purged_at'),
  },
  (t) => [
    index('trade_payment_instruments_owner_idx').on(t.ownerId),
    index('trade_payment_instruments_unpurged_idx')
      .on(t.attachedAt)
      .where(sql`purged_at IS NULL`),
  ],
);

/**
 * WHO LOOKED AT WHOSE ACCOUNT DETAILS, WHEN, AND WHETHER THEY WERE ALLOWED TO.
 *
 * A table and not a log line, because the question it answers is asked after
 * something has gone wrong, by someone who needs an answer that survived log
 * rotation. Not having it is the problem.
 *
 * Refusals are recorded too, and they are the more interesting half: one reveal
 * is a buyer paying, eleven refusals against eleven sellers in an hour is
 * someone harvesting — and that looks like nothing at all in a table that only
 * records successes.
 *
 * The migration adds a BEFORE UPDATE OR DELETE trigger that raises. The service
 * writes this row in the same statement that reads the details, so a read
 * cannot happen without a record; the trigger is why the record cannot be
 * tidied away afterwards.
 */
/**
 * Firm block/RFQ quotes (PTX-M12). Not the offer board and not a matching fill.
 * Size, price, expiry, capacity and firmness are required; there is no mid column on purpose.
 * Capacity is never defaulted. Firmness is only `firm` — last look cannot be stored.
 */
export const blockQuoteLifecycleEnum = p2p.enum('block_quote_lifecycle', ['open', 'bound', 'expired']);
export const blockQuoteCapacityEnum = p2p.enum('block_quote_capacity', ['principal', 'matched_principal', 'agency']);
export const blockQuoteFirmnessEnum = p2p.enum('block_quote_firmness', ['firm']);

export const blockQuotes = p2p.table(
  'block_quotes',
  {
    quoteId: uuid('quote_id').primaryKey(),
    makerId: text('maker_id').notNull(),
    takerId: text('taker_id').notNull(),
    side: offerSideEnum('side').notNull(),
    asset: text('asset').notNull(),
    fiatCurrency: text('fiat_currency').notNull(),
    size: amount('size').notNull(),
    price: amount('price').notNull(),
    notional: amount('notional').notNull(),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    lifecycle: blockQuoteLifecycleEnum('lifecycle').notNull().default('open'),
    acceptedAt: tstz('accepted_at'),
    fillPrice: amount('fill_price'),
    capacity: blockQuoteCapacityEnum('capacity').notNull(),
    firmness: blockQuoteFirmnessEnum('firmness').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [index('block_quotes_maker_idx').on(t.makerId, t.lifecycle), index('block_quotes_taker_idx').on(t.takerId, t.lifecycle)],
);

export const instrumentAccessLog = p2p.table(
  'instrument_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: a refusal on a trade with no instrument has none to name. */
    instrumentId: uuid('instrument_id').references(() => paymentInstruments.id),
    ownerId: text('owner_id'),
    viewerId: text('viewer_id').notNull(),
    /** `owner | counterparty | moderator | other`. */
    viewerRole: text('viewer_role').notNull(),
    tradeId: uuid('trade_id').references(() => p2pTrades.id),
    /** `revealed | denied`. */
    outcome: text('outcome').notNull(),
    denyReason: text('deny_reason'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    /** The owner's own "who has seen my account details" view. */
    index('instrument_access_log_owner_idx').on(t.ownerId, t.at),
    /** The abuse query: everything one viewer has reached for. */
    index('instrument_access_log_viewer_idx').on(t.viewerId, t.at),
    index('instrument_access_log_trade_idx').on(t.tradeId),
  ],
);

export const schema = {
  offers,
  p2pTrades,
  p2pDisputes,
  p2pReputation,
  paymentMethodSchemas,
  paymentInstruments,
  tradePaymentInstruments,
  instrumentAccessLog,
  blockQuotes,
};
