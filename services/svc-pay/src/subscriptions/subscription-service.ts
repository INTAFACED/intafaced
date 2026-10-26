import type { Sql } from 'postgres';
import { assertCollectionMethodAvailable, collectionMethodOf, type CollectionMethod } from './merchant-disp-bill-rep-collection-method.js';
import { transaction } from '@intafaced/db';
import { fingerprintRequest } from '../rest-idempotency.js';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import {
  PayError,
  assertCycleListLimit,
  assertDueSubscriptionsBatchLimit,
  assertExecutionListLimit,
  assertMandateListLimit,
  assertSubscriptionListLimit,
} from '../payment-service.js';
import { encodeListCursor, ListQueryError, parseListFilters } from '../list-page.js';
import { merchantKybMoneyGateRefusal, type MerchantKybStatus } from '../merchant-kyb-money-gate.js';
import type { ValueMovementPolicy } from '../rails/posture.js';
import { CADENCES, occurrenceStart, type Cadence } from './schedule.js';
import { subscriptionPrice } from './subscription-price.js';
import {
  MAX_ATTEMPTS_PER_CYCLE,
  assertWithinMandateCeiling,
  assertWithinMandateWindow,
  chargeIdempotencyKey,
  invoiceExpiredAt,
  lastAuthorisedOccurrence,
  occurrenceDueAt,
  planChargeCycle,
  projectReAnchor,
  resolveSubscriptionFeeBps,
  retryDueAt,
  type CycleFrame,
  type LastCycle,
  type StallReason,
} from './charge-cycle.js';
import {
  assertChargeTracesToMandate,
  assertPrechargeNotifyUnpublished,
  mandateChargeDisposition,
  normaliseSubscriptionPath,
  recordPreChargeNotifyAttempt,
  SUBSCRIPTION_PATHS,
  type SubscriptionPath,
  type SubscriptionPreChargeNotify,
} from './mandate-product.js';

export { normaliseSubscriptionPath, SUBSCRIPTION_PATHS, type SubscriptionPath };

/** Same cap as the public REST Idempotency-Key. Not a new product limit. */
const SUBSCRIPTION_CREATE_KEY_MAX = 255;

/**
 * Blank and oversized keys refuse before any row is written. Undefined means
 * the caller sent no key; the mandate unique index still applies.
 */
function subscriptionCreateKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim();
  if (!key || key.length > SUBSCRIPTION_CREATE_KEY_MAX) {
    throw new PayError('Idempotency-Key must be 1 to 255 characters. Nothing was written.', 'pay.idempotency_required');
  }
  return key;
}

function subscriptionCreateFingerprint(mandateId: string, path: string | undefined, priceId: string | undefined): string {
  return fingerprintRequest('POST', 'subscription.create', {
    mandateId: mandateId.toLowerCase(),
    path: normaliseSubscriptionPath(path),
    // Only when one is named, so a create without a price keeps the fingerprint it always had.
    ...(priceId ? { priceId: priceId.toLowerCase() } : {}),
  });
}

function openMandateIndexViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const row = err as { code?: string; constraint_name?: string };
  return row.code === '23505' && row.constraint_name === 'subscriptions_one_open_per_mandate_uq';
}

/**
 * SUBSCRIPTION LIFECYCLE AND CHARGE CYCLE (SPEC §4).
 *
 * Lifecycle: create / pause / resume / cancel, and re-consent refuse.
 * Cycle: due → attempt → outcome, one period at a time, keyed by the period.
 *
 * The rulings this obeys, and why, are argued in `charge-cycle.ts`. Two are
 * worth repeating at the call site because they are the ones a well-meaning
 * change breaks:
 *
 *  - **At most one charge per subscription per pass.** A late period re-anchors
 *    the schedule instead of firing back-to-back
 *    (`adr/2026-08-08-twap-overdue-slice-disposition.md`).
 *  - **An unsettled period blocks the next one** and is retried under the SAME
 *    business key, then stalls with a named reason
 *    (`adr/2026-08-05-futures-risk-and-mark-law.md` §Funding).
 *
 * NO LEDGER POSTS HERE. Doctrine §0.6: the crypto path opens an invoice through
 * `PayService` and the capture settles it; value moves through
 * `packages/ledger-client` recipes owned by `PayService`, and this service never
 * holds a balance or posts one. The card path has no charge-against-mandate
 * operation on the rail port at all, so it refuses by name.
 */

export type MandateStatus = 'active' | 'cancelled' | 'expired';
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled' | 'completed';

export interface MandateRecord {
  id: string;
  merchantId: string;
  customerId: string;
  assetId: string;
  amount: Amount;
  ceiling: Amount | null;
  cadence: Cadence;
  startsAt: Date;
  endsAt: Date | null;
  railAdapter: string | null;
  railMandateRef: string | null;
  status: MandateStatus;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface SubscriptionRecord {
  id: string;
  mandateId: string;
  merchantId: string;
  customerId: string;
  nextRunAt: Date;
  status: SubscriptionStatus;
  cancelledAt: Date | null;
  path: string;
  createdAt: Date;
  /** Current schedule anchor. `null` = the mandate's own `startsAt`. */
  anchorAt: Date | null;
  anchorOccurrence: number;
  pausedAt: Date | null;
  resumedAt: Date | null;
  stalledAt: Date | null;
  /** Why it stopped advancing. An operator pause and an outage are not the same fact. */
  stallReason: StallReason | null;
  /** The catalogue price it was started on, kept for its whole life; null when it was started from a mandate alone. */
  priceId: string | null;
}

/** One period of one subscription, as recorded. */
export interface CycleRecord {
  occurrence: number;
  amount: Amount;
  status: 'pending' | 'invoiced' | 'settled' | 'rejected' | 'skipped';
  idempotencyKey: string | null;
  attemptCount: number;
  rejectionCode: string | null;
  paymentId: string | null;
  exhaustedAt: Date | null;
  settledAt: Date | null;
  lastAttemptAt: Date | null;
  notifyStatus: 'attempted' | 'skipped_unwired' | 'failed' | null;
  notifyCode: string | null;
}

/** Merchant-facing firing history row (router `listExecutions`). */
export type ExecutionStatus = CycleRecord['status'];
export interface ExecutionRecord {
  id: string;
  subscriptionId: string;
  occurrence: number;
  amount: Amount;
  status: ExecutionStatus;
  paymentId: string | null;
  rejectionCode: string | null;
  attemptedAt: Date;
  settledAt: Date | null;
  createdAt: Date;
  notifyStatus: CycleRecord['notifyStatus'];
  notifyCode: string | null;
}

interface MandateRow {
  id: string;
  merchant_id: string;
  customer_id: string;
  asset_id: string;
  amount: string;
  ceiling: string | null;
  cadence: Cadence;
  starts_at: Date;
  ends_at: Date | null;
  rail_adapter: string | null;
  rail_mandate_ref: string | null;
  status: MandateStatus;
  cancelled_at: Date | null;
  created_at: Date;
}

interface SubRow {
  id: string;
  mandate_id: string;
  merchant_id: string;
  customer_id: string;
  next_run_at: Date;
  status: SubscriptionStatus;
  cancelled_at: Date | null;
  path: string;
  created_at: Date;
  anchor_at: Date | null;
  anchor_occurrence: number;
  paused_at: Date | null;
  resumed_at: Date | null;
  stalled_at: Date | null;
  stall_reason: StallReason | null;
  /** Absent on rows read by a column list that predates it; read as no price. */
  price_id?: string | null;
}

interface CycleRow {
  occurrence: number;
  amount: string;
  status: CycleRecord['status'];
  idempotency_key: string | null;
  attempt_count: number;
  rejection_code: string | null;
  payment_id: string | null;
  exhausted_at: Date | null;
  settled_at: Date | null;
  last_attempt_at: Date | null;
  notify_status: CycleRecord['notifyStatus'];
  notify_code: string | null;
}

function toMandate(r: MandateRow): MandateRecord {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    customerId: r.customer_id,
    assetId: r.asset_id,
    amount: parseAmount(r.amount),
    ceiling: r.ceiling === null ? null : parseAmount(r.ceiling),
    cadence: r.cadence,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    railAdapter: r.rail_adapter,
    railMandateRef: r.rail_mandate_ref,
    status: r.status,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
  };
}

function toSub(r: SubRow): SubscriptionRecord {
  return {
    id: r.id,
    mandateId: r.mandate_id,
    merchantId: r.merchant_id,
    customerId: r.customer_id,
    nextRunAt: r.next_run_at,
    status: r.status,
    cancelledAt: r.cancelled_at,
    path: r.path,
    createdAt: r.created_at,
    anchorAt: r.anchor_at,
    anchorOccurrence: Number(r.anchor_occurrence ?? 0),
    pausedAt: r.paused_at,
    resumedAt: r.resumed_at,
    stalledAt: r.stalled_at,
    stallReason: r.stall_reason,
    priceId: r.price_id ?? null,
  };
}

function toCycle(r: CycleRow): CycleRecord {
  return {
    occurrence: Number(r.occurrence),
    amount: parseAmount(r.amount),
    status: r.status,
    idempotencyKey: r.idempotency_key,
    attemptCount: Number(r.attempt_count ?? 1),
    rejectionCode: r.rejection_code,
    paymentId: r.payment_id,
    exhaustedAt: r.exhausted_at,
    settledAt: r.settled_at,
    lastAttemptAt: r.last_attempt_at,
    notifyStatus: r.notify_status ?? null,
    notifyCode: r.notify_code ?? null,
  };
}

/**
 * Raising amount or ceiling requires a NEW mandate (re-consent). Equality or
 * lowering is allowed only by creating a new mandate too — this helper is the
 * refuse path when a caller tries to mutate an existing mandate's money terms.
 */
export function assertMandateTermsUnchanged(
  existing: { amount: Amount; ceiling: Amount | null },
  proposed: { amount: Amount; ceiling: Amount | null },
): void {
  if (proposed.amount !== existing.amount) {
    throw new PayError(
      'Raising or changing the authorised amount requires a new mandate (re-consent)',
      'pay.subscription_reconsent_required',
    );
  }
  if (proposed.ceiling !== existing.ceiling) {
    throw new PayError('Changing the authorised ceiling requires a new mandate (re-consent)', 'pay.subscription_reconsent_required');
  }
}

/**
 * Opens a payment/invoice for one occurrence. Crypto path uses this (never pull).
 * Injected so the runner does not hard-wire PayService and tests stay light.
 *
 * `idempotencyKey` is the BUSINESS key for the period. It is passed so the money
 * path can dedupe on the period rather than on the attempt; nothing derived from
 * a clock or a random source may be substituted for it.
 */
export type SubscriptionInvoiceOpener = (input: {
  merchantId: string;
  customerId: string;
  amount: Amount;
  assetId: string;
  subscriptionId: string;
  occurrence: number;
  idempotencyKey: string;
}) => Promise<{ paymentId: string }>;

/** Resolves the merchant's own published fee rate, or undefined if it has none. */
export type MerchantFeeBpsResolver = (merchantId: string) => Promise<number | undefined>;

export interface SubscriptionServiceOptions {
  /**
   * Platform default fee rate. Unset means unset — a subscription on a merchant
   * with no published rate refuses to charge rather than charging at zero.
   */
  readonly defaultFeeBps?: number | null;
  readonly resolveMerchantFeeBps?: MerchantFeeBpsResolver;
  /** Same posture as PayService — rejected KYB cannot open a mandate. */
  readonly valueMovement?: ValueMovementPolicy;
  /**
   * Pre-charge notify (SPEC §4). Same idea as PayService.afterPaymentEvent.
   * Absent → write notifyStatus skipped_unwired, never pretend the user was messaged.
   */
  readonly notifyPreCharge?: SubscriptionPreChargeNotify;
}

export type FiringOutcome = 'invoiced' | 'rejected' | 'already-fired' | 'skipped';

/** What one pass did to one subscription. */
export type CycleOutcome =
  'invoiced' | 'settled' | 'rejected' | 'retried' | 'blocked' | 'stalled' | 'completed' | 'idle' | 'already-fired' | 'skipped';

export interface RunReport {
  examined: number;
  /** Periods charged for the first time this pass. */
  fired: number;
  /** Periods re-attempted this pass under their existing key. */
  retried: number;
  /** Subscriptions that stopped advancing this pass, with the reason. */
  stalled: number;
  outcomes: Array<{
    subscriptionId: string;
    occurrence: number | null;
    outcome: CycleOutcome;
    rejectionCode?: string;
    stallReason?: StallReason;
    /**
     * Named pre-charge notify outcome when an invoice opened.
     * skipped_unwired / failed never look like the user was messaged.
     */
    noticeCode?: string;
    notifyStatus?: 'attempted' | 'skipped_unwired' | 'failed';
    /** The business key the period was charged under. Never per-attempt. */
    idempotencyKey?: string;
    /** Whole intervals the period was late by. `>= 1` means the frame moved. */
    lateIntervals?: number;
  }>;
}

export class SubscriptionService {
  private readonly defaultFeeBps: number | null | undefined;
  private readonly resolveMerchantFeeBps: MerchantFeeBpsResolver | undefined;
  private readonly valueMovement: ValueMovementPolicy;
  private readonly notifyPreCharge: SubscriptionPreChargeNotify | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
    /**
     * Opens invoices for `crypto_invoice` path. Absent → refuse-closed on fire
     * (`pay.subscription_driver_absent`), never silent skip.
     */
    private readonly openInvoice?: SubscriptionInvoiceOpener,
    options: SubscriptionServiceOptions = {},
  ) {
    this.defaultFeeBps = options.defaultFeeBps;
    this.resolveMerchantFeeBps = options.resolveMerchantFeeBps;
    this.valueMovement = options.valueMovement ?? 'allow-sandbox';
    this.notifyPreCharge = options.notifyPreCharge;
  }

  async createMandate(input: {
    merchantId: string;
    customerId: string;
    assetId: string;
    amount: Amount;
    ceiling?: Amount | null;
    cadence: Cadence;
    startsAt: Date;
    endsAt?: Date | null;
    railAdapter?: string | null;
    railMandateRef?: string | null;
    path?: string;
  }): Promise<MandateRecord> {
    if (input.amount <= 0n) throw new PayError('Mandate amount must be positive', 'pay.invalid_amount');
    if (!CADENCES.includes(input.cadence)) {
      throw new PayError(`Unknown cadence ${input.cadence}`, 'pay.subscription_invalid');
    }
    const ceiling = input.ceiling ?? null;
    if (ceiling !== null && ceiling < input.amount) {
      throw new PayError('Mandate ceiling must be >= amount', 'pay.subscription_invalid');
    }
    const endsAt = input.endsAt ?? null;
    if (endsAt !== null && endsAt.getTime() <= input.startsAt.getTime()) {
      throw new PayError('Mandate endsAt must be after startsAt', 'pay.subscription_invalid');
    }

    const m = await this.requireMerchant(input.merchantId);
    this.assertMerchantMayOpenMoney(m);

    const rows = await this.sql<MandateRow[]>`
      INSERT INTO pay.subscription_mandates (
        merchant_id, customer_id, asset_id, amount, ceiling, cadence,
        starts_at, ends_at, rail_adapter, rail_mandate_ref, status
      ) VALUES (
        ${input.merchantId}, ${input.customerId}, ${input.assetId},
        ${formatAmount(input.amount)}::numeric,
        ${ceiling === null ? null : formatAmount(ceiling)}::numeric,
        ${input.cadence},
        ${input.startsAt}, ${endsAt},
        ${input.railAdapter ?? null}, ${input.railMandateRef ?? null},
        'active'
      )
      RETURNING id, merchant_id, customer_id, asset_id, amount::text, ceiling::text,
                cadence, starts_at, ends_at, rail_adapter, rail_mandate_ref,
                status, cancelled_at, created_at
    `;
    return toMandate(rows[0]!);
  }

  async getMandate(mandateId: string): Promise<MandateRecord> {
    const rows = await this.sql<MandateRow[]>`
      SELECT id, merchant_id, customer_id, asset_id, amount::text, ceiling::text,
             cadence, starts_at, ends_at, rail_adapter, rail_mandate_ref,
             status, cancelled_at, created_at
        FROM pay.subscription_mandates WHERE id = ${mandateId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Mandate ${mandateId} not found`, 'pay.mandate_not_found');
    return toMandate(row);
  }

  /**
   * Create a subscription from an active mandate. nextRunAt = occurrence 0
   * start (or startsAt itself). The anchor starts as the mandate's own start —
   * stored as NULL, which means exactly that and needs no backfill.
   *
   * `idempotencyKey` is the caller's Idempotency-Key. Same key and same body
   * returns the original subscription. Same key and a different body refuses.
   * With or without a key, a mandate keeps at most one subscription that is
   * not cancelled and not completed. The partial unique index is the race
   * backstop; the mandate row lock makes the second caller see the first.
   */
  async createSubscription(input: {
    mandateId: string;
    path?: string;
    idempotencyKey?: string;
    /** A catalogue price to start it on: a monthly fixed price of the mandate's business with the mandate's terms. */
    priceId?: string;
  }): Promise<SubscriptionRecord> {
    const idempotencyKey = subscriptionCreateKey(input.idempotencyKey);
    const mandate = await this.getMandate(input.mandateId);
    const fingerprint = subscriptionCreateFingerprint(mandate.id, input.path, input.priceId);

    return transaction(this.sql, async (tx) => {
      const lockedRows = await tx<Array<{ status: MandateStatus; merchant_id: string }>>`
        SELECT status, merchant_id
          FROM pay.subscription_mandates
         WHERE id = ${mandate.id}
         FOR UPDATE
      `;
      const locked = lockedRows[0];
      if (!locked) throw new PayError(`Mandate ${mandate.id} not found`, 'pay.mandate_not_found');

      if (idempotencyKey) {
        const claimed = await tx<Array<{ idempotency_key: string }>>`
          INSERT INTO pay.subscription_create_idempotency (
            merchant_id, idempotency_key, request_fingerprint
          ) VALUES (
            ${locked.merchant_id}, ${idempotencyKey}, ${fingerprint}
          )
          ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
          RETURNING idempotency_key
        `;
        if (claimed.length === 0) {
          const prior = await tx<Array<{ request_fingerprint: string; subscription_id: string | null }>>`
            SELECT request_fingerprint, subscription_id
              FROM pay.subscription_create_idempotency
             WHERE merchant_id = ${locked.merchant_id}
               AND idempotency_key = ${idempotencyKey}
          `;
          const row = prior[0];
          if (!row || row.request_fingerprint !== fingerprint) {
            throw new PayError('Idempotency-Key was already used with a different request body', 'pay.idempotency_conflict');
          }
          if (!row.subscription_id) {
            throw new PayError('Subscription create idempotency claim has no subscription', 'pay.subscription_invalid');
          }
          const existing = await this.readSubscription(tx, row.subscription_id);
          if (existing.merchantId !== locked.merchant_id) {
            throw new PayError('Idempotency-Key was already used with a different request body', 'pay.idempotency_conflict');
          }
          return existing;
        }
      }

      if (locked.status !== 'active') {
        throw new PayError(`Mandate ${mandate.id} is ${locked.status}`, 'pay.mandate_inactive');
      }
      this.assertMerchantMayOpenMoney(await this.requireMerchant(locked.merchant_id, tx));

      const open = await tx<Array<{ id: string }>>`
        SELECT id
          FROM pay.subscriptions
         WHERE mandate_id = ${mandate.id}
           AND status IN ('active', 'paused')
         LIMIT 1
      `;
      if (open[0]) {
        throw new PayError(`Mandate ${mandate.id} already has an open subscription`, 'pay.subscription_mandate_open');
      }

      if (input.priceId) await subscriptionPrice(tx, locked.merchant_id, input.priceId, mandate);

      const nextRunAt = occurrenceStart(mandate.startsAt, mandate.cadence, 0);
      const path = normaliseSubscriptionPath(input.path);
      let rows: SubRow[];
      try {
        rows = await tx<SubRow[]>`
          INSERT INTO pay.subscriptions (
            mandate_id, merchant_id, customer_id, next_run_at, status, path, price_id
          ) VALUES (
            ${mandate.id}, ${locked.merchant_id}, ${mandate.customerId},
            ${nextRunAt}, 'active', ${path}, ${input.priceId ?? null}
          )
          RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                    cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                    paused_at, resumed_at, stalled_at, stall_reason, price_id
        `;
      } catch (err) {
        if (openMandateIndexViolation(err)) {
          throw new PayError(`Mandate ${mandate.id} already has an open subscription`, 'pay.subscription_mandate_open');
        }
        throw err;
      }
      const created = toSub(rows[0]!);
      if (idempotencyKey) {
        const pointed = await tx`
          UPDATE pay.subscription_create_idempotency
             SET subscription_id = ${created.id}
           WHERE merchant_id = ${locked.merchant_id}
             AND idempotency_key = ${idempotencyKey}
             AND subscription_id IS NULL
        `;
        if (pointed.count !== 1) {
          throw new PayError('Subscription create idempotency claim was not stored', 'pay.subscription_invalid');
        }
      }
      return created;
    });
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
    return this.readSubscription(this.sql, subscriptionId);
  }

  private async readSubscription(sql: Sql, subscriptionId: string): Promise<SubscriptionRecord> {
    const rows = await sql<SubRow[]>`
      SELECT id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
        FROM pay.subscriptions WHERE id = ${subscriptionId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Subscription ${subscriptionId} not found`, 'pay.subscription_not_found');
    return toSub(row);
  }

  /** Merchant fleet list — mandates (ops truth). Read-only. Filters run in SQL before the page is cut. */
  async listMandates(
    merchantId: string,
    options: { status?: MandateStatus; limit?: number; cursor?: string; search?: string; from?: string; to?: string } = {},
  ): Promise<{ items: MandateRecord[]; nextCursor: string | null }> {
    await this.requireMerchant(merchantId);
    const limit = assertMandateListLimit(options.limit);
    const filters = subscriptionListFilters(options);
    const cursorAt = filters.cursor?.createdAtCursor ?? null;
    const cursorId = filters.cursor?.id ?? null;
    const rows = await this.sql<Array<MandateRow & { created_at_cursor: string }>>`
      SELECT id, merchant_id, customer_id, asset_id, amount::text, ceiling::text,
             cadence, starts_at, ends_at, rail_adapter, rail_mandate_ref,
             status, cancelled_at, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM pay.subscription_mandates
       WHERE merchant_id = ${merchantId}
         AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
         AND (${filters.assetId}::text IS NULL OR asset_id = ${filters.assetId})
         AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from})
         AND (${filters.to}::timestamptz IS NULL OR created_at < ${filters.to})
         AND (${filters.search}::text IS NULL OR id::text = lower(${filters.search}) OR customer_id = ${filters.search})
         AND (${cursorAt}::text IS NULL OR (created_at, id) < ((${cursorAt}::text)::timestamptz, ${cursorId}::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    return subscriptionPage(rows, limit, toMandate);
  }

  /** Merchant fleet list — subscriptions (ops truth). Read-only. Filters run in SQL before the page is cut. */
  async listSubscriptions(
    merchantId: string,
    options: { status?: SubscriptionStatus; limit?: number; cursor?: string; search?: string; from?: string; to?: string } = {},
  ): Promise<{ items: SubscriptionRecord[]; nextCursor: string | null }> {
    await this.requireMerchant(merchantId);
    const limit = assertSubscriptionListLimit(options.limit);
    const filters = subscriptionListFilters(options);
    const cursorAt = filters.cursor?.createdAtCursor ?? null;
    const cursorId = filters.cursor?.id ?? null;
    const rows = await this.sql<Array<SubRow & { created_at_cursor: string }>>`
      SELECT id, mandate_id, merchant_id, customer_id, next_run_at, status,
             cancelled_at, path, created_at, anchor_at, anchor_occurrence,
             paused_at, resumed_at, stalled_at, stall_reason, price_id,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM pay.subscriptions
       WHERE merchant_id = ${merchantId}
         AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
         AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from})
         AND (${filters.to}::timestamptz IS NULL OR created_at < ${filters.to})
         AND (${filters.search}::text IS NULL OR id::text = lower(${filters.search}) OR customer_id = ${filters.search} OR mandate_id::text = lower(${filters.search}))
         AND (${cursorAt}::text IS NULL OR (created_at, id) < ((${cursorAt}::text)::timestamptz, ${cursorId}::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    return subscriptionPage(rows, limit, toSub);
  }

  /**
   * Period journal for one subscription, oldest first.
   * Page size unpublished. Blank refuses — never invent 50.
   */
  async listCycles(subscriptionId: string, options: { limit?: number } = {}): Promise<CycleRecord[]> {
    const limit = assertCycleListLimit(options.limit);
    const rows = await this.sql<CycleRow[]>`
      SELECT occurrence, amount::text, status, idempotency_key, attempt_count,
             rejection_code, payment_id, exhausted_at, settled_at, last_attempt_at,
             notify_status, notify_code
        FROM pay.subscription_executions
       WHERE subscription_id = ${subscriptionId}
       ORDER BY occurrence ASC
       LIMIT ${limit}
    `;
    return rows.map(toCycle);
  }

  /**
   * Cancel takes effect at once (SPEC §4). Does not reverse settled executions.
   */
  async cancelSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
    const existing = await this.getSubscription(subscriptionId);
    if (existing.status === 'cancelled') return existing;

    const at = this.now();
    const rows = await this.sql<SubRow[]>`
      UPDATE pay.subscriptions
         SET status = 'cancelled', cancelled_at = ${at}, updated_at = ${at},
             stall_reason = NULL, stalled_at = NULL
       WHERE id = ${subscriptionId}
      RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
    `;
    return toSub(rows[0]!);
  }

  /**
   * Cancel a mandate immediately (SPEC §4). Cascades to active subscriptions on
   * this mandate so the next due pass is not required for "stop charging."
   * Does not reverse settled executions or invent a reverse-charge path.
   */
  async cancelMandate(mandateId: string): Promise<MandateRecord> {
    const existing = await this.getMandate(mandateId);
    if (existing.status === 'cancelled') return existing;

    const at = this.now();
    const rows = await this.sql<MandateRow[]>`
      UPDATE pay.subscription_mandates
         SET status = 'cancelled', cancelled_at = ${at}, updated_at = ${at}
       WHERE id = ${mandateId}
      RETURNING id, merchant_id, customer_id, asset_id, amount::text, ceiling::text,
                cadence, starts_at, ends_at, rail_adapter, rail_mandate_ref,
                status, cancelled_at, created_at
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Mandate ${mandateId} not found`, 'pay.mandate_not_found');
    const mandate = toMandate(row);

    await this.sql`
      UPDATE pay.subscriptions
         SET status = 'cancelled', cancelled_at = ${at}, updated_at = ${at},
             stall_reason = NULL, stalled_at = NULL
       WHERE mandate_id = ${mandateId} AND status IN ('active', 'paused')
    `;

    return mandate;
  }

  /**
   * Merchant-facing firing history. Rows already exist from the due runner;
   * this only reads them. No dunning invent, no auto-retry, no ledger posts.
   */
  async listExecutions(subscriptionId: string, options: { limit?: number } = {}): Promise<ExecutionRecord[]> {
    await this.getSubscription(subscriptionId);
    const limit = assertExecutionListLimit(options.limit);
    const rows = await this.sql<
      Array<{
        id: string;
        subscription_id: string;
        occurrence: number;
        amount: string;
        status: ExecutionStatus;
        payment_id: string | null;
        rejection_code: string | null;
        attempted_at: Date;
        settled_at: Date | null;
        created_at: Date;
        notify_status: CycleRecord['notifyStatus'];
        notify_code: string | null;
      }>
    >`
      SELECT id, subscription_id, occurrence, amount::text, status,
             payment_id, rejection_code,
             COALESCE(last_attempt_at, attempted_at) AS attempted_at,
             settled_at, created_at, notify_status, notify_code
        FROM pay.subscription_executions
       WHERE subscription_id = ${subscriptionId}
       ORDER BY occurrence DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      occurrence: Number(r.occurrence),
      amount: parseAmount(r.amount),
      status: r.status,
      paymentId: r.payment_id,
      rejectionCode: r.rejection_code,
      attemptedAt: r.attempted_at,
      settledAt: r.settled_at,
      createdAt: r.created_at,
      notifyStatus: r.notify_status ?? null,
      notifyCode: r.notify_code ?? null,
    }));
  }

  /**
   * M-bill-01: set the collection method. `charge_automatically` refuses
   * `pay.mandate_rail_absent` before any write. `send_invoice` moves a card
   * subscription onto the live crypto-invoice path; on one already there it
   * returns the record unchanged (setting it twice gives the same answer).
   * A cancelled or completed subscription refuses `pay.subscription_inactive`.
   * Moving a card subscription refuses an inactive or KYB-blocked merchant
   * (`pay.merchant_inactive` or the KYB gate code) before any write. Setting the
   * method a subscription already has returns before that check: nothing is
   * written, and the charge cycle gates every new invoice itself.
   */
  async setCollectionMethod(subscriptionId: string, method: CollectionMethod): Promise<SubscriptionRecord> {
    assertCollectionMethodAvailable(method);
    const existing = await this.getSubscription(subscriptionId);
    if (existing.status !== 'active' && existing.status !== 'paused') {
      throw new PayError(`Subscription ${subscriptionId} is ${existing.status}`, 'pay.subscription_inactive');
    }
    if (collectionMethodOf(existing.path) === method) return existing;
    // Moving onto crypto_invoice opens money on the next cycle: the same status and KYB
    // cut-off as creating a mandate or subscription. The cycle re-checks before each invoice.
    this.assertMerchantMayOpenMoney(await this.requireMerchant(existing.merchantId));
    const at = this.now();
    const rows = await this.sql<SubRow[]>`
      UPDATE pay.subscriptions
         SET path = 'crypto_invoice', updated_at = ${at}
       WHERE id = ${subscriptionId} AND status IN ('active', 'paused')
      RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Subscription ${subscriptionId} is no longer open`, 'pay.subscription_inactive');
    return toSub(row);
  }

  /**
   * PAUSE — stop charging, and record that a person did it.
   *
   * A pause writes `paused_at` and `stall_reason = 'operator_pause'`. The reason
   * column is what makes this distinguishable from a runner outage on the
   * record, which `adr/2026-08-08-twap-overdue-slice-disposition.md` requires:
   * *"A tick outage is recorded on the parent, distinguishable from a user
   * pause. They have identical mechanics and completely different explanations."*
   */
  async pauseSubscription(subscriptionId: string): Promise<SubscriptionRecord> {
    const existing = await this.getSubscription(subscriptionId);
    if (existing.status === 'paused') return existing;
    if (existing.status !== 'active') {
      throw new PayError(`Subscription ${subscriptionId} is ${existing.status}`, 'pay.subscription_inactive');
    }

    const at = this.now();
    const rows = await this.sql<SubRow[]>`
      UPDATE pay.subscriptions
         SET status = 'paused', paused_at = ${at}, stalled_at = ${at},
             stall_reason = 'operator_pause', updated_at = ${at}
       WHERE id = ${subscriptionId} AND status = 'active'
      RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
    `;
    const row = rows[0];
    if (!row) return this.getSubscription(subscriptionId);
    return toSub(row);
  }

  /**
   * RESUME — and the schedule does NOT compress.
   *
   * The whole point of this method. `adr/2026-08-08-twap-overdue-slice-disposition.md`
   * measured the alternative: a 10-slice, one-per-minute TWAP paused 20 minutes
   * and resumed placed 9 slices in 8 seconds, because due times were derived
   * from creation. A subscription paused four months and resumed would charge
   * four months at once for the same reason.
   *
   * So resume RE-ANCHORS: the next period owed becomes due at the resume
   * instant, and every period after it is a full interval from there. Nothing is
   * compressed and nothing is forfeited — the subscription simply ends later,
   * and the return value says when.
   *
   * A `fee_unpublished` stall is not that gap. The due time already stored on
   * the row is restored: `next_run_at`, `anchor_at`, and `anchor_occurrence`
   * stay as they are. The mandate-window check below belongs to the re-anchor.
   *
   * If re-spacing would carry periods past the mandate's `endsAt`, resume is
   * REFUSED with the projected end (`pay.subscription_resume_exceeds_mandate`).
   * The window is part of what the customer authorised; charging past it is
   * charging without consent, and silently dropping the tail is the "skip" the
   * ADR rejects. Refusing tells the merchant to re-consent with a new mandate,
   * which is the same disposition the ADR gives a resume past 2× duration.
   */
  async resumeSubscription(subscriptionId: string): Promise<{ subscription: SubscriptionRecord; projectedEnd: Date | null }> {
    const existing = await this.getSubscription(subscriptionId);
    if (existing.status !== 'paused') {
      throw new PayError(`Subscription ${subscriptionId} is ${existing.status}, not paused`, 'pay.subscription_inactive');
    }
    const mandate = await this.getMandate(existing.mandateId);
    if (mandate.status !== 'active') {
      throw new PayError(`Mandate ${mandate.id} is ${mandate.status}`, 'pay.mandate_inactive');
    }

    const at = this.now();
    if (existing.stallReason === 'fee_unpublished') {
      const rows = await this.sql<SubRow[]>`
        UPDATE pay.subscriptions
           SET status = 'active',
               resumed_at = ${at},
               paused_at = NULL,
               stalled_at = NULL,
               stall_reason = NULL,
               updated_at = ${at}
         WHERE id = ${subscriptionId}
           AND status = 'paused'
           AND stall_reason = 'fee_unpublished'
        RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                  cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                  paused_at, resumed_at, stalled_at, stall_reason, price_id
      `;
      const row = rows[0];
      if (!row) throw new PayError(`Subscription ${subscriptionId} is no longer paused`, 'pay.subscription_inactive');
      return { subscription: toSub(row), projectedEnd: null };
    }

    const frame = this.frameOf(existing, mandate);
    const last = await this.lastCycle(existing.id);
    const nextOccurrence = last === null ? 0 : last.occurrence + 1;

    const projection = projectReAnchor(frame, { at, nextOccurrence });
    if (!projection.fits) {
      throw new PayError(
        `Resuming now would run this subscription to ${projection.projectedEnd?.toISOString()}, past the ${mandate.endsAt?.toISOString()} ` +
          `its mandate authorises. ${projection.remaining} period(s) are still owed. Create a new mandate to extend — ` +
          `the schedule will not be compressed to fit and periods will not be dropped.`,
        'pay.subscription_resume_exceeds_mandate',
      );
    }

    const rows = await this.sql<SubRow[]>`
      UPDATE pay.subscriptions
         SET status = 'active',
             anchor_at = ${at},
             anchor_occurrence = ${nextOccurrence},
             next_run_at = ${at},
             resumed_at = ${at},
             paused_at = NULL,
             stalled_at = NULL,
             stall_reason = NULL,
             updated_at = ${at}
       WHERE id = ${subscriptionId} AND status = 'paused'
      RETURNING id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Subscription ${subscriptionId} is no longer paused`, 'pay.subscription_inactive');
    return { subscription: toSub(row), projectedEnd: projection.projectedEnd };
  }

  /**
   * Refuse-in-code for "raise price on an existing mandate." Callers must
   * create a new mandate and re-bind; this method only exists so the refuse
   * path is named and tested.
   */
  proposeMandateAmountChange(mandate: MandateRecord, proposed: { amount: Amount; ceiling?: Amount | null }): never {
    assertMandateTermsUnchanged(
      { amount: mandate.amount, ceiling: mandate.ceiling },
      { amount: proposed.amount, ceiling: proposed.ceiling ?? null },
    );
    // Unreachable if amounts match — if they match, there is nothing to propose.
    throw new PayError('Mandate terms are unchanged; nothing to re-consent', 'pay.subscription_invalid');
  }

  /**
   * THE DUE PASS — external cron, not setInterval (bank transplant law).
   *
   * One action per subscription per pass, decided by `planChargeCycle`. There is
   * no `maxCatchUp` parameter any more and that is the fix: bounding a catch-up
   * burst at twelve made the burst smaller, not correct.
   */
  async runDueSubscriptions(options: { now?: Date; limit?: number } = {}): Promise<RunReport> {
    const now = options.now ?? this.now();
    const limit = assertDueSubscriptionsBatchLimit(options.limit);

    const due = await this.sql<SubRow[]>`
      SELECT id, mandate_id, merchant_id, customer_id, next_run_at, status,
                cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                paused_at, resumed_at, stalled_at, stall_reason, price_id
        FROM pay.subscriptions
       WHERE status = 'active' AND next_run_at <= ${now}
       ORDER BY next_run_at ASC
       LIMIT ${limit}
    `;

    const report: RunReport = { examined: due.length, fired: 0, retried: 0, stalled: 0, outcomes: [] };

    /*
     * ONE THROW BELONGS TO ONE SUBSCRIPTION.
     *
     * `getMandate`, amount parsing, and the charge transaction can throw. Left
     * uncaught, that throw discarded this report and left `next_run_at` in the
     * past, so the earliest due row stayed first and every later subscription
     * was skipped on this pass and the next. Stall that row and continue. Do
     * not charge it and do not invent an amount.
     */
    for (const row of due) {
      try {
        const sub = toSub(row);
        await this.runOneSubscription(sub, now, report);
      } catch (err) {
        await this.quarantineDuePassThrow(row.id, now, report, err);
      }
    }

    return report;
  }

  /**
   * A due-pass throw is this subscription's, not the batch's.
   *
   * Stall with `due_pass_fault` so the row leaves the active due set. If that
   * write fails, move `next_run_at` past this pass so the row cannot remain the
   * permanent first due row. Neither arm charges and neither invents an amount.
   */
  private async quarantineDuePassThrow(subscriptionId: string, now: Date, report: RunReport, err: unknown): Promise<void> {
    const rejectionCode = err instanceof PayError ? err.code : 'pay.subscription_due_pass_fault';
    let stallReason: StallReason | undefined;
    try {
      await this.stall(subscriptionId, 'due_pass_fault', now);
      stallReason = 'due_pass_fault';
      report.stalled += 1;
    } catch {
      try {
        await this.setNextRun(subscriptionId, new Date(now.getTime() + 1), now);
      } catch {
        // The report still records the fault. Later subscriptions in this pass still run.
      }
    }
    report.outcomes.push({
      subscriptionId,
      occurrence: null,
      outcome: stallReason === undefined ? 'skipped' : 'stalled',
      ...(stallReason === undefined ? {} : { stallReason }),
      rejectionCode,
    });
  }

  /** One subscription, one pass, at most one charge. */
  private async runOneSubscription(sub: SubscriptionRecord, now: Date, report: RunReport): Promise<void> {
    const mandate = await this.getMandate(sub.mandateId);
    if (mandate.status !== 'active') {
      // A cancelled or expired mandate is the end of the subscription, not a
      // reason to keep looking at it every minute.
      await this.sql`
        UPDATE pay.subscriptions SET status = 'cancelled', cancelled_at = ${now}, updated_at = ${now}
         WHERE id = ${sub.id} AND status = 'active'
      `;
      report.outcomes.push({ subscriptionId: sub.id, occurrence: null, outcome: 'skipped' });
      return;
    }

    const frame = this.frameOf(sub, mandate);
    const stale = await this.expireStaleInvoice(sub, frame, now);
    if (stale.expired !== null) {
      report.outcomes.push({
        subscriptionId: sub.id,
        occurrence: stale.expired,
        outcome: 'rejected',
        rejectionCode: 'pay.subscription_invoice_unpaid',
      });
    }

    const last = await this.lastCycle(sub.id);
    const plan = planChargeCycle({ frame, last, now });

    switch (plan.kind) {
      case 'idle': {
        await this.setNextRun(sub.id, plan.nextRunAt, now);
        report.outcomes.push({ subscriptionId: sub.id, occurrence: null, outcome: 'idle' });
        return;
      }

      case 'completed': {
        await this.sql`
          UPDATE pay.subscriptions
             SET status = 'completed', next_run_at = ${plan.nextRunAt}, updated_at = ${now}
           WHERE id = ${sub.id} AND status = 'active'
        `;
        report.outcomes.push({ subscriptionId: sub.id, occurrence: null, outcome: 'completed' });
        return;
      }

      case 'blocked': {
        // An unsettled period does not roll forward. It stalls, with a reason.
        // A payment openInvoice already committed is stored first, or the stall
        // gives up while that invoice is still unlinked.
        await this.rememberUnlinkedCreatedPayment(sub.id, plan.occurrence);
        await this.stall(sub.id, plan.reason, now);
        report.stalled += 1;
        report.outcomes.push({ subscriptionId: sub.id, occurrence: plan.occurrence, outcome: 'stalled', stallReason: plan.reason });
        return;
      }

      case 'charge':
      case 'retry': {
        /*
         * THE PRICE IS RESOLVED BEFORE THE PERIOD IS CLAIMED.
         *
         * An unpublished fee is refuse-closed, and refusing must not consume the
         * period: no execution row, no attempt spent, the period still owed. The
         * subscription stalls with `fee_unpublished` so it is an operator's
         * visible problem today rather than a settlement surprise later.
         *
         * Any other throw is a blip, not a missing rate. Pausing would remove
         * the row from the active due set, so the next pass could not retry.
         * Leave it active. Do not charge, do not invent a fee, and do not move
         * the anchor.
         */
        try {
          await this.resolveFeeBps(sub.merchantId);
        } catch (err) {
          if (err instanceof PayError && err.code === 'pay.subscription_fee_unpublished') {
            await this.stall(sub.id, 'fee_unpublished', now);
            report.stalled += 1;
            report.outcomes.push({
              subscriptionId: sub.id,
              occurrence: plan.occurrence,
              outcome: 'stalled',
              stallReason: 'fee_unpublished',
              rejectionCode: err.code,
            });
            return;
          }
          report.outcomes.push({
            subscriptionId: sub.id,
            occurrence: plan.occurrence,
            outcome: 'skipped',
            ...(err instanceof PayError ? { rejectionCode: err.code } : {}),
          });
          return;
        }

        /*
         * THE FRAME MOVES BEFORE THE CHARGE, and every later calculation in this
         * pass uses the MOVED frame.
         *
         * Both halves matter. Writing the anchor first means a crash between the
         * two leaves the schedule re-spaced rather than still compressing. Using
         * the moved frame for `nextRunAt` is what actually delivers the spacing:
         * computing the next period from the pre-anchor frame would set it to a
         * time already in the past, the very next pass would fire again, and the
         * burst would be back with an anchor column watching it happen.
         */
        let frameNow = frame;
        if (plan.kind === 'charge' && plan.reAnchor !== null) {
          await this.reAnchor(sub.id, plan.reAnchor.at, plan.reAnchor.occurrence, now);
          frameNow = { ...frame, anchorAt: plan.reAnchor.at, anchorOccurrence: plan.reAnchor.occurrence };
        }

        const attempt = await this.attemptCycle({
          sub,
          mandate,
          frame: frameNow,
          occurrence: plan.occurrence,
          isRetry: plan.kind === 'retry',
          now,
        });

        if (plan.kind === 'retry') report.retried += 1;
        else if (attempt.outcome === 'invoiced') report.fired += 1;

        report.outcomes.push({
          subscriptionId: sub.id,
          occurrence: plan.occurrence,
          outcome: attempt.outcome,
          rejectionCode: attempt.rejectionCode,
          noticeCode: attempt.noticeCode,
          notifyStatus: attempt.notifyStatus ?? undefined,
          idempotencyKey: attempt.idempotencyKey,
          lateIntervals: plan.kind === 'charge' ? plan.lateIntervals : undefined,
        });

        if (plan.kind === 'charge') {
          /*
           * WHOSE GAP WAS IT. A late charge on a subscription nobody paused is a
           * runner outage, and the ADR requires it to be recorded and to stay
           * distinguishable from a user pause — "identical mechanics and
           * completely different explanations". An on-time charge clears the
           * marker, so the column says "the last gap was an outage", not "there
           * was an outage once, years ago".
           */
          if (plan.reAnchor !== null && attempt.outcome !== 'rejected') await this.noteOutage(sub.id, now);
          else if (plan.lateIntervals < 1) await this.clearOutageMarker(sub.id, now);
        }

        // Where to look next. A rejection re-times to its own retry slot; a
        // success moves to the following period. Both read the MOVED frame.
        const nextRunAt =
          attempt.outcome === 'rejected'
            ? this.retryNextRun(frameNow, plan.occurrence, now)
            : this.nextPeriodRun(frameNow, plan.occurrence);
        await this.setNextRun(sub.id, nextRunAt, now);
        return;
      }
    }
  }

  /**
   * ATTEMPT ONE PERIOD.
   *
   * Claims the period, or picks up the existing claim for a retry, and opens the
   * invoice. The claim and the business key are the same write, so a period
   * cannot exist without the key that dedupes it.
   *
   * The key is `pay.subscription:<subscriptionId>:<occurrence>` on every attempt
   * — attempt two of period three carries the key of period three, not a fresh
   * one. That is the whole idempotency story: `unique(idempotency_key)` means a
   * retry that tried to mint a second key would fail loudly instead of charging
   * twice.
   */
  async attemptCycle(input: {
    sub: SubscriptionRecord;
    mandate: MandateRecord;
    frame: CycleFrame;
    occurrence: number;
    isRetry: boolean;
    now: Date;
  }): Promise<{
    outcome: CycleOutcome;
    rejectionCode?: string;
    noticeCode?: string;
    notifyStatus?: CycleRecord['notifyStatus'];
    idempotencyKey: string;
  }> {
    const { sub: loadedSub, mandate: loadedMandate, occurrence, now } = input;
    if (loadedSub.status !== 'active')
      return { outcome: 'skipped', idempotencyKey: chargeIdempotencyKey({ subscriptionId: loadedSub.id, occurrence }) };

    const idempotencyKey = chargeIdempotencyKey({ subscriptionId: loadedSub.id, occurrence });

    return transaction(
      this.sql,
      async (tx) => {
        /*
         * The due pass already loaded this pair. Cancel commits on another
         * connection. Lock the mandate, then the subscription, and charge from
         * those rows. A cancel that committed after the snapshot is visible
         * here, so the invoice does not open and no amount is invented.
         */
        const lockedMandateRows = await tx<MandateRow[]>`
          SELECT id, merchant_id, customer_id, asset_id, amount::text, ceiling::text,
                 cadence, starts_at, ends_at, rail_adapter, rail_mandate_ref,
                 status, cancelled_at, created_at
            FROM pay.subscription_mandates
           WHERE id = ${loadedMandate.id}
           FOR UPDATE
        `;
        const lockedSubRows = await tx<SubRow[]>`
          SELECT id, mandate_id, merchant_id, customer_id, next_run_at, status,
                 cancelled_at, path, created_at, anchor_at, anchor_occurrence,
                 paused_at, resumed_at, stalled_at, stall_reason, price_id
            FROM pay.subscriptions
           WHERE id = ${loadedSub.id}
           FOR UPDATE
        `;
        const lockedMandateRow = lockedMandateRows[0];
        const lockedSubRow = lockedSubRows[0];
        if (!lockedMandateRow || !lockedSubRow) return { outcome: 'skipped' as const, idempotencyKey };
        const mandate = toMandate(lockedMandateRow);
        const sub = toSub(lockedSubRow);
        if (sub.status !== 'active' || mandate.status !== 'active' || sub.mandateId !== mandate.id) {
          return { outcome: 'skipped' as const, idempotencyKey };
        }

        const claimed = await tx<Array<{ id: string; amount: string; attempt_count: number }>>`
          INSERT INTO pay.subscription_executions (
            subscription_id, occurrence, amount, status, idempotency_key,
            attempt_count, last_attempt_at
          ) VALUES (
            ${sub.id}, ${occurrence}, ${formatAmount(mandate.amount)}::numeric, 'pending',
            ${idempotencyKey}, 1, ${now}
          )
          ON CONFLICT (subscription_id, occurrence) DO NOTHING
          RETURNING id, amount::text, attempt_count
        `;

        let executionId: string;
        let chargeAmount: Amount;
        let attemptCount: number;
        let priorPaymentId: string | null = null;

        if (claimed.length === 0) {
          const existing = await tx<
            Array<{
              id: string;
              status: string;
              amount: string;
              attempt_count: number;
              exhausted_at: Date | null;
              payment_id: string | null;
            }>
          >`
            SELECT id, status, amount::text, attempt_count, exhausted_at, payment_id
              FROM pay.subscription_executions
             WHERE subscription_id = ${sub.id} AND occurrence = ${occurrence}
             FOR UPDATE
          `;
          const row = existing[0];
          if (!row) return { outcome: 'already-fired' as const, idempotencyKey };
          if (row.status === 'settled' || row.status === 'invoiced') {
            // Already collected, or already asked for. Not asked again.
            return { outcome: 'already-fired' as const, idempotencyKey };
          }
          /*
           * Giving up while a created payment is still unlinked leaves a paid
           * invoice off this row. Attach that id before already-fired. Do not
           * open another invoice and do not change the amount.
           */
          if (row.exhausted_at !== null || (row.status === 'rejected' && row.attempt_count >= MAX_ATTEMPTS_PER_CYCLE)) {
            if (row.payment_id === null) {
              await this.attachCreatedPayment(tx, row.id, sub.id, occurrence);
            }
            return { outcome: 'already-fired' as const, idempotencyKey };
          }
          executionId = row.id;
          priorPaymentId = row.payment_id;
          chargeAmount = parseAmount(row.amount);
          attemptCount = Number(row.attempt_count) + 1;
          await tx`
            UPDATE pay.subscription_executions
               SET status = 'pending', attempt_count = ${attemptCount},
                   last_attempt_at = ${now}, rejection_code = NULL,
                   idempotency_key = COALESCE(idempotency_key, ${idempotencyKey})
             WHERE id = ${executionId}
          `;
        } else {
          executionId = claimed[0]!.id;
          chargeAmount = parseAmount(claimed[0]!.amount);
          attemptCount = 1;
        }

        /*
         * THE MANDATE IS THE CEILING — checked here, at the moment of the charge.
         *
         * `chargeAmount` is the amount recorded when the period was claimed; the
         * mandate is the row locked above, not the due-pass snapshot. A retry of
         * a period claimed under terms that have since been lowered or replaced
         * must refuse, and it must refuse TERMINALLY: retrying cannot make an
         * unauthorised charge authorised, so the attempts are spent rather than
         * burned one per pass.
         */
        try {
          assertWithinMandateCeiling(mandate, chargeAmount);
          assertWithinMandateWindow(mandate, now);
        } catch (err) {
          const code = err instanceof PayError ? err.code : 'pay.subscription_exceeds_mandate';
          await tx`
            UPDATE pay.subscription_executions
               SET status = 'rejected', rejection_code = ${code},
                   attempt_count = ${MAX_ATTEMPTS_PER_CYCLE}, exhausted_at = ${now}
             WHERE id = ${executionId}
          `;
          return { outcome: 'rejected' as const, rejectionCode: code, idempotencyKey };
        }

        /*
         * Product path law (mandate-product.ts): card refuses by name; crypto
         * opens an invoice. Trace the period amount to the active mandate
         * before either arm — a charge without a mandate does not go out.
         */
        assertChargeTracesToMandate({
          executionSubscriptionId: sub.id,
          subscriptionId: sub.id,
          mandateId: mandate.id,
          mandateStatus: mandate.status,
          amount: chargeAmount,
          mandateAmount: mandate.amount,
        });

        const disposition = mandateChargeDisposition(sub.path);
        if (disposition.kind === 'refuse') {
          await this.rejectCycle(tx, executionId, disposition.code, attemptCount, now);
          return { outcome: 'rejected' as const, rejectionCode: disposition.code, idempotencyKey };
        }

        // crypto_invoice: open a payment, never pull.
        if (!this.openInvoice) {
          await this.rejectCycle(tx, executionId, 'pay.subscription_driver_absent', attemptCount, now);
          return { outcome: 'rejected' as const, rejectionCode: 'pay.subscription_driver_absent', idempotencyKey };
        }

        /*
         * openInvoice commits on its own connection. The id it returns is kept
         * for the rejection write: a later statement in this transaction can
         * throw after that commit, and rejectCycle would otherwise record the
         * failure without the payment.
         */
        let openedPaymentId: string | null = null;
        try {
          // Reuse any payment already tagged for this occurrence so a re-fire
          // never opens a second invoice.
          let paymentId = priorPaymentId;
          if (!paymentId) paymentId = await this.createdPaymentId(tx, sub.id, occurrence);
          /*
           * A NEW invoice is new money: refuse it for a merchant that is no
           * longer active or is KYB-blocked (the same cut-off as the mandate and
           * subscription doors) BEFORE the pre-charge notice. The opener
           * (createPayment) refuses too, but only after the customer was told
           * of an invoice that never opens. Linking an invoice already opened
           * is not gated.
           */
          if (!paymentId) this.assertMerchantMayOpenMoney(await this.requireMerchant(sub.merchantId, tx));
          /*
           * SPEC §4 pre-charge notify — record the attempt BEFORE money work,
           * including invoice reuse. Unwired is skipped_unwired, never silent
           * notified. Port failures are named failed; they do not unwind money.
           */
          const notify = await recordPreChargeNotifyAttempt({
            notify: this.notifyPreCharge,
            subscriptionId: sub.id,
            occurrence,
            path: sub.path,
            merchantId: sub.merchantId,
            customerId: sub.customerId,
            amount: formatAmount(chargeAmount),
            assetId: mandate.assetId,
            idempotencyKey,
          });
          assertPrechargeNotifyUnpublished(notify);
          await tx`
            UPDATE pay.subscription_executions
               SET notify_status = ${notify.notifyStatus},
                   notify_code = ${notify.code},
                   notified_at = ${now}
             WHERE id = ${executionId}
          `;

          if (!paymentId) {
            const opened = await this.openInvoice({
              merchantId: sub.merchantId,
              customerId: sub.customerId,
              amount: chargeAmount,
              assetId: mandate.assetId,
              subscriptionId: sub.id,
              occurrence,
              idempotencyKey,
            });
            paymentId = opened.paymentId;
            openedPaymentId = opened.paymentId;
          }
          /*
           * The link write is its own savepoint. If it throws, the payment
           * openInvoice already committed stays on the rejection instead of
           * the aborted transaction dropping both the link and the rejection.
           */
          const linkedId = paymentId;
          await tx`SAVEPOINT pay_invoice_link`;
          try {
            await tx`
              UPDATE pay.subscription_executions
                 SET status = 'invoiced', payment_id = ${linkedId}
               WHERE id = ${executionId}
            `;
            await tx`RELEASE SAVEPOINT pay_invoice_link`;
          } catch (error) {
            await tx`ROLLBACK TO SAVEPOINT pay_invoice_link`;
            await tx`RELEASE SAVEPOINT pay_invoice_link`;
            throw error;
          }
          return {
            outcome: 'invoiced' as const,
            idempotencyKey,
            noticeCode: notify.code ?? undefined,
            notifyStatus: notify.notifyStatus,
          };
        } catch (err) {
          const code = err instanceof PayError ? err.code : err instanceof Error ? err.message.slice(0, 120) : 'invoice.failed';
          await this.rejectCycle(tx, executionId, code, attemptCount, now, openedPaymentId);
          return { outcome: 'rejected' as const, rejectionCode: code, idempotencyKey };
        }
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * Watch half of invoice-and-watch: when the opened payment captures, the
   * matching execution moves invoiced → settled. Idempotent. No ledger posts.
   * Unmatched payment ids are a no-op (not every payment is a subscription invoice).
   *
   * Settling a period also clears an arrears stall on its subscription and puts
   * it back in the run, because the thing that blocked it has been paid.
   */
  async markExecutionSettledForPayment(paymentId: string): Promise<{ updated: boolean }> {
    /*
     * `('invoiced', 'rejected')`, not `('invoiced')` alone.
     *
     * A late payment is still a payment. If the invoice for a period was marked
     * unpaid and the customer then pays it, the money IS in the book — and a
     * period left `rejected` while its own payment sits captured would show a
     * paid-up customer in arrears forever, and would block every later period
     * for a debt that no longer exists. `payment_id` makes the match
     * unambiguous: this exact payment was opened for this exact period.
     *
     * `exhausted_at` and `rejection_code` are cleared for the same reason. They
     * recorded a fact that has been overtaken by a balance.
     */
    /*
     * ONE TRANSACTION, both writes.
     *
     * Settling the period and lifting the arrears it caused are one fact. Two
     * statements outside a transaction leave a crash window in which the period
     * is settled and the subscription is still stalled for a debt that has been
     * paid — and nothing would ever revisit it, because the stall is what stops
     * the runner looking. This is the shape #950 established for `close()`: a
     * state transition spanning several writes belongs in the transaction that
     * makes them.
     */
    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<Array<{ id: string; subscription_id: string }>>`
          UPDATE pay.subscription_executions
             SET status = 'settled', settled_at = now(),
                 exhausted_at = NULL, rejection_code = NULL
           WHERE payment_id = ${paymentId}
             AND status IN ('invoiced', 'rejected')
           RETURNING id, subscription_id
        `;
        const row = rows[0];
        if (!row) return { updated: false };

        /*
         * The debt is paid, so the arrears stall is over and the schedule runs
         * again.
         *
         * `stall_reason = 'arrears'` in the predicate is load-bearing: a
         * subscription a PERSON paused must stay paused, and a late payment is
         * not consent to start charging again.
         *
         * It returns to `active` WITHOUT re-anchoring, deliberately. The next
         * pass then sees it as overdue and goes through the ordinary late-period
         * path, which re-spaces the schedule and checks the mandate window on
         * the way. Re-anchoring here would skip that window check and could
         * quietly carry periods past what the customer authorised.
         */
        await tx`
          UPDATE pay.subscriptions
             SET stall_reason = NULL, stalled_at = NULL, updated_at = now(),
                 -- Explicit cast: status is an enum, and an untyped CASE result
                 -- is text, which Postgres refuses to assign to it.
                 status = CASE WHEN status = 'paused' THEN 'active'::pay.subscription_status ELSE status END
           WHERE id = ${row.subscription_id} AND stall_reason = 'arrears'
        `;
        return { updated: true };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private frameOf(sub: SubscriptionRecord, mandate: MandateRecord): CycleFrame {
    return {
      cadence: mandate.cadence,
      mandateStartsAt: mandate.startsAt,
      mandateEndsAt: mandate.endsAt,
      anchorAt: sub.anchorAt,
      anchorOccurrence: sub.anchorOccurrence,
    };
  }

  /** The highest recorded period, which is the only thing that blocks the next. */
  private async lastCycle(subscriptionId: string): Promise<LastCycle | null> {
    const rows = await this.sql<
      Array<{
        occurrence: number;
        status: LastCycle['status'];
        attempt_count: number;
        exhausted_at: Date | null;
        last_attempt_at: Date | null;
      }>
    >`
      SELECT occurrence, status, attempt_count, exhausted_at, last_attempt_at
        FROM pay.subscription_executions
       WHERE subscription_id = ${subscriptionId}
       ORDER BY occurrence DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      occurrence: Number(row.occurrence),
      status: row.status,
      attemptCount: Number(row.attempt_count ?? 1),
      exhausted: row.exhausted_at !== null,
      lastAttemptAt: row.last_attempt_at,
    };
  }

  /**
   * An invoice still unpaid a whole interval later is not in flight.
   *
   * Left as `invoiced` forever it would block the next period silently and the
   * subscription would report itself healthy while collecting nothing. This is
   * the funding ADR's distinction applied to an invoice: unsettled is a fact
   * worth saying, not a state worth hiding in.
   *
   * ── AND IT IS TERMINAL. A RETRY HERE WOULD BE THE DOUBLE CHARGE. ──────────
   *
   * `exhausted_at` is set immediately, so this period gets no further attempts
   * even though the attempt bound is nowhere near spent. The reason is specific
   * and it is the whole point of the arrears design:
   *
   *   **A retry is only safe when the previous attempt left nothing collectible.**
   *
   * An attempt that failed before opening an invoice left nothing — the rail
   * refused, or no driver was wired — so trying again risks nothing. An attempt
   * that DID open an invoice left a live claim on the customer. Opening a second
   * invoice for the same period does not replace the first; both are payable, the
   * execution row can only point at one of them, and a customer who pays both has
   * been charged twice for one month with the journal showing a single settled
   * period. That is exactly the class of defect the business idempotency key
   * exists to prevent, arriving through the back door.
   *
   * So the period stands as failed, the subscription stalls in arrears, and an
   * operator decides. If the customer pays the original invoice late,
   * `markExecutionSettledForPayment` still settles the period and lifts the
   * stall — the money is in the book, and refusing to acknowledge it because we
   * had given up would leave a paid-up customer in arrears forever.
   */
  private async expireStaleInvoice(sub: SubscriptionRecord, frame: CycleFrame, now: Date): Promise<{ expired: number | null }> {
    const last = await this.lastCycle(sub.id);
    if (last === null || last.status !== 'invoiced') return { expired: null };
    if (now.getTime() < invoiceExpiredAt(frame, last.occurrence).getTime()) return { expired: null };

    const rows = await this.sql<Array<{ occurrence: number }>>`
      UPDATE pay.subscription_executions
         SET status = 'rejected', rejection_code = 'pay.subscription_invoice_unpaid',
             last_attempt_at = ${now}, exhausted_at = ${now}
       WHERE subscription_id = ${sub.id} AND occurrence = ${last.occurrence} AND status = 'invoiced'
      RETURNING occurrence
    `;
    return { expired: rows.length === 0 ? null : Number(rows[0]!.occurrence) };
  }

  private async resolveFeeBps(merchantId: string): Promise<number> {
    const merchantFeeBps = this.resolveMerchantFeeBps ? await this.resolveMerchantFeeBps(merchantId) : undefined;
    return resolveSubscriptionFeeBps({ merchantFeeBps, defaultFeeBps: this.defaultFeeBps });
  }

  private async rejectCycle(
    tx: Sql,
    executionId: string,
    code: string,
    attemptCount: number,
    now: Date,
    paymentId: string | null = null,
  ): Promise<void> {
    const exhausted = attemptCount >= MAX_ATTEMPTS_PER_CYCLE;
    await tx`
      UPDATE pay.subscription_executions
         SET status = 'rejected', rejection_code = ${code},
             last_attempt_at = ${now},
             exhausted_at = ${exhausted ? now : null},
             payment_id = COALESCE(payment_id, ${paymentId}::uuid)
       WHERE id = ${executionId}
    `;
  }

  /** The payment openInvoice already committed for this period, if one exists. */
  private async createdPaymentId(tx: Sql, subscriptionId: string, occurrence: number): Promise<string | null> {
    const prior = await tx<Array<{ payment_id: string; matches: boolean }>>`
      SELECT e.payment_id,
        (p.merchant_id = s.merchant_id AND m.merchant_id = s.merchant_id AND m.customer_id = s.customer_id
          AND p.currency = m.asset_id AND p.amount = x.amount) AS matches
        FROM pay.payment_events e
        JOIN pay.payments p ON p.id = e.payment_id
        JOIN pay.subscriptions s ON s.id = ${subscriptionId}
        JOIN pay.subscription_mandates m ON m.id = s.mandate_id
        JOIN pay.subscription_executions x ON x.subscription_id = s.id AND x.occurrence = ${occurrence}
       WHERE e.event = 'created'
         AND e.payload#>>'{metadata,subscriptionId}' = ${subscriptionId}
         AND e.payload#>>'{metadata,occurrence}' = ${String(occurrence)}
       ORDER BY e.seq ASC
       LIMIT 2
    `;
    if (prior.length > 1 || (prior[0] && !prior[0].matches))
      throw new PayError('Original subscription invoice identity is ambiguous', 'pay.subscription_exceeds_mandate');
    return prior[0]?.payment_id ?? null;
  }

  /**
   * Store that payment on the execution. The amount and the status stay as
   * they are: this is the invoice already created, not a new charge.
   */
  private async attachCreatedPayment(tx: Sql, executionId: string, subscriptionId: string, occurrence: number): Promise<void> {
    const paymentId = await this.createdPaymentId(tx, subscriptionId, occurrence);
    if (!paymentId) return;
    await tx`
      UPDATE pay.subscription_executions
         SET payment_id = ${paymentId}
       WHERE id = ${executionId} AND payment_id IS NULL
    `;
  }

  /** Before an exhausted period is given up, keep the invoice it already opened. */
  private async rememberUnlinkedCreatedPayment(subscriptionId: string, occurrence: number): Promise<void> {
    await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<Array<{ id: string; payment_id: string | null }>>`
          SELECT id, payment_id
            FROM pay.subscription_executions
           WHERE subscription_id = ${subscriptionId} AND occurrence = ${occurrence}
           FOR UPDATE
        `;
        const row = rows[0];
        if (!row || row.payment_id !== null) return;
        await this.attachCreatedPayment(tx, row.id, subscriptionId, occurrence);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async setNextRun(subscriptionId: string, nextRunAt: Date, now: Date): Promise<void> {
    await this.sql`
      UPDATE pay.subscriptions
         SET next_run_at = ${nextRunAt}, updated_at = ${now}
       WHERE id = ${subscriptionId} AND status = 'active'
    `;
  }

  private async reAnchor(subscriptionId: string, at: Date, occurrence: number, now: Date): Promise<void> {
    await this.sql`
      UPDATE pay.subscriptions
         SET anchor_at = ${at}, anchor_occurrence = ${occurrence}, updated_at = ${now}
       WHERE id = ${subscriptionId} AND status = 'active'
    `;
  }

  /**
   * A gap nobody asked for. Recorded, and not confusable with a pause.
   *
   * Only over a clear reason: an operator pause that has just been resumed took
   * the `resumeSubscription` path, which is the caller's own account of the gap
   * and outranks the runner's inference.
   */
  private async noteOutage(subscriptionId: string, now: Date): Promise<void> {
    await this.sql`
      UPDATE pay.subscriptions
         SET stalled_at = ${now}, stall_reason = 'runner_outage', updated_at = ${now}
       WHERE id = ${subscriptionId} AND stall_reason IS NULL
    `;
  }

  /** An on-time charge means the last gap is over. Only clears the runner's own mark. */
  private async clearOutageMarker(subscriptionId: string, now: Date): Promise<void> {
    await this.sql`
      UPDATE pay.subscriptions
         SET stalled_at = NULL, stall_reason = NULL, updated_at = ${now}
       WHERE id = ${subscriptionId} AND stall_reason = 'runner_outage'
    `;
  }

  private async stall(subscriptionId: string, reason: StallReason, now: Date): Promise<void> {
    await this.sql`
      UPDATE pay.subscriptions
         SET status = 'paused', stalled_at = ${now}, stall_reason = ${reason}, updated_at = ${now}
       WHERE id = ${subscriptionId} AND status = 'active'
    `;
  }

  /**
   * When to look at a rejected period again.
   *
   * `retryDueAt` spaces the attempts across the period they belong to, derived
   * from the mandate's own cadence, so a retry can never arrive in the next
   * period and be mistaken for its charge. Clamped forward: a retry slot already
   * in the past would spin the runner on one row.
   *
   * The slot is computed for attempt one deliberately. It is a WAKE time, not a
   * permission: the next pass re-plans from the executions table and answers
   * `idle` with the true slot if this one was early. Deriving it from an attempt
   * count carried in memory is how a wake time and the truth drift apart.
   */
  private retryNextRun(frame: CycleFrame, occurrence: number, now: Date): Date {
    const due = retryDueAt(frame, occurrence, 1);
    return due.getTime() > now.getTime() ? due : new Date(now.getTime() + 1);
  }

  private nextPeriodRun(frame: CycleFrame, occurrence: number): Date {
    const authorised = lastAuthorisedOccurrence(frame);
    if (authorised !== null && occurrence + 1 > authorised) return occurrenceDueAt(frame, authorised);
    return occurrenceDueAt(frame, occurrence + 1);
  }

  private async requireMerchant(
    merchantId: string,
    sql: Sql = this.sql,
  ): Promise<{ id: string; status: string; kybStatus: MerchantKybStatus }> {
    const rows = await sql<Array<{ id: string; status: string; kyb_status: MerchantKybStatus }>>`
      SELECT id, status, kyb_status FROM pay.merchants WHERE id = ${merchantId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    return { id: row.id, status: row.status, kybStatus: row.kyb_status };
  }

  /** Mandate / subscription writes — same status + KYB cut-off as PayService money doors. */
  private assertMerchantMayOpenMoney(merchant: { id: string; status: string; kybStatus: MerchantKybStatus }): void {
    if (merchant.status !== 'active') {
      throw new PayError(`Merchant ${merchant.id} is ${merchant.status}`, 'pay.merchant_inactive');
    }
    const kybRefuse = merchantKybMoneyGateRefusal({
      merchantId: merchant.id,
      status: merchant.status,
      kybStatus: merchant.kybStatus,
      valueMovement: this.valueMovement,
    });
    if (kybRefuse) {
      throw new PayError(kybRefuse.message, kybRefuse.code, kybRefuse.detail);
    }
  }
}

function subscriptionListFilters(input: { search?: string; from?: string; to?: string; cursor?: string; assetId?: string }) {
  try {
    return parseListFilters(input);
  } catch (error) {
    if (error instanceof ListQueryError) throw new PayError(error.message, error.code);
    throw error;
  }
}

function subscriptionPage<R extends { created_at_cursor: string; id: string }, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
): { items: T[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    items: kept.map(map),
    nextCursor: rows.length > limit && last ? encodeListCursor(last.created_at_cursor, last.id) : null,
  };
}
