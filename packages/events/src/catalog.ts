import { z } from 'zod';
import type { ModuleId } from '@intafaced/config';
import { subject, type Verb } from './subject.js';

/**
 * THE EVENT CATALOG.
 *
 * Every subject the OS publishes is declared here with its zod payload schema
 * and version. Nothing publishes a subject that is not in this file — that is
 * what makes the bus a contract rather than a rumour mill.
 *
 * Adding an event = a contracts/events PR (§15.2), reviewed before the
 * producing service is touched.
 */

export interface EventDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly subject: string;
  readonly service: ModuleId;
  readonly entity: string;
  readonly verb: Verb;
  readonly version: number;
  readonly schema: TSchema;
  readonly description: string;
}

function defineEvent<TSchema extends z.ZodTypeAny>(
  service: ModuleId,
  entity: string,
  verb: Verb,
  version: number,
  schema: TSchema,
  description: string,
): EventDef<TSchema> {
  return { subject: subject(service, entity, verb), service, entity, verb, version, schema, description };
}

// ── Shared primitives ────────────────────────────────────────────────────────

/** Unsigned money. Decimal string, never a JS number — 18 decimals matter. No leading minus. */
export const amountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be a decimal string (max 18dp)');
/**
 * Signed money: drift, pnl, and funding (received is negative).
 * Same decimal string; the leading minus is the sign.
 */
export const signedAmountSchema = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'signed amount must be a decimal string (max 18dp)');
export const assetIdSchema = z.string().min(1).max(16);
export const userIdSchema = z.string().guid();
/**
 * Engine fill identity. UUID, required wherever a fill is named on the bus.
 *
 * Not a book sequence, not `market:sequence`, not a JS number, not a ledger
 * amount. `orderFilled.sequence` orders the book; `fillSettled.fillId` names
 * the fill. A second interpretation of the same money fact is refused here.
 */
export const engineFillIdSchema = z.string().guid();

/**
 * An order id as the matching engine names it on the bus: a trade order uuid, or one leg of a linked OCO,
 * `<uuid>:tp` / `<uuid>:sl`. svc-trade settles a leg against its parent order (one hold, two legs); every
 * other consumer treats the id as opaque.
 */
export const engineOrderIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(:(tp|sl))?$/, {
    message: 'must be an order uuid, optionally suffixed :tp or :sl',
  });

// ── identity (§4.1) ──────────────────────────────────────────────────────────

export const xpEarned = defineEvent(
  'identity',
  'xp',
  'earned',
  1,
  z.object({
    userId: userIdSchema,
    sourceModule: z.string(),
    action: z.string(),
    xpDelta: z.number().int(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  'A module awarded XP. svc-identity is the only consumer that writes rank_state.',
);

export const rankUpdated = defineEvent(
  'identity',
  'rank',
  'updated',
  1,
  z.object({
    userId: userIdSchema,
    rank: z.number().int().min(0),
    previousRank: z.number().int().min(0),
    xp: z.string(),
  }),
  'Rank recalculated. Consumers invalidate their cached perks.',
);

export const userCreated = defineEvent(
  'identity',
  'user',
  'created',
  1,
  z.object({ userId: userIdSchema, handle: z.string(), region: z.string().length(2).optional() }),
  'A sovereign account exists.',
);

export const kycApproved = defineEvent(
  'identity',
  'kyc',
  'approved',
  1,
  z.object({
    userId: userIdSchema,
    tier: z.enum(['basic', 'full', 'institutional']),
    jurisdiction: z.string().length(2),
  }),
  'Verification tier granted — limits and module access change on this signal.',
);

/**
 * I-kyc-compliance-01. The KYC case lifecycle beside kycApproved. Published by svc-identity from an
 * outbox row after the transition commits, business key identity.kyc.<verb>:<caseId>:<version>. No
 * document, image or personal detail rides on the bus: consumers re-read the case through contracts.
 */
const kycCaseIdSchema = z.string().guid();

export const kycSubmitted = defineEvent(
  'identity',
  'kyc',
  'submitted',
  1,
  z.object({
    userId: userIdSchema,
    caseId: kycCaseIdSchema,
    /** The case version after the transition; part of the business key. */
    version: z.number().int().min(1),
    /** The rejected case this resubmission follows, or null for a first submission. */
    previousCaseId: kycCaseIdSchema.nullable(),
    submittedAt: z.string().datetime({ offset: true }),
  }),
  'A KYC case was opened for review. A resubmission after a reject opens a new case linked to the old one.',
);

export const kycRejected = defineEvent(
  'identity',
  'kyc',
  'rejected',
  1,
  z.object({
    userId: userIdSchema,
    caseId: kycCaseIdSchema,
    version: z.number().int().min(1),
    /** A code from the owner reason list; the reason and fix-guidance text live with the list, not on the bus. */
    reasonCode: z.string().min(1).max(64),
    rejectedAt: z.string().datetime({ offset: true }),
  }),
  'A KYC case was rejected with a listed reason code. svc-notify sends the reason and a resubmit link (flow kyc_resubmit) where vendor.email is configured.',
);

export const kycInfoRequested = defineEvent(
  'identity',
  'kyc_info',
  'requested',
  1,
  z.object({
    userId: userIdSchema,
    caseId: kycCaseIdSchema,
    version: z.number().int().min(1),
    reasonCode: z.string().min(1).max(64),
    requestedAt: z.string().datetime({ offset: true }),
  }),
  'Compliance asked for more information on a KYC case. The case waits for the customer; nothing is approved or rejected.',
);

/**
 * I-signin-sessions-08 (J-identity-05 #6). One change to a sign-in factor: the authenticator app turned on, off or
 * replaced, or a passkey added or removed. svc-identity publishes it from an outbox row written in the same transaction
 * as the change (at least once). No secret, code, credential id or address rides on it.
 */
export const SECURITY_FACTOR_CHANGES = ['totp_added', 'totp_removed', 'totp_replaced', 'passkey_added', 'passkey_removed'] as const;

export const securityFactorChanged = defineEvent(
  'identity',
  'security_factor',
  'updated',
  1,
  z.object({
    userId: userIdSchema,
    change: z.enum(SECURITY_FACTOR_CHANGES),
    changedAt: z.string().datetime({ offset: true }),
    /** The business key `factor-changed:<userId>:<n>`, n counted per account; a consumer dedupes on it. */
    noticeKey: z.string().min(1).max(128),
  }),
  'A sign-in factor of an account changed. svc-notify writes the security inbox notice (I-signin-sessions-08); svc-identity already mailed the proved address.',
);

/**
 * A death notice for an account (RC-identity-02, J-identity-05 #7). `created`: staff recorded one; the account is not
 * changed by it (a false report must never lock a living person). `confirmed`: a second person approved it, and in the
 * same transaction the account was frozen and its sessions and API keys revoked. Both are published from an outbox row,
 * at least once, with the business key `identity.death_notice.<created|confirmed>:<noticeId>`. Who reported and the
 * evidence never ride on the bus.
 */
const deathNoticePayload = z.object({ userId: userIdSchema, noticeId: z.string().guid(), at: z.string().datetime({ offset: true }) });

export const deathNoticeCreated = defineEvent(
  'identity',
  'death_notice',
  'created',
  1,
  deathNoticePayload,
  'Staff recorded a death notice for an account (RC-identity-02). The account is unchanged until a second person confirms it.',
);

export const deathNoticeConfirmed = defineEvent(
  'identity',
  'death_notice',
  'confirmed',
  1,
  deathNoticePayload,
  'A second person confirmed a death notice (RC-identity-02): the account is frozen and its sessions and API keys revoked. Its balances move only by the recovery keys the owner set (RC-identity-08).',
);

// ── ledger (§4.2) ────────────────────────────────────────────────────────────

export const ledgerTxPosted = defineEvent(
  'ledger',
  'tx',
  'posted',
  1,
  z.object({
    txId: z.string().guid(),
    module: z.string(),
    reason: z.string(),
    /** Hash chain link — consumers can verify the book independently. */
    hash: z.string(),
    previousHash: z.string().nullable(),
    entries: z
      .array(
        z.object({
          accountId: z.string().guid(),
          assetId: assetIdSchema,
          direction: z.enum(['debit', 'credit']),
          amount: amountSchema,
        }),
      )
      .min(2),
    postedAt: z.string().datetime({ offset: true }),
  }),
  'A double-entry transaction was committed. THE money event — every value movement in the OS emits exactly one.',
);

export const ledgerReconciliationFailed = defineEvent(
  'ledger',
  'reconciliation',
  'failed',
  1,
  z.object({
    accountId: z.string().guid(),
    assetId: assetIdSchema,
    snapshotBalance: amountSchema,
    replayBalance: amountSchema,
    drift: signedAmountSchema,
    module: z.string(),
  }),
  'Snapshot and entry replay disagree. Pages the operator and freezes the diverging module (§4.2).',
);

/**
 * An incomplete reconciliation run: Postgres or the connection failed before a
 * verdict. Emitted on every such run, including the one that freezes posting
 * after N consecutive failures (`reconcile_unproven`, D-128). Not a drift.
 * svc-ops stores each one as a platform incident (OPS-reconciliation-04); the freeze itself does not depend on it.
 */
export const ledgerReconciliationRunFailed = defineEvent(
  'ledger',
  'reconciliation_run',
  'failed',
  1,
  z.object({
    errorCode: z.string().min(1).max(64),
    phase: z.enum(['start', 'tip', 'proof', 'snapshot', 'tick']),
    consecutiveIncomplete: z.number().int().min(1),
    runId: z.string().nullable(),
  }),
  'A reconciliation run could not finish. Alerts on every incomplete run; posting stays open until a mismatch or N consecutive incompletes.',
);

/**
 * ONE subject for both directions, deliberately.
 *
 * `VERBS` is a closed list and holds no honest past tense for un-freezing, so
 * the alternative was either widening the event vocabulary or publishing a
 * thaw on a subject named `.frozen` — a subject that lies about its payload.
 *
 * The better reason is the consumer's: an alerting consumer subscribed to a
 * freeze-only subject would raise the alarm and never learn it was cleared.
 * One subject carrying the state means nothing can subscribe to half of it.
 */
export const ledgerFreezeUpdated = defineEvent(
  'ledger',
  'freeze',
  'updated',
  1,
  z
    .object({
      frozen: z.boolean(),
      /** Null only when `frozen` is false — an unexplained freeze is unactionable. */
      reason: z.string().min(1).nullable(),
      /**
       * WHO. An operator's principal id, `reconciliation` for the automatic
       * self-freeze, or `env:LEDGER_POSTING_ENABLED` for a boot-time freeze.
       * Never anonymous: the most consequential switch in the OS must always
       * name the thing that threw it.
       */
      actor: z.string().min(1),
      changedAt: z.string().datetime({ offset: true }),
    })
    .refine((p) => !p.frozen || p.reason !== null, {
      message: 'unexplained freeze is unactionable',
      path: ['reason'],
    }),
  'Ledger posting was frozen or thawed. Durable state, not a process signal — every replica reads the same row (§4.2).',
);

// ── token (§4.3) ─────────────────────────────────────────────────────────────

export const stakeCreated = defineEvent(
  'token',
  'stake',
  'created',
  1,
  z.object({
    stakeId: z.string().guid(),
    userId: userIdSchema,
    amount: amountSchema,
    tier: z.enum(['flex', 'm3', 'm12']),
    unlocksAt: z.string().datetime({ offset: true }).nullable(),
  }),
  'Stake opened — gates launchpad allocations, OTC access, premium lobbies, vendor slots.',
);

export const buybackExecuted = defineEvent(
  'token',
  'buyback',
  'completed',
  1,
  z.object({
    runId: z.string().guid(),
    tokensBought: amountSchema,
    tokensBurned: amountSchema,
    tokensToRewards: amountSchema,
    revenueWindow: z.object({ from: z.string(), to: z.string() }),
  }),
  'Structural buyback & burn ran. One flywheel across both planes (§17.3).',
);

// ── bank (§8.1) ──────────────────────────────────────────────────────────────

/**
 * A margin call was raised on a collateralised loan.
 *
 * This subject exists so that RAISING a call and TELLING the borrower stay two
 * separable facts. svc-bank writes the call durably — a `loan_margin_calls` row
 * whose grace clock gates liquidation — and publishes this. Whether the borrower
 * was actually reached is svc-notify's answer, recorded per channel, and it is
 * allowed to be "no". A borrower disputing a liquidation is owed both halves of
 * that story, and a single subject meaning "borrower notified" would have
 * destroyed the second half.
 *
 * `sequence` is the per-loan call number and the business key: a redelivered
 * call 3 of loan X must not notify twice. It sits on the payload rather than
 * only in the producer's idempotency key because the CONSUMER needs to dedupe
 * on it too, and a consumer cannot see a header it was not given.
 *
 * NOT a money event — nothing moved. `cureCollateralAmount` is what the borrower
 * would have to ADD to clear the call: a decimal string, like every other amount
 * on this bus.
 */
export const bankMarginCalled = defineEvent(
  'bank',
  'margin_call',
  'created',
  1,
  z.object({
    loanId: z.string().guid(),
    userId: userIdSchema,
    /** Per-loan call number, from 1. The business key for at-least-once delivery. */
    sequence: z.number().int().min(1),
    ltvBps: z.number().int().min(0),
    /** Collateral to ADD to return to target LTV. Not a balance, not a movement. */
    cureCollateralAmount: amountSchema,
    collateralAssetId: assetIdSchema,
    calledAt: z.string().datetime({ offset: true }),
    /** When grace ends and the liquidation ladder may act. */
    graceExpiresAt: z.string().datetime({ offset: true }),
  }),
  'A loan crossed the margin-call threshold. The call is durable at the producer whether or not anyone was reached (§8.1).',
);

/**
 * A support request was resolved. The business key for at-least-once delivery is the ticket: a request
 * asks for its rating once (`rating-request:<ticketId>`), however many times this is delivered.
 *
 * Carries no money and no request text, only who to ask and when it was solved.
 */
export const supportTicketResolved = defineEvent(
  'support',
  'ticket',
  'resolved',
  1,
  z.object({
    ticketId: z.string().guid(),
    /** The person who raised the request, i.e. whom to ask for a rating. */
    userId: userIdSchema,
    resolvedAt: z.string().datetime({ offset: true }),
  }),
  'A support request was resolved. The owner can now rate it; svc-notify turns this into the rating request.',
);

// ── blueprint (§7.1) ─────────────────────────────────────────────────────────
//
// Doctrine §0.7 governs these payloads as much as any UI string: nothing here
// names the intelligence behind a profile. §10 governs their contents — no
// payload on this bus carries profile axes, birth data, or anything else
// derived from what a user told the session. Consumers that need the profile
// read it through packages/contracts under the user's own authority.

const crewRoleSchema = z.enum(['anchor', 'scout', 'builder', 'catalyst']);

export const blueprintCreated = defineEvent(
  'blueprint',
  'blueprint',
  'created',
  1,
  z.object({
    blueprintId: z.string().guid(),
    userId: userIdSchema,
    /** Which engine build produced it. Profiles are comparable only within a version. */
    engineVersion: z.string().min(1),
    visibility: z.enum(['private', 'crew', 'public']),
  }),
  "An Identity Blueprint exists. svc-identity sets profiles.blueprint_id on this signal — svc-blueprint never writes another service's tables (§2).",
);

export const blueprintDeleted = defineEvent(
  'blueprint',
  'blueprint',
  'deleted',
  1,
  z.object({
    blueprintId: z.string().guid(),
    userId: userIdSchema,
    erasedAt: z.string().datetime({ offset: true }),
  }),
  'Hard delete (§7.2 "deletion truly cascades"). svc-identity clears profiles.blueprint_id; every consumer drops cached profile data. Idempotent on user id.',
);

export const crewMemberCreated = defineEvent(
  'blueprint',
  'crew_member',
  'created',
  1,
  z.object({
    crewId: z.string().guid(),
    userId: userIdSchema,
    role: crewRoleSchema,
    crewSize: z.number().int().min(1),
    matchRunId: z.string().guid(),
  }),
  'Crew placement. svc-academy routes the lobby, svc-agents opens the crew channel.',
);

// ── matching (§5.1) ──────────────────────────────────────────────────────────

export const orderAccepted = defineEvent(
  'matching',
  'order',
  'accepted',
  1,
  z.object({ orderId: engineOrderIdSchema, marketId: z.string(), sequence: z.number().int() }),
  'Engine admitted an order to the book.',
);

export const orderFilled = defineEvent(
  'matching',
  'order',
  'filled',
  1,
  z.object({
    marketId: z.string(),
    makerOrderId: engineOrderIdSchema,
    takerOrderId: engineOrderIdSchema,
    price: amountSchema,
    qty: amountSchema,
    /**
     * Engine book sequence — public-tape uniqueness / ordering, not fill identity.
     * Fill identity is `fillSettled.fillId` (`engineFillIdSchema`).
     */
    sequence: z.number().int(),
    ts: z.string().datetime({ offset: true }),
    /**
     * Matching STP account ids (users: userId; house MM: `house:market-maker`).
     * Optional for catalog roll-forward with older producers; svc-trade recovery
     * needs makerAccountId for house MM seed makers (no trade.orders row).
     */
    makerAccountId: z.string().min(1).optional(),
    takerAccountId: z.string().min(1).optional(),
  }),
  'A match occurred. svc-trade turns this into a tradeFill ledger recipe.',
);

export const orderCancelled = defineEvent(
  'matching',
  'order',
  'cancelled',
  1,
  z.object({
    orderId: engineOrderIdSchema,
    marketId: z.string(),
    remainingQty: amountSchema,
    sequence: z.number().int(),
    // Why it left: the engine's cancel reason (`expired` for a GTD/GTT at its expiry). Absent from older producers;
    // a consumer reads absent as a plain cancel.
    reason: z.string().min(1).optional(),
  }),
  'Order left the book — svc-trade releases the ledger hold.',
);

/**
 * A stop order's trigger fired (J-cex-spot-06 #6). The price that reached the stop is `referencePrice`, read from
 * `triggerBy` (the last trade, or the mark or index price). What the activated order then did follows as its own
 * `orderFilled` / `orderCancelled` events at later sequences; a trigger whose order could not go on is followed by a
 * cancel with reason `trigger_rejected`. Evidence for "why did my stop fire, and at what price": moves no money.
 *
 * Idempotency key: `matching.order.triggered:<marketId>:<sequence>`.
 */
export const orderTriggered = defineEvent(
  'matching',
  'order',
  'triggered',
  1,
  z.object({
    orderId: engineOrderIdSchema,
    marketId: z.string(),
    /** The activation's book sequence: the order's fills and cancels from this trigger come after it. */
    sequence: z.number().int(),
    triggerBy: z.enum(['last', 'mark', 'index']),
    stopPrice: amountSchema,
    /** The reference price that reached the stop when it fired. */
    referencePrice: amountSchema,
    ts: z.string().datetime({ offset: true }),
  }),
  'A stop order fired. svc-trade records when and at what price, so the order says why it went to the book.',
);

/**
 * A spread order matched (CB-otc-16). One event per spread fill, carrying every
 * leg, so svc-trade posts one hold release and one fill for the whole spread and
 * never a partial leg. A spread fill is NOT an `orderFilled`: the spread price
 * may be zero or negative, and the legs only mean something together.
 *
 * Idempotency key: `matching.spread.filled:<spreadId>:<sequence>`.
 */
export const spreadFilled = defineEvent(
  'matching',
  'spread',
  'filled',
  1,
  z.object({
    spreadId: z.string().min(1),
    makerOrderId: engineOrderIdSchema,
    takerOrderId: engineOrderIdSchema,
    makerAccountId: z.string().min(1),
    takerAccountId: z.string().min(1),
    takerSide: z.enum(['buy', 'sell']),
    /** Spread price: Σ side × ratio × leg price from the buyer's view. May be zero or negative. */
    price: signedAmountSchema,
    qty: amountSchema,
    /** Engine book sequence of the spread's own book. */
    sequence: z.number().int(),
    ts: z.string().datetime({ offset: true }),
    /** Every leg, filled in full at the listed ratio. Legs sum to the spread price exactly. */
    legs: z
      .array(
        z.object({
          symbol: z.string().min(1),
          takerSide: z.enum(['buy', 'sell']),
          qty: amountSchema,
          price: amountSchema,
        }),
      )
      .min(2),
  }),
  'A spread order matched with every leg filled at its ratio. svc-trade turns it into one hold release and one fill per side.',
);

/**
 * User-visible order lifecycle (svc-trade).
 *
 * Matching's `orderFilled` / `orderCancelled` are engine facts without a user
 * id. Private order streams and mobile clients need a trade-owned signal that
 * names the owner. This is that signal — not a money path, not a balance.
 */
export const orderUpdated = defineEvent(
  'trade',
  'order',
  'updated',
  1,
  z.object({
    orderId: z.string().guid(),
    userId: z.string().guid(),
    marketId: z.string(),
    status: z.enum(['pending', 'open', 'filled', 'cancelled', 'rejected', 'expired']),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['limit', 'market']),
    qty: amountSchema,
    filledQty: amountSchema,
    price: amountSchema.nullable(),
    clientOrderId: z.string().nullable(),
    ts: z.string().datetime({ offset: true }),
  }),
  'svc-trade order row changed — private WS fans this to the owning principal only.',
);

/**
 * User-visible fill (svc-trade). Private streams fan this to the fill owner only.
 * Distinct from matching.order.filled (engine fact, no user id on the wire).
 *
 * `fillId` is the engine fill identity (UUID, required). `sequence` is the
 * book counter for that market — it must not be reused as a second fill id.
 */
export const fillSettled = defineEvent(
  'trade',
  'fill',
  'settled',
  1,
  z.object({
    fillId: engineFillIdSchema,
    orderId: z.string().guid(),
    userId: z.string().guid(),
    marketId: z.string(),
    side: z.enum(['buy', 'sell']),
    liquidity: z.enum(['maker', 'taker']),
    price: amountSchema,
    qty: amountSchema,
    quoteAmount: amountSchema,
    feeAsset: z.string(),
    feeAmount: amountSchema,
    feeBps: z.number().int(),
    /** Book sequence for the market. Not fill identity. */
    sequence: z.number().int(),
    ts: z.string().datetime({ offset: true }),
  }),
  'svc-trade settled a fill for a user — private WS only.',
);

/**
 * User-visible futures position (svc-trade). Private WS fans this to the owner.
 *
 * Published by svc-trade's futures engine: `position-service` on every position
 * transition and `tick-stores` on liquidation. `/private/stream` fans it to the
 * owner, and `ws-private-orders-positions` is a live durable consumer.
 *
 * THIS DOCSTRING USED TO SAY THE OPPOSITE — "until that engine exists nothing
 * emits this event". The engine does exist and two call sites had been emitting
 * for some time. The gate below cannot catch that: `positionUpdated` is wired at
 * both ends, so `event-wiring` passes and always would have. Only prose can be
 * wrong in this direction, which is exactly why it was worth correcting — a
 * catalog read as the map of what is wired is worth nothing if an entry
 * volunteers that it is dark while it is running.
 */
export const positionUpdated = defineEvent(
  'trade',
  'position',
  'updated',
  1,
  z.object({
    positionId: z.string().guid(),
    userId: userIdSchema,
    marketId: z.string().min(1),
    symbol: z.string().min(1),
    status: z.enum(['open', 'closing', 'closed', 'liquidated']),
    side: z.enum(['long', 'short']),
    /** Absolute contract size — decimal string, never a JS number. */
    contracts: amountSchema,
    entryPrice: amountSchema,
    markPrice: amountSchema.nullable(),
    notional: amountSchema,
    leverage: amountSchema.nullable(),
    collateral: amountSchema.nullable(),
    unrealizedPnl: signedAmountSchema.nullable(),
    realizedPnl: signedAmountSchema.nullable(),
    liquidationPrice: amountSchema.nullable(),
    marginMode: z.enum(['cross', 'isolated']).nullable(),
    /** Cumulative funding paid (positive) or received (negative) as decimal string. */
    fundingPaid: signedAmountSchema,
    /** Set when status=closing — futures-namespaced refuse code; null otherwise. */
    closingReason: z.string().nullable().optional(),
    ts: z.string().datetime({ offset: true }),
  }),
  'svc-trade futures position changed — private WS fans this to the owning principal only.',
);

// ── protocol (§17.4 · Protocol Plane, non-custodial) ─────────────────────────
//
// Every event below is an OBSERVATION of chain state, not a record of something
// the platform did. Note what none of them carry: no balance, no key material,
// no amount that moved. The Protocol Plane holds nothing, so there is nothing
// of the user's for these payloads to describe (§16.9, §22).

const evmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex');
/** Wei — an integer decimal string. Never a number; 2^53 wei is 0.009 ETH. */
const weiSchema = z.string().regex(/^\d+$/, 'wei must be a non-negative integer string');

export const protocolAccountCreated = defineEvent(
  'protocol',
  'account',
  'created',
  1,
  z.object({
    chainId: z.number().int().positive(),
    account: evmAddressSchema,
    /** The user's key. The only key with power over this account. */
    owner: evmAddressSchema,
    userSalt: bytes32Schema,
    txHash: bytes32Schema,
    /** Absent for an account never linked to an INTAFACED profile — which is allowed. */
    userId: userIdSchema.optional(),
  }),
  'A self-custody smart account was deployed. The platform holds no key to it (§17.4).',
);

export const protocolSessionKeyCreated = defineEvent(
  'protocol',
  'session_key',
  'created',
  1,
  z.object({
    chainId: z.number().int().positive(),
    account: evmAddressSchema,
    sessionKey: evmAddressSchema,
    /** keccak256 of the full scope — the commitment the account stores. */
    specHash: bytes32Schema,
    validAfter: z.number().int().min(0),
    validUntil: z.number().int().positive(),
    /** A CAP on native value, in wei. Not an amount that moved. */
    spendLimitWei: weiSchema,
    targets: z.array(evmAddressSchema).min(1),
    selectors: z.array(z.string().regex(/^0x[0-9a-fA-F]{8}$/)).min(1),
    txHash: bytes32Schema,
  }),
  'The account owner granted a scoped, expiring session key. Never carries transfer power (§16.10).',
);

export const protocolSessionKeyCancelled = defineEvent(
  'protocol',
  'session_key',
  'cancelled',
  1,
  z.object({
    chainId: z.number().int().positive(),
    account: evmAddressSchema,
    sessionKey: evmAddressSchema,
    /** The owner, or the session key retiring itself. Nobody else can. */
    revokedBy: evmAddressSchema,
    txHash: bytes32Schema,
  }),
  'A session key was revoked on chain. Consumers stop routing agent execution through it.',
);

// ── agents (§8.2) ────────────────────────────────────────────────────────────

/**
 * Note what these payloads do NOT carry: no prompt, no completion text, no
 * model identifier. Doctrine §0.7 keeps third-party system names out of
 * anything that ships, and §10 keeps user content out of general stores — a
 * durable event stream is both. Consumers get the routing task, the counts and
 * the codes; anything more detailed is a query against `agent_actions` under
 * the caller's own authorisation.
 */
export const agentActionCompleted = defineEvent(
  'agents',
  'action',
  'completed',
  1,
  z.object({
    sessionId: z.string().guid(),
    userId: userIdSchema,
    agentId: z.string(),
    sequence: z.number().int().min(0),
    kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
    /** Routing task id — configuration, never a product name. */
    task: z.string().nullable(),
    tool: z.string().nullable(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
  'An agent did something on a user’s behalf. The public half of the Agentic Law (§8.2).',
);

export const agentActionRejected = defineEvent(
  'agents',
  'action',
  'rejected',
  1,
  z.object({
    sessionId: z.string().guid(),
    userId: userIdSchema,
    agentId: z.string(),
    sequence: z.number().int().min(0),
    /** Guardrail code, e.g. 'agents.tool_not_declared'. */
    refusalCode: z.string(),
    tool: z.string().nullable(),
    task: z.string().nullable(),
  }),
  'A guardrail refused an action before it ran. Compliance consumes this; so does the user’s own log.',
);

export const agentUsageSettled = defineEvent(
  'agents',
  'usage',
  'settled',
  1,
  z.object({
    sessionId: z.string().guid(),
    userId: userIdSchema,
    windowId: z.string(),
    amount: amountSchema,
    assetId: assetIdSchema,
    /** The ledger idempotency key — the reconciliation handle. */
    chargeKey: z.string(),
  }),
  'A metered usage window was billed through the ledger (§8.2 premium agent tiers).',
);

export const agentUsageAlertCrossed = defineEvent(
  'agents',
  'usage_alert',
  'crossed',
  1,
  z.object({
    /** The business key, one per agent and month: `agents.usage_alert:<agent id>:<YYYY-MM>`. */
    alertKey: z.string().min(1).max(200),
    userId: userIdSchema,
    /** The person's own agent whose spend this month reached the alert. */
    agentId: z.string().guid(),
    /** The UTC month, `YYYY-MM`. */
    month: z.string().regex(/^\d{4}-\d{2}$/),
    /** The alert the person set, and what the agent had spent this month when it was reached. Not a balance. */
    alertAt: amountSchema,
    spent: amountSchema,
    assetId: assetIdSchema,
    /** Whether the person also asked for this alert by email. */
    email: z.boolean(),
  }),
  'An own agent’s spend this month reached the alert its owner set. Published once per agent and month, so the owner is told once.',
);

// ── p2p (§6.2) ───────────────────────────────────────────────────────────────

export const p2pOfferCreated = defineEvent(
  'p2p',
  'offer',
  'created',
  1,
  z.object({
    offerId: z.string().guid(),
    makerId: userIdSchema,
    side: z.enum(['buy', 'sell']),
    asset: assetIdSchema,
    fiatCurrency: z.string().length(3),
    priceType: z.enum(['fixed', 'float']),
    price: amountSchema,
    minAmount: amountSchema,
    maxAmount: amountSchema,
  }),
  'A P2P offer is live and takeable.',
);

export const p2pEscrowLocked = defineEvent(
  'p2p',
  'escrow',
  'locked',
  1,
  z.object({
    tradeId: z.string().guid(),
    offerId: z.string().guid(),
    sellerId: userIdSchema,
    buyerId: userIdSchema,
    asset: assetIdSchema,
    amount: amountSchema,
    fiatCurrency: z.string().length(3),
    fiatAmount: amountSchema,
    /** When the buyer must have paid by. Escrow never waits indefinitely. */
    paymentDeadline: z.string().datetime({ offset: true }),
  }),
  'Seller crypto is in escrow. The clock on this trade is now running.',
);

export const p2pEscrowReleased = defineEvent(
  'p2p',
  'escrow',
  'released',
  1,
  z.object({
    tradeId: z.string().guid(),
    sellerId: userIdSchema,
    buyerId: userIdSchema,
    asset: assetIdSchema,
    amount: amountSchema,
    fee: amountSchema,
    resolvedBy: z.enum(['seller', 'moderator']),
    /** Seconds from escrow to release — feeds the maker's reputation. */
    releaseSeconds: z.number().int().nonnegative(),
  }),
  'Escrow released to the buyer — the trade completed.',
);

export const p2pEscrowRefunded = defineEvent(
  'p2p',
  'escrow',
  'refunded',
  1,
  z.object({
    tradeId: z.string().guid(),
    sellerId: userIdSchema,
    buyerId: userIdSchema,
    asset: assetIdSchema,
    amount: amountSchema,
    resolvedBy: z.enum(['buyer', 'seller', 'moderator', 'timeout']),
    reason: z.string(),
  }),
  'Escrow returned to the seller — cancelled, timed out, or resolved in their favour.',
);

export const p2pTradeDisputed = defineEvent(
  'p2p',
  'trade',
  'disputed',
  2,
  z.object({
    tradeId: z.string().guid(),
    disputeId: z.string().guid(),
    openedBy: userIdSchema,
    /**
     * Version 2 (P-trade-orders-23): both parties ride on the payload so svc-notify can tell the
     * counterparty, not only the opener. Optional until svc-p2p fills them (its own PR); a consumer
     * that needs them skips a payload without them rather than guessing a recipient.
     */
    buyerId: userIdSchema.optional(),
    sellerId: userIdSchema.optional(),
    reason: z.string(),
    moderatorDeadline: z.string().datetime({ offset: true }),
  }),
  'A trade is contested. Escrow stays locked until a moderator rules.',
);

export const p2pDisputeResolved = defineEvent(
  'p2p',
  'dispute',
  'resolved',
  2,
  z.object({
    disputeId: z.string().guid(),
    tradeId: z.string().guid(),
    /** Version 2 (P-trade-orders-23): both parties get the ruling. Optional until svc-p2p fills them. */
    buyerId: userIdSchema.optional(),
    sellerId: userIdSchema.optional(),
    /**
     * Who ruled. Kept a non-empty string rather than a user id so a ruling by a named
     * principal stays publishable; the former `system:p2p-backstop` timer is gone
     * (svc-p2p `state.ts` header), so in practice this is the moderator's id.
     */
    moderatorId: z.string().min(1),
    resolution: z.enum(['release', 'refund']),
    /** True when the backstop timer ruled rather than a human. */
    automatic: z.boolean(),
    notes: z.string().optional(),
  }),
  'A moderator ruled. The decision is recorded before the ledger post, so the trail always explains the movement.',
);

export const p2pTradeExpired = defineEvent(
  'p2p',
  'trade',
  'expired',
  2,
  z.object({
    tradeId: z.string().guid(),
    /** Version 2 (P-trade-orders-23): both parties get the expiry notice. Optional until svc-p2p fills them. */
    buyerId: userIdSchema.optional(),
    sellerId: userIdSchema.optional(),
    from: z.string(),
    outcome: z.enum(['released', 'refunded', 'voided', 'disputed']),
  }),
  'A deadline passed and the timeout path acted. Every live state has a clock, and every clock acts.',
);

/**
 * P-trade-orders-23. The spec names these `p2p.trade.fiat_sent` and `p2p.chat.message`; the subject
 * law is <service>.<entity>.<verb> with a closed verb list, so they are spelled with the verb last
 * (`sent`, added to VERBS with `escalated`). No message text rides on the bus: the chat body stays in
 * svc-p2p, and a notice only says a message is waiting.
 */
export const p2pTradeFiatSent = defineEvent(
  'p2p',
  'trade_fiat',
  'sent',
  1,
  z.object({
    tradeId: z.string().guid(),
    buyerId: userIdSchema,
    sellerId: userIdSchema,
    markedAt: z.string().datetime({ offset: true }),
  }),
  'The buyer marked the fiat payment as sent. The seller must check and release. A trade is marked paid once, so consumers dedupe on tradeId.',
);

/**
 * P-trade-orders-15 / J-p2p-02 #2: the buyer reminded the seller to check the payment and release. Numbered from 1 per
 * order (`n`); the owner's wait and count bound how many there are. Consumers dedupe on tradeId and n.
 */
export const p2pTradeReminderSent = defineEvent(
  'p2p',
  'trade_reminder',
  'sent',
  1,
  z.object({
    tradeId: z.string().guid(),
    n: z.number().int().positive(),
    buyerId: userIdSchema,
    sellerId: userIdSchema,
    remindedAt: z.string().datetime({ offset: true }),
  }),
  'The buyer reminded the seller to check the payment and release. A reminder is sent once per (tradeId, n).',
);

/**
 * P-ads-merchant-18 / J-p2p-04 #4: the maker removed the last payment method some active sell ads could be paid with,
 * confirmed, and those ads were paused in the same transaction (reason `method_removed`). One event per removal: an
 * instrument is removed once, so consumers dedupe on instrumentId. The maker re-adds a method and resumes the ads.
 */
export const p2pOfferPaused = defineEvent(
  'p2p',
  'offer',
  'paused',
  1,
  z.object({
    instrumentId: z.string().guid(),
    makerId: userIdSchema,
    methodId: z.string().min(1).max(64),
    offerIds: z.array(z.string().guid()).min(1).max(1000),
    reason: z.literal('method_removed'),
    pausedAt: z.string().datetime({ offset: true }),
  }),
  'Active sell ads were paused because the maker removed the only payment method they could still be paid with. Sent once per removed instrument.',
);

/**
 * P-ads-merchant-19 / J-p2p-04 #5: a party to an order reported a sensitive remark in its payment note, and a case was
 * opened. One case per (order, reporter): consumers dedupe on caseId. The remark itself never travels on the bus; the
 * reported party is told a case was opened about their order, and staff read the case in svc-p2p.
 */
export const p2pRemarkCaseOpened = defineEvent(
  'p2p',
  'remark_case',
  'opened',
  1,
  z.object({
    caseId: z.string().guid(),
    tradeId: z.string().guid(),
    reportedId: userIdSchema,
    reporterRole: z.enum(['buyer', 'seller']),
    openedAt: z.string().datetime({ offset: true }),
  }),
  'A party to a P2P order reported a sensitive remark in its payment note; a case was opened. Sent once per case.',
);

export const p2pChatMessageSent = defineEvent(
  'p2p',
  'chat_message',
  'sent',
  1,
  z.object({
    tradeId: z.string().guid(),
    messageId: z.string().guid(),
    senderId: userIdSchema,
    recipientId: userIdSchema,
    sentAt: z.string().datetime({ offset: true }),
  }),
  'A trade chat message was sent. Carries no message text; the recipient reads it in the order chat.',
);

/** Shared with P-order-02. Appeal-status notices go to both parties. */
export const p2pDisputeEscalated = defineEvent(
  'p2p',
  'dispute',
  'escalated',
  1,
  z.object({
    disputeId: z.string().guid(),
    tradeId: z.string().guid(),
    buyerId: userIdSchema,
    sellerId: userIdSchema,
    escalatedBy: z.string().min(1),
    escalatedAt: z.string().datetime({ offset: true }),
  }),
  'A dispute was escalated to the next review level. Escrow stays locked; both parties are told.',
);

export const p2pQuoteExpired = defineEvent(
  'p2p',
  'quote',
  'expired',
  1,
  z.object({
    quoteId: z.string().guid(),
    userId: userIdSchema,
    expiredAt: z.string().datetime({ offset: true }),
  }),
  'A P2P quote passed its firm window unaccepted. Nothing is bound; the requester is told to re-quote.',
);

/**
 * The skip reason ids svc-trade writes on its skip log (CB-copy-11). Ids only: the screen and the notice turn them into
 * words. `refused` is any other typed refusal of the mirror; its words name no raw code.
 */
export const COPY_SKIP_REASON_IDS = [
  'paused',
  'stopped',
  'lead_stopped',
  'risk_control',
  'insufficient_funds',
  'max_copy_total',
  'copy_slippage_exceeded',
  'position_closed',
  'refused',
] as const;

/** Why a follow stopped copying. Ids only, never a raw refusal code. */
export const COPY_STOP_REASON_IDS = ['follower', 'lead_stopped', 'risk_control', 'permission_ended'] as const;

/** A lowercase reason id (`order_rejected`), never a sentence or a raw service code. */
const copyReasonIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
/** svc-trade's follow id: today a uuid, stored as text, so any id without blanks or separators beyond `: . _ -`. */
const copyFollowIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const copySkipped = defineEvent(
  'trade',
  'copy',
  'skipped',
  1,
  z.object({
    followId: copyFollowIdSchema,
    followerId: userIdSchema,
    leaderId: userIdSchema,
    leaderFillId: engineFillIdSchema,
    reason: z.enum(COPY_SKIP_REASON_IDS),
    skippedAt: z.string().datetime({ offset: true }),
  }),
  'A follow did not copy one leader fill. svc-trade writes the skip row first and publishes after commit; there is one per follow and leader fill, so consumers dedupe on (followId, leaderFillId). The follower is told the reason.',
);

export const copyFailed = defineEvent(
  'trade',
  'copy',
  'failed',
  1,
  z.object({
    followId: copyFollowIdSchema,
    followerId: userIdSchema,
    leaderId: userIdSchema,
    leaderFillId: engineFillIdSchema,
    reason: copyReasonIdSchema,
    failedAt: z.string().datetime({ offset: true }),
  }),
  'A copy order was placed for a leader fill and did not complete. No funds move on this event; consumers dedupe on (followId, leaderFillId). The reason is an open id because order refusals grow with the engine; a consumer words the ids it knows and gives a general notice for the rest. The follower is told the reason.',
);

export const copyStopped = defineEvent(
  'trade',
  'copy',
  'stopped',
  1,
  z.object({
    followId: copyFollowIdSchema,
    followerId: userIdSchema,
    leaderId: userIdSchema,
    reason: z.enum(COPY_STOP_REASON_IDS),
    closeOnly: z.boolean(),
    stoppedAt: z.string().datetime({ offset: true }),
  }),
  'A follow stopped copying new leader fills. With closeOnly it still mirrors closes of what it already holds. A stop is one-way (close-only can only become left), so consumers dedupe on (followId, closeOnly). The follower is told the reason.',
);

export const projectionUpdated = defineEvent(
  'indexer',
  'projection',
  'updated',
  1,
  z.object({
    marketId: z.string().min(1).max(64),
    sequence: z.number().int(),
    fromSequence: z.number().int(),
    bids: z.array(z.tuple([z.string(), z.string()])),
    asks: z.array(z.tuple([z.string(), z.string()])),
  }),
  'Indexer projection as market-data absolute totals. Empty arrays are empty, not a live $0 book. Venue ABI is not invented here.',
);

export const personalRequestCreated = defineEvent(
  'bank',
  'personal_request',
  'created',
  1,
  z.object({
    requestId: z.string().guid(),
    payerUserId: userIdSchema,
    payeeHandle: z.string().min(1).max(32),
    amount: amountSchema,
    assetId: assetIdSchema,
    note: z.string().max(140).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    /** 1 when the request is opened. 2 and up are reminds. */
    sequence: z.number().int().min(1),
  }),
  'Someone was asked to pay a personal request. svc-notify writes pay.request_created for the payer.',
);

export const personalRequestSettled = defineEvent(
  'bank',
  'personal_request',
  'settled',
  1,
  z.object({
    requestId: z.string().guid(),
    payeeUserId: userIdSchema,
    payerHandle: z.string().min(1).max(32),
    amount: amountSchema,
    assetId: assetIdSchema,
    ledgerTxId: z.string().min(1).max(128),
  }),
  'A personal request was paid by transfers.toUser. svc-notify writes pay.request_paid for the payee.',
);

/**
 * PP-send-request-18. Receipts. One fact per event: svc-notify writes pay.transfer_sent for the
 * sender and pay.transfer_received for the recipient from the same posted transfer, so neither
 * party can get a receipt the other does not. The in-app notice is always written; email and SMS
 * copies follow each person's orders setting. Published by svc-bank
 * from its outbox: the posted row records the notice as owed in the same UPDATE that marks it
 * `posted`, and stays owed until the bus takes it; a lost consumer ack never changes money.
 */
export const personalTransferPosted = defineEvent(
  'bank',
  'personal_transfer',
  'posted',
  1,
  z.object({
    transferId: z.string().min(1).max(128),
    senderUserId: userIdSchema,
    recipientUserId: userIdSchema,
    amount: amountSchema,
    assetId: assetIdSchema,
    ledgerTxId: z.string().min(1).max(128),
    postedAt: z.string().datetime({ offset: true }),
  }),
  'A personal send posted. svc-notify writes pay.transfer_sent for the sender and pay.transfer_received for the recipient.',
);

export const personalRefundPosted = defineEvent(
  'bank',
  'personal_refund',
  'posted',
  1,
  z.object({
    refundId: z.string().min(1).max(128),
    /** The transfer being refunded; the refund ledger key is refund:<origTransferId>:<refundId>. */
    origTransferId: z.string().min(1).max(128),
    /** Who sends the money back (the original recipient) and who gets it (the original sender). */
    refunderUserId: userIdSchema,
    refundeeUserId: userIdSchema,
    amount: amountSchema,
    assetId: assetIdSchema,
    ledgerTxId: z.string().min(1).max(128),
    postedAt: z.string().datetime({ offset: true }),
  }),
  'A personal refund posted. svc-notify writes pay.refund_posted for both parties.',
);

export const personalDisputeUpdated = defineEvent(
  'bank',
  'personal_dispute',
  'updated',
  1,
  z.object({
    disputeId: z.string().min(1).max(128),
    activityId: z.string().min(1).max(128),
    userId: userIdSchema,
    /** Null when the counterparty is not a platform user (for example an unclaimed link). */
    counterpartyUserId: userIdSchema.nullable(),
    /** svc-bank's dispute state after the change, as svc-bank names it. Opaque to consumers. */
    status: z.string().min(1).max(32),
    /** Monotonic per dispute; consumers dedupe on (disputeId, sequence) as well as the event id. */
    sequence: z.number().int().min(1),
    changedAt: z.string().datetime({ offset: true }),
  }),
  'A personal Pay dispute changed state. svc-notify writes pay.dispute_changed for the opener and the counterparty.',
);

/**
 * BK-acct-10 (J-bank-06 #6). Standing-order notices (the spec's `bank.scheduled.reminder/failed`, named with the
 * subject law's verbs). svc-bank records each notice as owed in its own outbox
 * (`bank.scheduled_notices`, one row per schedule, occurrence and kind) and publishes it until the bus takes it, so a
 * retried job never tells a person twice and a lost publish is sent again. Neither moves value: the run that failed has
 * already been recorded, and a reminder is about a run that has not happened.
 */
export const bankScheduledReminder = defineEvent(
  'bank',
  'scheduled_reminder',
  'triggered',
  1,
  z.object({
    noticeId: z.string().guid(),
    userId: userIdSchema,
    scheduleId: z.string().guid(),
    /** Periods since the schedule's start; with `scheduleId` it names the one run this reminds of. */
    occurrence: z.number().int().min(0),
    dueAt: z.string().datetime({ offset: true }),
    /** What the order will try to move, as it stands when the reminder is sent. */
    amount: amountSchema,
    assetId: assetIdSchema,
    /** The lead time the person chose, in hours. */
    leadHours: z.number().int().min(1),
  }),
  'A standing order runs within the lead time its owner chose. svc-notify writes bank.scheduled_reminder for that person.',
);

export const bankScheduledFailed = defineEvent(
  'bank',
  'scheduled_run',
  'failed',
  1,
  z.object({
    noticeId: z.string().guid(),
    userId: userIdSchema,
    scheduleId: z.string().guid(),
    occurrence: z.number().int().min(0),
    /** What the run tried to move. Nothing was posted. */
    amount: amountSchema,
    assetId: assetIdSchema,
    /** Why the run was refused, as svc-bank recorded it (for example `ledger.insufficient_funds`). */
    reasonCode: z.string().min(1).max(64),
    failedAt: z.string().datetime({ offset: true }),
  }),
  'A standing order run was refused and posted nothing. svc-notify writes bank.scheduled_failed for its owner.',
);

// ── core-ops: platform alert rules (OPS-alerts-01) ───────────────────────────

const alertRuleIdSchema = z.string().guid();
/** Stable identity of one alert instance: the rule's id and the hash of its label set. */
const alertInstanceSchema = z.string().regex(/^[a-f0-9]{64}$/, 'instance is a sha-256 of the label set');

export const coreOpsAlertRuleUpdated = defineEvent(
  'core-ops',
  'alert_rule',
  'updated',
  1,
  z.object({
    ruleId: alertRuleIdSchema,
    /** The rule's version after this change. Every save keeps a version; a retired rule is restored, never destroyed. */
    version: z.number().int().min(1),
    change: z.enum(['created', 'updated', 'paused', 'resumed', 'retired', 'restored']),
    /** The signed individual operator. Never a shared credential. */
    actor: z.string().min(1),
    changedAt: z.string().datetime({ offset: true }),
  }),
  'A platform alert rule was created, edited, paused, resumed, retired or restored. A new version row exists for it.',
);

export const coreOpsAlertOpened = defineEvent(
  'core-ops',
  'alert',
  'opened',
  1,
  z.object({
    ruleId: alertRuleIdSchema,
    instance: alertInstanceSchema,
    /** The stored evaluation counter of this instance, not a clock, so a restarted evaluator re-derives the same key. */
    epoch: z.number().int().min(0),
    /** `firing` once the pending period has passed; `error` and `no_data` raise an alert about the rule itself. */
    state: z.enum(['firing', 'error', 'no_data']),
    openedAt: z.string().datetime({ offset: true }),
  }),
  'A platform alert instance started firing. Business key ops:alert:opened:<ruleId>:<instance>:<epoch>; consumers are idempotent on it.',
);

export const coreOpsAlertResolved = defineEvent(
  'core-ops',
  'alert',
  'resolved',
  1,
  z.object({
    ruleId: alertRuleIdSchema,
    instance: alertInstanceSchema,
    epoch: z.number().int().min(0),
    resolvedAt: z.string().datetime({ offset: true }),
  }),
  'A platform alert instance returned to normal. Carries the ruleId, instance and epoch of the opened event it closes. Its own business key is ops:alert:resolved:<ruleId>:<instance>:<epoch>, so the bus never drops it as a duplicate of the open.',
);

export const coreOpsAlertPolicyUpdated = defineEvent(
  'core-ops',
  'alert_policy',
  'updated',
  1,
  z.object({
    version: z.number().int().min(1),
    /** The signed individual operator. Never a shared credential. */
    actor: z.string().min(1),
    changedAt: z.string().datetime({ offset: true }),
  }),
  'A platform alert routing tree was saved. Business key ops:alert-policy:<version>. The tree itself is the durable row.',
);

// ── core-ops: on-call alert groups (OPS-oncall-01) ───────────────────────────

/** An alert group id as svc-ops stores it. Acknowledge, resolve and silence are idempotent on ops:alert-group:<group>:<action>:<n>. */
const alertGroupIdSchema = z.string().min(1).max(128);

export const coreOpsAlertGroupOpened = defineEvent(
  'core-ops',
  'alert_group',
  'opened',
  1,
  z.object({
    groupId: alertGroupIdSchema,
    /** The escalation chain that starts for this group; null when none is attached (the group still shows as firing). */
    chainId: z.string().min(1).max(128).nullable(),
    labels: z.array(z.string().min(1).max(128)),
    openedAt: z.string().datetime({ offset: true }),
  }),
  'An on-call alert group started firing. Its escalation chain, if any, starts now.',
);

export const coreOpsAlertGroupUpdated = defineEvent(
  'core-ops',
  'alert_group',
  'updated',
  1,
  z.object({
    groupId: alertGroupIdSchema,
    action: z.enum(['acknowledged', 'silenced', 'unsilenced', 'restarted', 'escalated']),
    /** The per-group action counter n of the business key ops:alert-group:<group>:<action>:<n>. */
    sequence: z.number().int().min(1),
    /** The signed operator, or the chain step id for an escalation. */
    actor: z.string().min(1),
    changedAt: z.string().datetime({ offset: true }),
  }),
  'An on-call alert group was acknowledged, silenced, unsilenced, restarted or escalated a step. An acknowledgement stops the chain.',
);

export const coreOpsAlertGroupResolved = defineEvent(
  'core-ops',
  'alert_group',
  'resolved',
  1,
  z.object({
    groupId: alertGroupIdSchema,
    sequence: z.number().int().min(1),
    /** The signed operator, or `auto` when every alert in the group returned to normal. */
    actor: z.string().min(1),
    resolvedAt: z.string().datetime({ offset: true }),
  }),
  'An on-call alert group was resolved. Its chain stops; a new firing opens a new group.',
);

// ── core-ops: reconciliation alerts (OPS-reconciliation-04) ──────────────────

/**
 * A reconciliation alert as svc-ops stores it: one per control, failing asset and period. Every change carries the
 * alert's change counter, so the business key ops:reconciliation-alert:<alertId>:<sequence> is unique per change and a
 * consumer that receives one twice applies it once. Ids and states only: no amount, account or customer data.
 */
const reconciliationAlertIdSchema = z.string().guid();
const reconciliationAlertSequenceSchema = z.number().int().min(1);
const reconciliationAlertStateSchema = z.enum(['open', 'acknowledged', 'snoozed', 'resolved', 'accepted']);
/** The states an alert can be in after each transition: an unsnooze returns it to open or acknowledged. */
const UPDATED_STATES: Record<'acknowledged' | 'snoozed' | 'unsnoozed' | 'reopened', readonly string[]> = {
  acknowledged: ['acknowledged'],
  snoozed: ['snoozed'],
  unsnoozed: ['open', 'acknowledged'],
  reopened: ['open'],
};

export const coreOpsReconciliationAlertOpened = defineEvent(
  'core-ops',
  'reconciliation_alert',
  'opened',
  1,
  z
    .object({
      alertId: reconciliationAlertIdSchema,
      sequence: reconciliationAlertSequenceSchema,
      /** The ledger reconciliation control and the run that raised the alert. */
      controlId: z.string().uuid(),
      runId: z.string().guid(),
      /** The failing asset; null when the run failed with no asset to name, or could not finish. */
      assetId: assetIdSchema.nullable(),
      periodStart: z.string().datetime({ offset: true }),
      periodEnd: z.string().datetime({ offset: true }),
      /** `fail`: the books disagree, raised to finance. `error`: the run could not finish, raised to the platform team. */
      cause: z.enum(['fail', 'error']),
      team: z.enum(['finance', 'platform']),
      openedAt: z.string().datetime({ offset: true }),
    })
    .refine((p) => (p.cause === 'fail') === (p.team === 'finance'), {
      message: 'a failing run is raised to finance and a run that could not finish to the platform team',
      path: ['team'],
    })
    .refine((p) => Date.parse(p.periodEnd) >= Date.parse(p.periodStart), {
      message: 'the period ends before it starts',
      path: ['periodEnd'],
    }),
  'svc-ops raised a reconciliation alert from a finished ledger reconciliation run. A failing run goes to finance; a run that could not finish goes to the platform team. Business key ops:reconciliation-alert:<alertId>:<sequence>.',
);

export const coreOpsReconciliationAlertUpdated = defineEvent(
  'core-ops',
  'reconciliation_alert',
  'updated',
  1,
  z
    .object({
      alertId: reconciliationAlertIdSchema,
      sequence: reconciliationAlertSequenceSchema,
      /** `reopened`: a repeat failure in the same period reopened a resolved alert; the actor is then `auto`. */
      transition: z.enum(['acknowledged', 'snoozed', 'unsnoozed', 'reopened']),
      state: reconciliationAlertStateSchema,
      /** The signed operator, or `auto` for a change the evaluator made. Never a shared credential. */
      actor: z.string().min(1),
      changedAt: z.string().datetime({ offset: true }),
    })
    .refine((p) => UPDATED_STATES[p.transition].includes(p.state), {
      message: 'the state does not follow from the transition',
      path: ['state'],
    }),
  'A reconciliation alert was acknowledged, snoozed, unsnoozed or reopened by a repeat failure in its period. Never changes a balance. Business key ops:reconciliation-alert:<alertId>:<sequence>.',
);

export const coreOpsReconciliationAlertResolved = defineEvent(
  'core-ops',
  'reconciliation_alert',
  'resolved',
  1,
  z
    .object({
      alertId: reconciliationAlertIdSchema,
      sequence: reconciliationAlertSequenceSchema,
      /** `fixed`: an operator linked the corrective ledger transactions. `auto`: a later run of the same control and period passed. */
      resolution: z.enum(['fixed', 'auto']),
      /** The corrective ledger transaction ids, each checked to exist; empty for `auto`. */
      correctiveTxIds: z.array(z.string().guid()).max(20),
      /** The run that passed, for `auto`; null for `fixed`. */
      passingRunId: z.string().guid().nullable(),
      /** The signed operator, or `auto`. */
      actor: z.string().min(1),
      resolvedAt: z.string().datetime({ offset: true }),
    })
    .refine(
      (p) =>
        p.resolution === 'fixed'
          ? p.correctiveTxIds.length > 0 && p.passingRunId === null && p.actor !== 'auto'
          : p.correctiveTxIds.length === 0 && p.passingRunId !== null && p.actor === 'auto',
      { message: 'a fix names its corrective transactions and an operator; an auto resolve names the passing run', path: ['resolution'] },
    ),
  'A reconciliation alert was resolved as fixed (with the corrective ledger transactions it names) or automatically when a later run passed. Resolving never changes a balance. Business key ops:reconciliation-alert:<alertId>:<sequence>.',
);

export const coreOpsReconciliationAlertAccepted = defineEvent(
  'core-ops',
  'reconciliation_alert',
  'accepted',
  1,
  z
    .object({
      alertId: reconciliationAlertIdSchema,
      sequence: reconciliationAlertSequenceSchema,
      /** The operator who asked to accept the discrepancy and the different operator who approved it. */
      requestedBy: z.string().min(1),
      approvedBy: z.string().min(1),
      /** sha-256 of the evidence frozen at acceptance, so a later read can prove it is unchanged. */
      evidenceHash: z.string().regex(/^[a-f0-9]{64}$/, 'evidenceHash is a sha-256'),
      /** sha-256 of the required note: the event proves a note was written without carrying its text. */
      noteHash: z.string().regex(/^[a-f0-9]{64}$/, 'noteHash is a sha-256'),
      acceptedAt: z.string().datetime({ offset: true }),
    })
    .refine((p) => p.requestedBy !== p.approvedBy, { message: 'the approver must be a second operator', path: ['approvedBy'] }),
  'A reconciliation discrepancy was accepted with a note, frozen evidence and a second approver. Never changes a balance. Business key ops:reconciliation-alert:<alertId>:<sequence>.',
);

// ── core-ops: compliance cases (OPS-cases-01) ────────────────────────────────

export const coreOpsComplianceCaseCreated = defineEvent(
  'core-ops',
  'compliance_case',
  'created',
  1,
  z.object({
    caseId: z.string().min(1).max(128),
    inboxId: z.string().min(1).max(128),
    kind: z.enum(['screening_hit', 'kyc_review', 'network_flag', 'manual']),
    /** Opaque subject id. Never a PII payload. */
    subjectId: z.string().min(1).max(128),
    createdAt: z.string().datetime({ offset: true }),
  }),
  'A compliance case was stored in svc-ops. Business key is the case id; consumers are idempotent on it.',
);

export const coreOpsComplianceInboxUpdated = defineEvent(
  'core-ops',
  'compliance_inbox',
  'updated',
  1,
  z.object({
    inboxId: z.string().min(1).max(128),
    /** Definitions are versioned; business key compliance:queue:<name>:<version>. */
    version: z.number().int().min(1),
    change: z.enum(['defined', 'favourited', 'unfavourited']),
    actor: z.string().min(1),
    changedAt: z.string().datetime({ offset: true }),
  }),
  'A compliance inbox was defined or its favourite flag changed.',
);

// ── core-ops: joint restore (OPS-ledger-desk-05) ─────────────────────────────

const restoreBase = {
  restoreNo: z.string().min(1).max(128),
  actor: z.string().min(1),
};

export const coreOpsRestoreStarted = defineEvent(
  'core-ops',
  'restore',
  'started',
  1,
  z.object({ ...restoreBase, cutOff: z.string().datetime({ offset: true }), startedAt: z.string().datetime({ offset: true }) }),
  'A joint restore was begun in svc-ops. Business key ops:restore:started:<restoreNo>.',
);

export const coreOpsRestoreCompleted = defineEvent(
  'core-ops',
  'restore',
  'completed',
  1,
  z.object({ ...restoreBase, approverId: z.string().min(1), completedAt: z.string().datetime({ offset: true }) }),
  'A joint restore was finalised with a second approver after every step existed as a row. Business key ops:restore:completed:<restoreNo>.',
);

export const coreOpsRestoreFailed = defineEvent(
  'core-ops',
  'restore',
  'failed',
  1,
  z.object({
    ...restoreBase,
    step: z.enum(['restore_clean', 'validate', 'preview', 'finalize']),
    code: z.string().min(1).max(128),
    failedAt: z.string().datetime({ offset: true }),
  }),
  'A joint restore step failed or was refused; nothing was finalised. Business key ops:restore:failed:<restoreNo>:<step>.',
);

// ── pay: custody audit log (W-security-accounts-05) ─────────────────────────

/** The kinds of wallet and custody action the audit log records. */
export const CUSTODY_AUDIT_CATEGORIES = ['withdrawal', 'address_change', 'limit_change', 'freeze', 'policy_change'] as const;
export const custodyAuditCategorySchema = z.enum(CUSTODY_AUDIT_CATEGORIES);
export type CustodyAuditCategory = z.infer<typeof custodyAuditCategorySchema>;

/**
 * One append-only audit entry. `entryKey` is the producer's business key (for example
 * `pay:withdrawal:requested:<withdrawalId>`): the store keeps one row per key, so the same fact published twice is one
 * entry. A withdrawal entry must name its request id. Client context fields are null when the action had no client
 * (a system job), never guessed. No amount is carried: the ledger is the record of value, this is the record of who did what.
 */
export const custodyAuditEntryPayloadSchema = z
  .object({
    entryKey: z.string().min(1).max(256),
    category: custodyAuditCategorySchema,
    action: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'action is a lower-case dotted token'),
    actor: z.object({
      type: z.enum(['user', 'operator', 'service', 'system']),
      id: z.string().min(1).max(128),
    }),
    subjectUserId: z.string().min(1).max(128).nullable(),
    clientContext: z.object({
      ip: z.string().min(1).max(64).nullable(),
      userAgent: z.string().min(1).max(512).nullable(),
      apiKeyId: z.string().min(1).max(128).nullable(),
    }),
    requestId: z.string().min(1).max(128).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((e) => e.category !== 'withdrawal' || e.requestId !== null, {
    message: 'a withdrawal audit entry names its request id',
    path: ['requestId'],
  });
export type CustodyAuditEntryPayload = z.infer<typeof custodyAuditEntryPayloadSchema>;

export const payCustodyAuditCreated = defineEvent(
  'pay',
  'custody_audit',
  'created',
  1,
  custodyAuditEntryPayloadSchema,
  'A wallet or custody action (withdrawal, address change, limit change, freeze, policy change) was recorded for the append-only audit log behind /custody-ops. Deduplicated by entryKey.',
);

// ── pay: a crypto deposit was credited (W-deposit-05, W-deposit-09) ─────────

/**
 * One crypto deposit the ledger has credited to the customer's available balance. Published by svc-pay after the
 * deposit row turned `credited` (the ledger post is the credit; this only says it happened). svc-pay records that it
 * announced the row and announces again any credited row it has not recorded, so a crash after the credit still reaches
 * the customer. Business key `pay:deposit-credit:posted:<depositId>`; a consumer keys its notice on `depositId`.
 */
export const payDepositCreditPostedPayloadSchema = z
  .object({
    depositId: z.string().guid(),
    userId: userIdSchema,
    assetId: assetIdSchema,
    networkId: z.string().min(1).max(64),
    amount: amountSchema,
    txHash: z.string().min(1).max(256),
    ledgerTxId: z.string().guid(),
    creditedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PayDepositCreditPostedPayload = z.infer<typeof payDepositCreditPostedPayloadSchema>;

export const payDepositCreditPosted = defineEvent(
  'pay',
  'deposit_credit',
  'posted',
  1,
  payDepositCreditPostedPayloadSchema,
  'A crypto deposit was credited to the customer (the ledger deposit post is the credit). For the inbox notice; deduplicated by depositId.',
);

// ── pay: a customer withdrawal moved to a new status (W-withdraw-06, ENGINE W-1) ─

/**
 * The customer withdrawal status vocabulary (ENGINE W-1). svc-pay's `WITHDRAWAL_STATUSES` is the same twelve words, and
 * its transition table decides which moves are legal; this list only fixes the words on the wire.
 */
export const WITHDRAWAL_STATUS_VALUES = [
  'requested',
  'pending_review',
  'approved',
  'held',
  'dispatching',
  'broadcast',
  'confirming',
  'settled',
  'rejected',
  'canceled',
  'failed',
  'needs_review',
] as const;
export const withdrawalStatusSchema = z.enum(WITHDRAWAL_STATUS_VALUES);
export type WithdrawalStatusValue = z.infer<typeof withdrawalStatusSchema>;

/**
 * One move of a customer withdrawal, published by svc-pay after the move committed (the row and, for a hold, settle or
 * reverse, the ledger post are the record; this only says it happened). `seq` counts the withdrawal's moves from 1, in
 * the order svc-pay committed them, so a withdrawal that goes back into review or is retried after a proved refusal is
 * a new move, never a repeat of an earlier one. A new withdrawal's first move has `from` null and is `requested`.
 * `attempt` is the rail attempt the move belongs to. `failureCode` is the stored cause when there is one: required on
 * `failed` and `rejected`, and carried on any other status that has one (a `needs_review` after an unknown send). Business
 * key `pay:withdrawal-status:<withdrawalId>:<seq>`: the same move published twice is one fact, and a consumer keys on
 * (withdrawalId, seq). No amount is carried: the ledger is the record of value.
 */
export const payWithdrawalStatusUpdatedPayloadSchema = z
  .object({
    withdrawalId: z.string().guid(),
    userId: userIdSchema,
    seq: z.number().int().min(1),
    attempt: z.number().int().min(0),
    from: withdrawalStatusSchema.nullable(),
    to: withdrawalStatusSchema,
    failureCode: z
      .string()
      .regex(/^[a-z][a-z0-9_.]{0,63}$/, 'failureCode is a lower-case dotted token')
      .nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((e) => e.from !== e.to, { message: 'a move changes the status', path: ['to'] })
  .refine((e) => (e.from === null) === (e.seq === 1) && (e.from !== null || e.to === 'requested'), {
    message: 'only the first move (seq 1) has no previous status, and it is requested',
    path: ['from'],
  })
  .refine((e) => !(e.to === 'failed' || e.to === 'rejected') || e.failureCode !== null, {
    message: 'a failed or rejected withdrawal names its failure code',
    path: ['failureCode'],
  });
export type PayWithdrawalStatusUpdatedPayload = z.infer<typeof payWithdrawalStatusUpdatedPayloadSchema>;

export const payWithdrawalStatusUpdated = defineEvent(
  'pay',
  'withdrawal_status',
  'updated',
  1,
  payWithdrawalStatusUpdatedPayloadSchema,
  'A customer withdrawal moved to a new status (requested, held, broadcast, settled, failed and the rest of ENGINE W-1). One event per move; deduplicated by (withdrawalId, seq).',
);

// ── The registry ─────────────────────────────────────────────────────────────

export const EVENT_CATALOG = {
  xpEarned,
  rankUpdated,
  userCreated,
  kycApproved,
  kycSubmitted,
  kycRejected,
  kycInfoRequested,
  securityFactorChanged,
  deathNoticeCreated,
  deathNoticeConfirmed,
  ledgerTxPosted,
  ledgerReconciliationFailed,
  ledgerReconciliationRunFailed,
  ledgerFreezeUpdated,
  coreOpsAlertRuleUpdated,
  coreOpsAlertOpened,
  coreOpsAlertResolved,
  coreOpsAlertPolicyUpdated,
  coreOpsAlertGroupOpened,
  coreOpsAlertGroupUpdated,
  coreOpsAlertGroupResolved,
  coreOpsReconciliationAlertOpened,
  coreOpsReconciliationAlertUpdated,
  coreOpsReconciliationAlertResolved,
  coreOpsReconciliationAlertAccepted,
  coreOpsComplianceCaseCreated,
  coreOpsComplianceInboxUpdated,
  coreOpsRestoreStarted,
  coreOpsRestoreCompleted,
  coreOpsRestoreFailed,
  payCustodyAuditCreated,
  payDepositCreditPosted,
  payWithdrawalStatusUpdated,
  stakeCreated,
  buybackExecuted,
  bankMarginCalled,
  supportTicketResolved,
  personalRequestCreated,
  personalRequestSettled,
  personalTransferPosted,
  personalRefundPosted,
  personalDisputeUpdated,
  bankScheduledReminder,
  bankScheduledFailed,
  blueprintCreated,
  blueprintDeleted,
  crewMemberCreated,
  orderAccepted,
  orderFilled,
  orderCancelled,
  orderTriggered,
  spreadFilled,
  orderUpdated,
  fillSettled,
  positionUpdated,
  protocolAccountCreated,
  protocolSessionKeyCreated,
  protocolSessionKeyCancelled,
  agentActionCompleted,
  agentActionRejected,
  agentUsageSettled,
  agentUsageAlertCrossed,
  p2pOfferCreated,
  p2pEscrowLocked,
  p2pEscrowReleased,
  p2pEscrowRefunded,
  p2pTradeDisputed,
  p2pDisputeResolved,
  p2pTradeExpired,
  p2pTradeFiatSent,
  p2pTradeReminderSent,
  p2pOfferPaused,
  p2pRemarkCaseOpened,
  p2pChatMessageSent,
  p2pDisputeEscalated,
  p2pQuoteExpired,
  copySkipped,
  copyFailed,
  copyStopped,
  projectionUpdated,
} as const;

export type EventCatalog = typeof EVENT_CATALOG;
export type EventName = keyof EventCatalog;
export type PayloadOf<K extends EventName> = z.infer<EventCatalog[K]['schema']>;

export const ALL_EVENTS: readonly EventDef[] = Object.values(EVENT_CATALOG);

export function eventBySubject(s: string): EventDef | undefined {
  return ALL_EVENTS.find((e) => e.subject === s);
}

// ── Declared wiring sockets ──────────────────────────────────────────────────

/**
 * AN EVENT WITH NO PUBLISHER, OR NO SUBSCRIBER — SAID OUT LOUD.
 *
 * The bus could not tell anyone that a declared subject had no producer, no
 * consumer, or a schema neither side agreed on. Three separate audits arrived
 * at the same shape from three directions, and every one of them found it by
 * accident:
 *
 *   · `bankMarginCalled` was a complete, correct event with a complete, correct
 *     consumer and NOTHING THAT PUBLISHED IT. svc-notify logged a warning about
 *     a consumer it could not attach on every boot since it shipped. CLOSED —
 *     svc-bank owns INTAFACED_BANK and publishes the call.
 *   · `xpEarned` was published by two services and read by none. The tracker
 *     called `p2p.reputation` done on the strength of it "feeding the same XP
 *     graph"; the graph was fed by a direct call and this stream was discarded.
 *     CLOSED — svc-identity subscribes (`subscribeXpEvents`), and the tracker
 *     row is now true rather than nearly true.
 *   · `orderFilled` lost account ids to a stale build, because `z.object()`
 *     strips unknown keys and says nothing.
 *
 * All three are kept here after the fact, because the SHAPE is what this list
 * exists for and every one of them was found by accident rather than on purpose.
 *
 * `tooling/ci/event-wiring.mjs` now reads the code and this list together, and
 * fails when they disagree. So the only two states an unwired event can be in
 * are: RECORDED HERE, with a reason a human wrote and a CLASS — or RED.
 *
 * THE RULES, because a socket list rots into a suppression list otherwise:
 *
 *   1. A reason names WHAT is missing and WHY it is acceptable today. "TODO",
 *      "later" and "not yet" are not reasons; the gate rejects a reason under
 *      40 characters for exactly that.
 *   2. Deleting the event is never how an entry leaves this list. An orphan is
 *      a finding — sometimes a deliberate socket waiting for its publisher, as
 *      `bankMarginCalled` is. Wiring it is how it leaves.
 *   3. `satisfies` below is load-bearing: an entry naming an event that does
 *      not exist is a compile error, so this list cannot outlive its catalog.
 *
 * Recorded here does NOT mean healthy — it means known, attributed, and
 * reviewable in one place. Read it as the bus's list of things it cannot do yet.
 */
/**
 * WHICH KIND OF UNWIRED THIS IS (ADR D-S-13, Accepted 2026-08-04).
 *
 * The eighteen entries below all carried a written reason, and the reasons were
 * candid to the point of shouting. They were also counted identically, so one
 * clean line covered both "the stream is a durable record ahead of its first
 * reader" and "a borrower is never told their loan is being margin-called".
 *
 * A WRITTEN REASON PROVES SOMEBODY THOUGHT ABOUT IT. IT DOES NOT PROVE THE
 * ANSWER WAS YES. The class is where the answer goes.
 *
 * The test is not "is there a consumer". It is: does anyone — user or operator —
 * currently hold a belief that the missing wiring would have to deliver?
 *
 *   A  Record ahead of its reader. Nothing depends on the consumer existing and
 *      nothing claims it does. A true socket, legitimate indefinitely; building
 *      the consumer later is additive.
 *
 *   B  A promise with no delivery. Something a user or operator can already
 *      observe is premised on the missing consumer. NOT a socket — a defect,
 *      accurately described in the register of a design note. `event-wiring`
 *      FAILS on one. It leaves by being wired, or by becoming C.
 *
 *   C  Owned and unbuilt, AND the gap is disclosed wherever a user could
 *      otherwise be misled. The disclosure has to exist IN CODE — a reason
 *      field claiming the gap is disclosed is not a disclosure.
 *
 * Descriptions state what the system is for; sockets state what is not built.
 * NEITHER IS EDITED TO MATCH THE OTHER, and neither is softened to make an
 * entry classify better. A reason that reads as a bug report is doing its job.
 */
export type SocketClass = 'A' | 'B' | 'C';

export interface WiringSocket {
  /** The catalog key. Checked against `EventName` by `satisfies`. */
  readonly event: EventName;
  /** Which end is missing. */
  readonly missing: 'publisher' | 'subscriber';
  /** A, B or C. Not optional — see `SocketClass`. The gate rejects an entry without one. */
  readonly class: SocketClass;
  /** Why that is acceptable today, and what would close it. */
  readonly reason: string;
}

export const WIRING_SOCKETS = [
  {
    event: 'deathNoticeCreated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No subscriber yet (RC-identity-02): the notice is a durable svc-identity row that staff read on the account; nothing else acts on an unconfirmed notice, and no customer is promised a notice of it.',
  },
  {
    event: 'deathNoticeConfirmed',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No subscriber yet (RC-identity-02): the freeze, session and API key revocation happen in the confirming transaction, and the recovery claim (RC-identity-08) asks identity for the confirmed notice when it runs, so nothing waits on the event.',
  },
  {
    event: 'kycSubmitted',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No subscriber yet: the review queue and /verification read the case table; no other service needs the event yet. svc-identity publishes it from the case history row after commit (I-kyc-compliance-01).',
  },
  {
    event: 'kycRejected',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No subscriber yet: svc-notify writes the reject notice with the reason and resubmit link in its own PR, so no mail is promised; the customer reads the reason and the resubmit action on /verification. svc-identity publishes it from the case history row after commit (I-kyc-compliance-01).',
  },
  {
    event: 'kycInfoRequested',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the I-kyc-compliance-01 events PR. svc-identity publishes it from an outbox row after the case transition commits (svc-identity PR, next). The case is a durable row that /verification and the compliance queue read.',
  },
  {
    event: 'kycInfoRequested',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No subscriber yet: svc-notify writes the information-request notice in its own PR. No publisher exists yet either, so no customer is promised a notice.',
  },
  {
    event: 'spreadFilled',
    missing: 'subscriber',
    /**
     * CLASS A. svc-trade consumes it with its spread place door and spread holds
     * (CB-otc-16, svc-trade half). Until that door exists nothing can place a
     * spread order, so no spread fill can exist without its consumer.
     */
    class: 'A',
    reason:
      'svc-trade subscribes when it gains the spread place door and spread holds; svc-matching only admits spread orders from svc-trade, so a fill cannot occur before its money consumer exists.',
  },
  // ── no publisher ───────────────────────────────────────────────────────────
  //
  // `bankMarginCalled` was here, and was the reason this section existed: a
  // complete event with a complete svc-notify consumer that parked on a stream
  // no service had ever created. svc-bank now owns `INTAFACED_BANK` and publishes
  // the call — see services/svc-bank/src/loans/margin-call-publisher.ts. That
  // entry left by being wired, not by being reworded.
  //
  // `buybackExecuted` is the current occupant. The catalog event stays; emitting
  // it from svc-token would claim a buy the ledger never posted.
  {
    event: 'projectionUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'Publisher waits on a non-zero INDEXER_VENUE_ADDRESS emitting the existing chain/evm/abi.ts surface (socket.clob-contracts). Zero venue / blank RPC is indexer.stream_unwired on the tRPC stream door — Chain.vue names that refuse. This subject is not a licence to invent a venue ABI. Empty deltas stay empty.',
  },
  {
    event: 'buybackExecuted',
    missing: 'publisher',
    /**
     * CLASS A. Nothing observes a buy that did not happen. svc-token
     * refuse-closes recordBuyback rather than emit; a buyback ledger-client
     * recipe PR owns the publisher. No user or operator surface is premised
     * on this subject firing.
     */
    class: 'A',
    reason:
      'Publisher waits on a buyback ledger recipe. svc-token refuse-closes recordBuyback with token.buyback_tokens_unmoved rather than emit buybackExecuted for a buy that did not happen — no existing ledger-client recipe books tokensBought (burn spends fee-funded engine; mintEmission prints supply). Nothing observes a buy that did not happen; the recipe PR owns the publisher.',
  },

  // ── no subscriber ──────────────────────────────────────────────────────────
  //
  // `xpEarned` was here, and was Class B: PUBLISHED INTO THE VOID by svc-p2p and
  // svc-trade, with the producers' idempotency keys already shaped to match
  // `identity.xp_events.idempotency_key` — a handshake with a consumer that did
  // not exist, while users earned XP that never counted. svc-identity now
  // subscribes (services/svc-identity/src/events.ts, `subscribeXpEvents`). The
  // entry is deleted rather than reworded: an entry leaves this list by being
  // wired, and a socket must not outlive the gap it describes.
  {
    event: 'userCreated',
    missing: 'subscriber',
    /**
     * CLASS A. Confirmed against the code, not just the reason: every module
     * that needs a user resolves it through packages/contracts under the caller's
     * own authority, so nothing is waiting on the announcement.
     */
    class: 'A',
    reason:
      "svc-identity announces that a sovereign account exists; no service reacts to the announcement today. Every module that needs a user resolves it through packages/contracts under the caller's own authority instead, so nothing is missing a fact it needs — the stream is a durable record ahead of its first reader.",
  },
  {
    event: 'ledgerTxPosted',
    missing: 'subscriber',
    /**
     * CLASS A. The reason states the test and passes it: "Nothing today derives
     * state from it, and nothing claims to." The hash chain and 90-day retention
     * mean a consumer built later replays from the start — additive, not owed.
     */
    class: 'A',
    reason:
      'THE money event, published by svc-ledger on every value movement, with no consumer in this repo. §10 asks for it to exist and be replayable, and it is: the stream retains 90 days and carries the hash chain, so an audit or read-model consumer can be built later and replay from the start. Nothing today derives state from it, and nothing claims to.',
  },
  {
    event: 'ledgerReconciliationFailed',
    missing: 'subscriber',
    /**
     * CLASS A. The freeze is performed in-process by svc-ledger; the event is the
     * external announcement, not the mechanism. Nothing is protected by the
     * consumer that does not exist.
     */
    class: 'A',
    reason:
      'svc-ledger publishes when snapshot and replay disagree, but the freeze it triggers is performed by svc-ledger itself in-process — the event is the external announcement, not the mechanism. It stays unconsumed until the alerting path (§4.2 "pages the operator") is built, and the freeze does not depend on that path existing.',
  },
  {
    event: 'coreOpsAlertRuleUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops publishes it once the alert rule store lands (OPS-alerts-01, next PR). Rule state is a durable versioned row, so nothing has to subscribe to stay correct; the audit trail and the admin list read the rows.',
  },
  {
    event: 'coreOpsAlertOpened',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops publishes it from the alert evaluator (OPS-alerts-01, next PR). The state is a durable row; the routing consumer that notifies staff is OPS-alerts-02, so there is no subscriber yet.',
  },
  {
    event: 'coreOpsAlertPolicyUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops writes it to ops.alert_outbox in the same transaction as the routing tree (OPS-alerts-02), like the other alert events. No relay drains that outbox onto the bus yet; the tree is the durable row the desk reads.',
  },
  {
    event: 'coreOpsAlertPolicyUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-ops writes the routing tree and this outbox row in one transaction (OPS-alerts-02). Nothing subscribes: the desk reads the stored tree. A later notifier can replay ops:alert-policy:<version>.',
  },
  {
    event: 'coreOpsAlertResolved',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops publishes it from the alert evaluator (OPS-alerts-01, next PR), closing the opened event with the same business key. Its routing consumer is OPS-alerts-02.',
  },
  {
    event: 'coreOpsAlertRuleUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'Nothing needs to react to a rule change: the rule store is a durable versioned row and the admin list reads it. The subject exists so the audit trail and a later routing consumer (OPS-alerts-02) can follow without polling.',
  },
  {
    event: 'coreOpsAlertOpened',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The routing consumer that tells staff is OPS-alerts-02 and does not exist yet. The alert is a durable row that /alerts lists, so nothing is promised to anyone by this event today.',
  },
  {
    event: 'coreOpsAlertResolved',
    missing: 'subscriber',
    class: 'A',
    reason:
      'Same as the opened event: the resolving consumer is OPS-alerts-02. The alert row carries the resolved state, which /alerts reads.',
  },
  {
    event: 'coreOpsAlertGroupOpened',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the OPS-oncall-01 events PR. svc-ops publishes it when the alert group store lands (svc-ops PR, next). The group is a durable row that /oncall reads.',
  },
  {
    event: 'coreOpsAlertGroupOpened',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The escalation runner lives inside svc-ops and reads the stored group; no other service needs the event yet. Nothing pages anyone on main today, so no one is promised a page by it.',
  },
  {
    event: 'coreOpsAlertGroupUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the OPS-oncall-01 events PR. svc-ops publishes it when the alert group store lands (svc-ops PR, next). The group is a durable row that /oncall reads.',
  },
  {
    event: 'coreOpsAlertGroupUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The escalation runner lives inside svc-ops and reads the stored group; no other service needs the event yet. Nothing pages anyone on main today, so no one is promised a page by it.',
  },
  {
    event: 'coreOpsAlertGroupResolved',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the OPS-oncall-01 events PR. svc-ops publishes it when the alert group store lands (svc-ops PR, next). The group is a durable row that /oncall reads.',
  },
  {
    event: 'coreOpsAlertGroupResolved',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The escalation runner lives inside svc-ops and reads the stored group; no other service needs the event yet. Nothing pages anyone on main today, so no one is promised a page by it.',
  },
  {
    event: 'coreOpsReconciliationAlertOpened',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No other service needs it yet: the alert is a durable svc-ops row that /alerts reads, and nothing outside svc-ops is promised a reaction. The subject exists so audit and a later consumer can follow without polling.',
  },
  {
    event: 'coreOpsReconciliationAlertUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No other service needs it yet: the alert is a durable svc-ops row that /alerts reads, and nothing outside svc-ops is promised a reaction. The subject exists so audit and a later consumer can follow without polling.',
  },
  {
    event: 'coreOpsReconciliationAlertResolved',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No other service needs it yet: the alert is a durable svc-ops row that /alerts reads, and nothing outside svc-ops is promised a reaction. The subject exists so audit and a later consumer can follow without polling.',
  },
  {
    event: 'coreOpsReconciliationAlertAccepted',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No other service needs it yet: the alert is a durable svc-ops row that /alerts reads, and nothing outside svc-ops is promised a reaction. The subject exists so audit and a later consumer can follow without polling.',
  },
  {
    event: 'coreOpsComplianceCaseCreated',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops publishes it when the case store lands (OPS-cases-01, next PR). A case is a durable row that the inbox list reads, so nothing depends on the event existing yet.',
  },
  {
    event: 'coreOpsComplianceInboxUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops publishes it when an inbox is defined or favourited (OPS-cases-01, next PR). The inbox is a durable versioned row that the case list reads.',
  },
  {
    event: 'coreOpsComplianceCaseCreated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No consumer is owed: the case is a durable row and the admin inbox reads it. The subject exists so a later routing or notification consumer can follow without polling.',
  },
  {
    event: 'coreOpsComplianceInboxUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No consumer is owed: the inbox definition is a durable row. The subject exists so the audit trail and a later consumer can follow without polling.',
  },
  {
    event: 'coreOpsRestoreStarted',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops writes the restore step rows first and publishes this event once its bus is wired. The restore record is the durable truth that /restore reads, so nothing depends on the event existing yet.',
  },
  {
    event: 'coreOpsRestoreStarted',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No consumer is owed: the restore record is durable and the admin /restore room reads it. The subject exists so the audit trail and a later notice can follow without polling.',
  },
  {
    event: 'coreOpsRestoreCompleted',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops writes the restore step rows first and publishes this event once its bus is wired. The restore record is the durable truth that /restore reads, so nothing depends on the event existing yet.',
  },
  {
    event: 'coreOpsRestoreCompleted',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No consumer is owed: the restore record is durable and the admin /restore room reads it. The subject exists so the audit trail and a later notice can follow without polling.',
  },
  {
    event: 'coreOpsRestoreFailed',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-ops writes the restore step rows first and publishes this event once its bus is wired. The restore record is the durable truth that /restore reads, so nothing depends on the event existing yet.',
  },
  {
    event: 'coreOpsRestoreFailed',
    missing: 'subscriber',
    class: 'A',
    reason:
      'No consumer is owed: the restore record is durable and the admin /restore room reads it. The subject exists so the audit trail and a later notice can follow without polling.',
  },
  {
    event: 'projectionUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'NATS fan-out is unbuilt until a venue emits. svc-ws ingestIndexerStream applies market-data deltas or no-ops indexer.stream_unwired — it does not subscribe this subject. Chain.vue reads tRPC stream and names indexer.stream_unwired. Empty stays empty; no invented book.',
  },
  {
    event: 'buybackExecuted',
    missing: 'subscriber',
    /**
     * CLASS A. Nothing is waiting on the announcement. The publisher itself
     * is a socket (no buyback recipe in ledger-client); no consumer is
     * load-bearing.
     */
    class: 'A',
    reason:
      "No service consumes buybackExecuted. The flywheel it would describe is not a live buy — svc-token refuse-closes until a buyback ledger recipe exists — so no consumer is load-bearing; the subject exists so the public burn record (§17.3) can be built from the stream rather than from a query against another service's tables.",
  },
  {
    event: 'crewMemberCreated',
    missing: 'subscriber',
    /**
     * CLASS B, and the one an agent cannot close. RESTORED — it should never have
     * left, and how it left is why this comment is longer than the entry.
     *
     * This entry was DELETED by e1b95844 on the strength of two new files,
     * `svc-academy/src/crew-events.ts` and `svc-agents/src/crew-events.ts`, each
     * exporting a `subscribeCrewMemberCreated` that calls `bus.subscribe`. The
     * wiring gate scanned for the TEXT of a subscribe call, found two, and agreed
     * the gap had closed. Class B count went to zero and the build went green.
     *
     * NEITHER SUBSCRIBER HAS EVER RUN. Nothing imports either file except its own
     * unit test. `svc-academy/src/index.ts` states in its own header that the
     * service has NO BUS CONNECTION AT ALL, so even mounting the import would not
     * give the handler anything to attach to. `svc-agents/src/index.ts` does
     * connect to NATS and never calls `subscribeCrewMemberCreated`. Both handlers
     * write to a process-local `Map`. The described behaviour — a lobby route, a
     * crew channel — is exactly as absent as before the commit that claimed to
     * deliver it, and for a while the event was neither wired NOR recorded here:
     * invisible to the check built to see it, which is strictly worse than the
     * honest entry it replaced.
     *
     * `docs/TRACKER.md` never stopped saying this event "has no consumer yet". The
     * docs and the runtime agreed the whole time; only the catalog and the gate
     * disagreed.
     *
     * Not reclassifiable to C by an agent: C requires the gap disclosed in code at
     * every surface a user could be misled by, and ADR D-S-13 puts these two
     * consumers on the owner ("services with their own scope questions"). It stays
     * B until the owner rules. Deliberately not softened — and note that softening
     * is not the only way to lose a finding: this one was lost to code that looked
     * like a fix.
     */
    class: 'B',
    reason:
      'The description above names two consumers — "svc-academy routes the lobby, svc-agents opens the crew channel" — and NEITHER RUNS. Each service now has a crew-events.ts exporting subscribeCrewMemberCreated, and nothing imports either one outside its own unit test: svc-academy builds no bus at all (its index.ts says so in as many words), and svc-agents builds one and never calls the subscriber. A defined handler is not a mounted handler. Recorded rather than reworded: the description is the specification those two services owe, and deleting this entry because a subscribe call exists on disk is how the requirement went missing once already.',
  },
  {
    event: 'orderAccepted',
    missing: 'subscriber',
    /**
     * CLASS A. "Genuinely nothing to do with it today": acceptance moves no money,
     * releases no hold, and svc-trade already knows it submitted the order.
     */
    class: 'A',
    reason:
      "svc-matching announces admission to the book; svc-trade consumes only orderFilled and orderCancelled, because acceptance moves no money and releases no hold, and svc-trade already knows it submitted the order. svc-ws publishes book depth from the engine's own snapshots rather than by replaying acceptances. Genuinely nothing to do with it today.",
  },
  {
    event: 'protocolAccountCreated',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR. Checked: the only Protocol Plane
     * surface in the repo (apps/web protocol-plane.tsx) calls exactly two things,
     * protocol.health and protocol.predictAddress, neither of which is derived
     * from this stream; account linkage is read from protocol.smart_accounts
     * through a scoped procedure. No user or operator holds a belief this would
     * have to deliver.
     */
    class: 'A',
    reason:
      "Protocol Plane events are OBSERVATIONS of chain state (§17.4) — the account exists on chain whether or not anything here reads the announcement, and the platform holds no key to it either way. svc-identity links an account through packages/contracts under the user's own authority, not off this stream. Unconsumed by design, not by omission.",
  },
  {
    event: 'protocolSessionKeyCreated',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR. Nothing may consume it, which is
     * stronger than nothing does: a consumer caching session-key scope would be a
     * second, weaker copy of an authority that lives on chain (§16.10). svc-agents
     * has no session-key concept and no chain client at all.
     */
    class: 'A',
    reason:
      'Same shape as protocolAccountCreated: an observation of a grant that is already enforced by the smart account itself. Nothing here may act on it, because a consumer that cached session-key scope would be a second, weaker copy of an authority that lives on chain (§16.10).',
  },
  {
    event: 'protocolSessionKeyCancelled',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR, and the closest call of the nine.
     *
     * The DESCRIPTION above reads "Consumers stop routing agent execution through
     * it", in the present indicative, which is the shape that makes crewMemberCreated
     * a Class B. The difference is who could believe it. There is no agent-routing
     * surface: svc-agents has no session-key concept, no chain client, and does not
     * own tool execution. And doctrine says the consumer should never exist — the
     * revocation binds on chain the moment it is mined, and any future surface must
     * re-read the chain rather than trust this stream. So it is not an owed spec
     * waiting on a service; it is a sentence that outran its own doctrine.
     *
     * Left EXACTLY as written. Editing a description to make a socket classify
     * better is the one move ADR D-S-13 rules out by name.
     */
    class: 'A',
    reason:
      'The revocation is effective on chain the moment it is mined; a consumer would only ever be catching up with a fact that is already binding. It stays unconsumed until there is an agent-routing surface that needs to stop sending — and that surface must re-read the chain anyway rather than trust this stream.',
  },
  {
    event: 'agentUsageSettled',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR. Spend totals shown to a user come
     * from SUM over agents.usage_records, re-priced with the rates settlement uses,
     * and the ledger post precedes this publish. A consumer accumulating these
     * amounts would be a balance outside packages/ledger-client (§0.6) — so the
     * absence is required, not merely tolerated.
     */
    class: 'A',
    reason:
      'The ledger post has already happened when this is published, and it carries the chargeKey precisely so reconciliation can be done against the ledger rather than by accumulating this stream. A consumer that added up these amounts would be a balance outside packages/ledger-client (§0.6), so the absence here is deliberate.',
  },
  {
    event: 'agentUsageAlertCrossed',
    missing: 'subscriber',
    /**
     * CLASS C — owned and unbuilt, disclosed. svc-notify's consumer, which writes the person's one inbox row per
     * alert key, lands in its own PR after this subject. Until then the agent's Limits page says in its alert form
     * that the inbox note is not delivered yet (`agents.usage.alert_inbox_unwired`), so no one is told to expect it.
     */
    class: 'C',
    reason:
      'svc-agents records and publishes the alert once per agent and month on its business key; the svc-notify consumer that turns it into one inbox row per key is the next PR (J-agents-02 #6). The Limits page discloses the gap in code until it lands.',
  },
  {
    event: 'p2pOfferCreated',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR. Every offer surface reads
     * p2p.offers directly through offers.list/offers.get; there is no index,
     * projection or cache anywhere. The shell states in user-facing copy that it
     * has no live channel and the reader must refresh, so no user is promised a
     * feed this stream would have to feed.
     */
    class: 'A',
    reason:
      "The offer book is served from svc-p2p's own tables through packages/contracts; a consumer would be a second copy of a list its owner already answers for. The subject exists so a future search or feed index can be built from the stream instead of reading svc-p2p's tables directly (§2).",
  },
  {
    event: 'p2pDisputeResolved',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR, and this one needed checking
     * rather than reading. A missing notification is exactly where a promise hides.
     * It is not one: packages/i18n has no notify.p2p.dispute.resolved.* key, notify
     * has no notification-type enum and no per-type preference screen anywhere, and
     * svc-notify's README lists the nine subjects it consumes without claiming this
     * one. The escrow movement is separately published as p2pEscrowReleased /
     * p2pEscrowRefunded, which name both parties and ARE fanned out — so both sides
     * are told what happened to their money.
     */
    class: 'A',
    reason:
      "Deliberately NOT fanned out: svc-notify's wiring notes that this payload carries a moderatorId (which may be the system principal `system:p2p-backstop`) and no party ids, so there is no user to notify without inventing one. The escrow movement itself is published separately as p2pEscrowReleased / p2pEscrowRefunded, which do name both sides and ARE consumed.",
  },
  {
    event: 'p2pTradeExpired',
    missing: 'subscriber',
    /**
     * CLASS A — classified here, not by the ADR. Same check, same answer: no i18n
     * key, no declared notification type, no preference surface, and the outcome is
     * also published on a subject that carries both parties and is consumed. The
     * payload names a trade and an outcome, not a user, so a consumer could not
     * address a notification from it without inventing a recipient.
     */
    class: 'A',
    reason:
      "Same reason as p2pDisputeResolved and recorded in svc-notify's wiring comment: the payload names a trade and an outcome, not a user, so nothing can address a notification from it. The outcome it reports is also published on a subject that does carry both parties, so no user-visible fact depends on a consumer here.",
  },
  {
    event: 'personalRefundPosted',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the PP-send-request-18 events PR. svc-bank publishes it through its outbox in the same transaction as the state change (svc-bank PR, next). Money state never waits on it.',
  },
  {
    event: 'personalRefundPosted',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify writes the refund notice in the PP-send-request-18 svc-notify PR, idempotent by event id. No publisher exists yet, so no user is promised a receipt by this event today.',
  },
  {
    event: 'personalDisputeUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the PP-send-request-18 events PR. svc-bank publishes it through its outbox in the same transaction as the state change (svc-bank PR, next). Money state never waits on it.',
  },
  {
    event: 'personalDisputeUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify writes the dispute-status notice in the PP-send-request-18 svc-notify PR, idempotent by event id. No publisher exists yet, so no user is promised a receipt by this event today.',
  },
  {
    event: 'p2pChatMessageSent',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the P-trade-orders-23 events PR. svc-p2p publishes it through its outbox in the same transaction as the state change (svc-p2p PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'p2pChatMessageSent',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the chat-waiting notice in the P-trade-orders-23 svc-notify PR, idempotent by event id. Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'p2pTradeReminderSent',
    missing: 'subscriber',
    class: 'A',
    reason:
      "svc-p2p publishes it from its reminder outbox (P-trade-orders-15, J-p2p-02 #2), and the seller sees the reminder on the order itself. svc-notify turns it into the seller's inbox notice in its own PR, idempotent by tradeId and n; until then no inbox notice is promised.",
  },
  {
    event: 'p2pDisputeEscalated',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the P-trade-orders-23 events PR. svc-p2p publishes it through its outbox in the same transaction as the state change (svc-p2p PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'p2pDisputeEscalated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the appeal-status notice to both parties in the P-trade-orders-23 svc-notify PR, idempotent by event id. Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'p2pQuoteExpired',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the P-trade-orders-23 events PR. svc-p2p publishes it through its outbox in the same transaction as the state change (svc-p2p PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'p2pQuoteExpired',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the re-quote notice in the P-trade-orders-23 svc-notify PR, idempotent by event id. Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'copySkipped',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the J-copy-bots-otc-03 events PR. svc-trade publishes it after the skip row commits (svc-trade PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'copySkipped',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the copy skip notice in the J-copy-bots-otc-03 svc-notify change, idempotent on (followId, leaderFillId). Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'copyFailed',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the J-copy-bots-otc-03 events PR. svc-trade publishes it after the failure row commits (svc-trade PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'copyFailed',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the copy failure notice in the J-copy-bots-otc-03 svc-notify change, idempotent on (followId, leaderFillId). Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'copyStopped',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the J-copy-bots-otc-03 events PR. svc-trade publishes it after the stop row commits (svc-trade PR, next). Nothing reads it yet, so nothing is waiting on it.',
  },
  {
    event: 'copyStopped',
    missing: 'subscriber',
    class: 'A',
    reason:
      'svc-notify turns it into the copy stop notice in the J-copy-bots-otc-03 svc-notify change, idempotent on (followId, closeOnly). Until then no publisher exists either, so no user is promised a notice.',
  },
  {
    event: 'payCustodyAuditCreated',
    missing: 'publisher',
    class: 'A',
    reason:
      'svc-pay publishes it from its outbox when the audit producers land (W-security-accounts-05, service PR). The entry is a durable row keyed by entryKey, so nothing depends on the event existing yet.',
  },
  {
    event: 'payCustodyAuditCreated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The append-only audit store that /custody-ops reads subscribes in the service PR for W-security-accounts-05. Producers keep the entry as a durable row first, so an entry published before its consumer exists is replayed, not lost.',
  },
  {
    event: 'payWithdrawalStatusUpdated',
    missing: 'publisher',
    class: 'A',
    reason:
      'Declared by the W-withdraw-06 events PR. svc-pay publishes one per move from its outbox in the W-withdraw-06 service PR, next. The withdrawal row is the record, so nothing depends on the event existing yet.',
  },
  {
    event: 'payWithdrawalStatusUpdated',
    missing: 'subscriber',
    class: 'A',
    reason:
      'The customer notice of a withdrawal move subscribes in a later svc-notify change, idempotent on (withdrawalId, seq). The customer reads the status from svc-pay meanwhile, so nobody is promised a notice.',
  },
] satisfies readonly WiringSocket[];

/** The recorded reason a given end of an event is unwired, or null if none. */
export function wiringSocketReason(event: EventName, missing: 'publisher' | 'subscriber'): string | null {
  return WIRING_SOCKETS.find((s) => s.event === event && s.missing === missing)?.reason ?? null;
}
