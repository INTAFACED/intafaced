import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  InsufficientFundsError,
  SCALE,
  conversionInventory,
  div,
  formatAmount,
  merchantClearing,
  mul,
  mulBps,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { changeHashesEqual, founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import type { PlaceOrderRequest, VenueOrder } from '@intafaced/venue-contracts';
import type { ConversionOrder, ConversionQuote, ConversionQuoteInput } from '@intafaced/contracts';
import { loadApplicableRules, loadMerchantControl, monthlyIntake } from '../control/store.js';
import { computePricing, resolvePricingRule } from '../control/pricing.js';
import { findBlockingHalt } from '../halts/store.js';
import { postPayLedger } from '../ledger-receipt.js';
import { liveAccountsIn } from '../sandbox-ledger-guard.js';
import { ControlError } from '../control/errors.js';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { isInteractivePrincipal, requireMerchantPermission } from '../merchant-ops/roles.js';
import type { RegistryReader } from '../registries/read-api.js';
import { FRESH, PayGuardRefusal, type PayGuards } from '../seams/guards.js';
import { GUARD_HALTED, GUARD_HALT_STORE_UNAVAILABLE } from '../halts/guards.js';
import { assertOnMerchantTeam, type ConversionCaller } from './access.js';
import { ConversionError, conversionNotFound } from './errors.js';
import { classifyPlaceFailure } from './place-error.js';
import {
  CONVERSION_LATE_FILL_HORIZON_MS,
  CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK,
  HOLD_SWEEP_LOCK_A,
  HOLD_SWEEP_LOCK_B,
  LATE_FILL_SWEEP_LOCK_A,
  LATE_FILL_SWEEP_LOCK_B,
  lateFillBackoffMs,
} from './late-fill-schedule.js';
import type { ConversionSymbolFilters, ConversionVenue } from './venue.js';

const PAIR = 'USD/USDT';
const FROM = 'USD';
const TO = 'USDT';
const CLIENT_ORDER_ID_MAX = 36;
const TERMINAL = new Set(['filled', 'partially_filled', 'failed', 'reversed', 'expired']);
const OPEN_AT_VENUE = new Set<VenueOrder['status']>(['pending', 'open', 'partially_filled']);
/**
 * Technical safety floor. A venue miss is not proof the order is absent before
 * this long after the placing claim. Not a business TTL: a shorter
 * PAY_CONVERSION_PLACING_MAX_AGE_MS cannot undercut it.
 */
export const CONVERSION_ABSENT_FLOOR_MS = 15 * 60 * 1000;
/** Second miss must be at least this long after the miss stored on the proposal. */
const ABSENT_LOOK_GAP_MS = 5 * 60 * 1000;
/**
 * History search around `placing_at`. Binance accepts an order only inside
 * recvWindow of the request, so a wider scan is not where a late fill can be.
 */
export const CONVERSION_VENUE_WINDOW_LEAD_MS = 60 * 1000;
export const CONVERSION_VENUE_WINDOW_TAIL_MS = 10 * 60 * 1000;
/**
 * How often the process wakes the late-fill sweep. The per-row wait is the
 * jittered backoff in `late-fill-schedule.ts`. A venue error does not stamp
 * the row, so the next tick retries it.
 */
export { CONVERSION_LATE_FILL_TICK_MS as CONVERSION_LATE_FILL_RECHECK_MS } from './late-fill-schedule.js';
const LATE_FILL_AUDIT = 'pay.conversion_late_fill';
const LATE_FILL_BOOKED = 'pay.conversion_late_fill_booked';
const LATE_FILL_SHORTFALL = 'pay.conversion_late_fill_shortfall';
const LATE_FILL_ACK = 'pay.conversion_late_fill_acknowledged';
/**
 * Seven days from the absent-resolve confirmation. A row with no confirmed
 * absent proposal falls back to the claim instant, then to created_at.
 */
const LATE_FILL_HORIZON_ANCHOR = `COALESCE(
  (
    SELECT r.decided_at
      FROM pay.conversion_resolve_proposals r
     WHERE r.conversion_id = o.id
       AND r.status = 'confirmed'
       AND r.venue_lookup = 'absent'
     ORDER BY r.decided_at DESC NULLS LAST
     LIMIT 1
  ),
  o.placing_at,
  o.created_at
)`;

export interface ConversionServiceDeps {
  sql: Sql;
  ledger: LedgerClient;
  guards: PayGuards;
  venue: ConversionVenue;
  registries: RegistryReader;
  /**
   * Basis points taken off the bid before the limit is priced.
   * Null means the quote refuses. Zero is a configured tolerance, not a default.
   */
  slippageBps: number | null;
  /**
   * Age of a `placing` row after which a confirmed miss is reconciliation.
   * Null means that miss refuses. The row is never placed a second time.
   */
  placingMaxAgeMs: number | null;
  now?: () => Date;
  /** Test hook: runs after the venue accepts an order and before the result is written. */
  afterPlace?: (order: VenueOrder) => Promise<void>;
}

interface QuoteRow {
  id: string;
  merchant_id: string;
  settlement_id: string;
  from_asset: string;
  to_asset: string;
  from_amount: string;
  rate: string;
  fee_amount: string;
  spread_amount: string;
  minimum_output: string;
  expected_output: string;
  gross_output: string;
  commission_rate: string;
  venue_id: string;
  symbol: string;
  expires_at: Date;
  created_at: Date;
}

interface OrderRow {
  id: string;
  request_id: string;
  quote_id: string;
  merchant_id: string;
  settlement_id: string;
  attempt: number;
  client_order_id: string;
  venue_id: string;
  symbol: string;
  status: string;
  from_asset: string;
  to_asset: string;
  from_amount: string;
  filled_from_amount: string;
  filled_to_amount: string;
  fee_amount: string;
  spread_amount: string;
  minimum_output: string;
  failure_code: string | null;
  venue_order_id: string | null;
  placing_at: Date | null;
  /** Last successful late-fill history check. Null after a venue error, so the next tick retries. */
  last_checked_at: Date | null;
  /** Successful late-fill checks. Drives the backoff step. A venue error does not increment it. */
  late_fill_check_count: number;
  /** Next eligible check. Null means due now. */
  late_fill_next_check_at: Date | null;
  /** Set when the 7-day technical horizon has passed. The sweep does not call the venue again. */
  late_fill_check_final_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface Inserted {
  readonly row: OrderRow;
  /** Unique-violation loser. Must not place. */
  readonly raced: boolean;
}

const QUOTE_COLS = `id, merchant_id, settlement_id, from_asset, to_asset, from_amount::text, rate::text,
  fee_amount::text, spread_amount::text, minimum_output::text, expected_output::text, gross_output::text,
  commission_rate::text, venue_id, symbol, expires_at, created_at`;

const ORDER_COLS = `id, request_id, quote_id, merchant_id, settlement_id, attempt, client_order_id, venue_id, symbol,
  status, from_asset, to_asset, from_amount::text, filled_from_amount::text, filled_to_amount::text,
  fee_amount::text, spread_amount::text, minimum_output::text, failure_code, venue_order_id, placing_at,
  last_checked_at, late_fill_check_count, late_fill_next_check_at, late_fill_check_final_at, created_at, updated_at`;

function callerOf(principal: Principal | null): ConversionCaller {
  if (!principal?.userId) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
  return { userId: principal.userId };
}

function quoteView(row: QuoteRow): ConversionQuote {
  return {
    quoteId: row.id,
    mode: 'sandbox',
    merchantId: row.merchant_id,
    settlementId: row.settlement_id,
    fromAsset: row.from_asset,
    toAsset: row.to_asset,
    fromAmount: formatAmount(parseAmount(row.from_amount)),
    rate: formatAmount(parseAmount(row.rate)),
    feeAmount: formatAmount(parseAmount(row.fee_amount)),
    spreadAmount: formatAmount(parseAmount(row.spread_amount)),
    minimumOutput: formatAmount(parseAmount(row.minimum_output)),
    expectedOutput: formatAmount(parseAmount(row.expected_output)),
    expiresAt: row.expires_at.toISOString(),
  };
}

function orderView(row: OrderRow): ConversionOrder {
  return {
    conversionId: row.id,
    requestId: row.request_id,
    mode: 'sandbox',
    merchantId: row.merchant_id,
    settlementId: row.settlement_id,
    status: row.status as ConversionOrder['status'],
    fromAsset: row.from_asset,
    toAsset: row.to_asset,
    fromAmount: formatAmount(parseAmount(row.from_amount)),
    filledFromAmount: formatAmount(parseAmount(row.filled_from_amount)),
    filledToAmount: formatAmount(parseAmount(row.filled_to_amount)),
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Settlement uuid without dashes, then the attempt in base 36.
 * Binance and Bybit both refuse a client id longer than 36 characters.
 */
export function conversionClientOrderId(settlementId: string, attempt: number): string {
  const bare = settlementId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(bare) || !Number.isInteger(attempt) || attempt < 1) {
    throw new ConversionError('pay.conversion_client_id_invalid', 'BAD_REQUEST');
  }
  const id = `${bare}${attempt.toString(36)}`;
  if (id.length > CLIENT_ORDER_ID_MAX) throw new ConversionError('pay.conversion_client_id_invalid', 'BAD_REQUEST');
  return id;
}

/** Sell-side floor. The haircut rounds up so the quote never promises a better price than configured. */
export function conversionWorstRate(rate: Amount, slippageBps: number): Amount {
  const worst = rate - mulBps(rate, slippageBps, 'ceil');
  if (worst <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
  return worst;
}

/**
 * Limit price so a full fill at that price still meets `minimum` after
 * `commissionRate` (a fraction of quote notional). Rounded up.
 * A rate at or above 1, or a negative rate, is not a usable rate.
 */
export function conversionLimitPrice(minimum: Amount, fromAmount: Amount, commissionRate: Amount): Amount {
  if (commissionRate < 0n || commissionRate >= SCALE) {
    throw new ConversionError('pay.conversion_commission_rate_unknown', 'PRECONDITION_FAILED');
  }
  const gross = div(minimum, SCALE - commissionRate, 'ceil');
  if (gross <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
  const price = div(gross, fromAmount, 'ceil');
  if (price <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
  return price;
}

/** Next tick at or above `price`. Both values are scaled amounts, so integer division is the tick grid. */
export function roundUpToTick(price: Amount, tick: Amount): Amount {
  if (tick <= 0n || price <= 0n) throw new ConversionError('pay.conversion_filters_unconfigured', 'PRECONDITION_FAILED');
  return ((price + tick - 1n) / tick) * tick;
}

/** Whole steps at or below `quantity`. Zero is a quantity the venue will not accept. */
export function roundDownToStep(quantity: Amount, step: Amount): Amount {
  if (step <= 0n) throw new ConversionError('pay.conversion_filters_unconfigured', 'PRECONDITION_FAILED');
  if (quantity <= 0n) return 0n;
  return (quantity / step) * step;
}

interface LateFillEvidenceCanon {
  venueOrderId: string | null;
  clientOrderId: string;
  status: string;
  filled: string;
  remaining: string;
  averagePrice: string | null;
  feePaid: string | null;
  feeAsset: string | null;
}

function lateFillEvidence(order: VenueOrder): LateFillEvidenceCanon {
  return {
    venueOrderId: order.venueOrderId,
    clientOrderId: order.clientOrderId,
    status: order.status,
    filled: formatAmount(order.filled),
    remaining: formatAmount(order.remaining),
    averagePrice: order.averagePrice === null ? null : formatAmount(order.averagePrice),
    feePaid: order.feePaid === null ? null : formatAmount(order.feePaid),
    feeAsset: order.feeAsset,
  };
}

function fundingOfReason(reason: string): 'merchant' | 'inventory' {
  if (reason === 'pay.conversion.late_shortfall') return 'inventory';
  if (reason === 'pay.conversion.late_booked') return 'merchant';
  throw new ConversionError('pay.conversion_late_fill_book_conflict', 'PRECONDITION_FAILED');
}

function isIdempotencyConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ledger.idempotency_conflict';
}

function sweepFailureCode(error: unknown): string {
  if (error instanceof ConversionError) return error.code;
  if (typeof error === 'object' && error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (/^[a-z][a-z0-9_.]*$/i.test(code) && code.length <= 80) return code;
  }
  return 'pay.conversion_sweep_failed';
}

function proRate(part: Amount, filled: Amount, ordered: Amount): Amount {
  if (filled <= 0n || ordered <= 0n) return 0n;
  if (filled === ordered) return part;
  return div(mul(part, filled, 'floor'), ordered, 'floor');
}

/**
 * What the venue account received. A missing commission is not zero.
 * A commission in some other asset cannot be subtracted from USDT.
 */
function receivedQuote(order: VenueOrder): Amount {
  if (order.filled === 0n) return 0n;
  if (order.averagePrice === null || order.averagePrice <= 0n) {
    throw new ConversionError('pay.conversion_fill_unpriced', 'SERVICE_UNAVAILABLE');
  }
  const gross = mul(order.filled, order.averagePrice);
  if (order.feePaid === null || order.feePaid < 0n || order.feePaid > gross) {
    throw new ConversionError('pay.conversion_commission_unknown', 'SERVICE_UNAVAILABLE');
  }
  if (order.feePaid > 0n && order.feeAsset !== TO) {
    throw new ConversionError('pay.conversion_commission_unknown', 'SERVICE_UNAVAILABLE');
  }
  return gross - order.feePaid;
}

/**
 * Fee, spread and the gross floor are already pro-rated by filled/ordered.
 * A fill that still clears the floor is the merchant's. Anything less is
 * booked and then moved to house inventory — the venue legs stay.
 */
function splitFill(
  received: Amount,
  fee: Amount,
  spread: Amount,
  minimum: Amount,
): { kind: 'accept' | 'reverse'; merchant: Amount; fee: Amount; spread: Amount } {
  if (received >= minimum && received > fee + spread) {
    return { kind: 'accept', merchant: received - fee - spread, fee, spread };
  }
  if (received > fee + spread) {
    return { kind: 'reverse', merchant: received - fee - spread, fee, spread };
  }
  return { kind: 'reverse', merchant: received, fee: 0n, spread: 0n };
}

export class ConversionService {
  private readonly now: () => Date;

  constructor(private readonly deps: ConversionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async quote(principal: Principal | null, input: ConversionQuoteInput): Promise<ConversionQuote> {
    if (input.fromAsset !== FROM || input.toAsset !== TO) {
      throw new ConversionError('pay.conversion_pair_unsupported', 'PRECONDITION_FAILED');
    }
    await this.refuseIfLateFill();
    const caller = callerOf(principal);
    await assertOnMerchantTeam(this.deps.sql, caller, input.merchantId);
    this.assertWriteScope(principal);
    if (this.deps.slippageBps === null) {
      throw new ConversionError('pay.conversion_slippage_unconfigured', 'PRECONDITION_FAILED');
    }
    await this.assertInventoryCovered(FROM);
    const commissionRate = await this.readCommissionRate(PAIR);
    const fromAmount = parseAmount(input.fromAmount);
    if (fromAmount <= 0n) throw new ConversionError('pay.conversion_amount_invalid', 'BAD_REQUEST');

    const settlements = await this.deps.sql<Array<{ merchant_id: string; asset_id: string; net: string }>>`
      SELECT merchant_id, asset_id, net::text AS net FROM pay.settlements WHERE id = ${input.settlementId}
    `;
    const settlement = settlements[0];
    if (!settlement || settlement.merchant_id !== input.merchantId) {
      throw new ConversionError('pay.settlement_not_found', 'NOT_FOUND');
    }
    if (settlement.asset_id !== FROM) throw new ConversionError('pay.conversion_settlement_asset', 'PRECONDITION_FAILED');
    if (fromAmount > parseAmount(settlement.net)) {
      throw new ConversionError('pay.conversion_exceeds_settlement', 'PRECONDITION_FAILED');
    }

    const venues = await this.deps.registries.venuesFor({ pair: PAIR, amount: formatAmount(fromAmount) });
    const venue = venues.find((candidate) => candidate.venueId === this.deps.venue.venueId);
    if (!venue) throw new ConversionError('pay.conversion_venue_unconfigured', 'PRECONDITION_FAILED');

    const control = await loadMerchantControl(this.deps.sql, input.merchantId);
    const rules = await loadApplicableRules(this.deps.sql, input.merchantId, control.profile?.tierId ?? null, FROM);
    const resolved = resolvePricingRule(rules, FROM);
    if (!resolved) throw new ConversionError('pay.pricing_unconfigured', 'PRECONDITION_FAILED');
    const volume = await monthlyIntake(this.deps.sql, input.merchantId, FROM, this.now());
    const priced = computePricing(resolved.rule, { amount: fromAmount, monthlyVolumeBefore: volume, conversion: true });

    const quoted = await this.deps.venue.quote({ symbol: PAIR, fromAmount, now: this.now() });
    if (quoted.expiresAt.getTime() <= this.now().getTime()) {
      throw new ConversionError('pay.conversion_quote_expired', 'PRECONDITION_FAILED');
    }
    const worst = conversionWorstRate(quoted.rateScaled, this.deps.slippageBps);
    const gross = mul(fromAmount, worst);
    if (gross <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    const feeTo = mul(priced.fee, worst);
    const spreadTo = mul(priced.spread ?? 0n, worst);
    const expected = gross - feeTo - spreadTo;
    if (expected <= 0n) throw new ConversionError('pay.conversion_output_non_positive', 'PRECONDITION_FAILED');

    const id = randomUUID();
    const rows = await this.deps.sql<QuoteRow[]>`
      INSERT INTO pay.conversion_quotes (
        id, merchant_id, settlement_id, from_asset, to_asset, from_amount, rate,
        fee_amount, spread_amount, minimum_output, expected_output, gross_output, commission_rate,
        venue_id, symbol, expires_at
      ) VALUES (
        ${id}, ${input.merchantId}, ${input.settlementId}, ${FROM}, ${TO},
        ${formatAmount(fromAmount)}::numeric, ${formatAmount(worst)}::numeric,
        ${formatAmount(feeTo)}::numeric, ${formatAmount(spreadTo)}::numeric,
        ${formatAmount(gross)}::numeric, ${formatAmount(expected)}::numeric,
        ${formatAmount(gross)}::numeric, ${formatAmount(commissionRate)}::numeric,
        ${venue.venueId}, ${PAIR}, ${quoted.expiresAt}
      ) RETURNING ${this.deps.sql.unsafe(QUOTE_COLS)}
    `;
    return quoteView(rows[0]!);
  }

  async execute(principal: Principal | null, input: { requestId: string; quoteId: string }): Promise<ConversionOrder> {
    // D-145 lets a key pay out to a verified destination. It does not let a key, or a sub-account, convert.
    if (principal && (principal.kid !== undefined || principal.sub_account !== undefined) && !isInteractivePrincipal(principal)) {
      throw new ControlError('pay.interactive_required');
    }
    if (principal?.key_env === 'sandbox') {
      // A sandbox key must not hold, book, release, or reverse conversion value. Those recipes name live pots.
      const probe = recipes.fxConversionHold({
        conversionId: input.requestId,
        merchantId: 'sandbox-refused',
        fromAsset: 'USDT',
        amount: 1n,
      });
      if (liveAccountsIn(probe).length > 0) {
        throw new ConversionError('pay.sandbox_live_account_refused', 'FORBIDDEN');
      }
    }
    await this.refuseIfLateFill();
    const caller = callerOf(principal);
    const existing = await this.orderByRequest(input.requestId);
    if (existing) {
      await this.seeOrder(caller, existing);
      await this.assertApprover(principal, existing.merchant_id);
      return this.resume(existing, true);
    }
    const quote = await this.quoteById(input.quoteId);
    if (!quote) throw conversionNotFound();
    try {
      await assertOnMerchantTeam(this.deps.sql, caller, quote.merchant_id);
    } catch (error) {
      if (error instanceof ConversionError && error.code === 'pay.merchant_not_found') throw conversionNotFound();
      throw error;
    }
    await this.assertApprover(principal, quote.merchant_id);
    await this.assertInventoryCovered(quote.from_asset);
    if (quote.expires_at.getTime() <= this.now().getTime()) {
      const expired = await this.insertOrder(quote, input.requestId, 'expired', 'pay.conversion_quote_expired');
      return orderView(expired.row);
    }
    const intent = await this.insertOrder(quote, input.requestId, 'intent_committed', null);
    if (intent.raced || intent.row.status !== 'intent_committed') return orderView(intent.row);
    return this.resume(intent.row, true);
  }

  async get(principal: Principal | null, conversionId: string): Promise<ConversionOrder> {
    const caller = callerOf(principal);
    const row = await this.orderById(conversionId);
    if (!row) throw conversionNotFound();
    await this.seeOrder(caller, row);
    return orderView(row);
  }

  async list(principal: Principal | null, input: { merchantId: string; status?: string; limit: number }): Promise<ConversionOrder[]> {
    const caller = callerOf(principal);
    await assertOnMerchantTeam(this.deps.sql, caller, input.merchantId);
    const rows = input.status
      ? await this.deps.sql<OrderRow[]>`
          SELECT ${this.deps.sql.unsafe(ORDER_COLS)} FROM pay.conversion_orders
           WHERE merchant_id = ${input.merchantId} AND status = ${input.status}
           ORDER BY created_at DESC, id DESC
           LIMIT ${input.limit}
        `
      : await this.deps.sql<OrderRow[]>`
          SELECT ${this.deps.sql.unsafe(ORDER_COLS)} FROM pay.conversion_orders
           WHERE merchant_id = ${input.merchantId}
           ORDER BY created_at DESC, id DESC
           LIMIT ${input.limit}
        `;
    return rows.map(orderView);
  }

  /**
   * First founder proposes an exit for a `placing` row. The hash binds the row
   * id and the instant it was last written. No amount is taken from the caller.
   */
  async proposeResolve(
    founderUserId: string,
    input: { requestId: string; conversionId: string; reason: string },
  ): Promise<{ requestId: string; status: 'pending' | 'missing' | 'not_placing' | 'conflict'; changeHash: string | null }> {
    const actor = founderUserId.trim().toLowerCase();
    const existing = await this.resolveProposal(input.requestId);
    if (existing) {
      if (existing.conversion_id !== input.conversionId) {
        return { requestId: input.requestId, status: 'conflict', changeHash: null };
      }
      return {
        requestId: input.requestId,
        status: existing.status === 'pending' ? 'pending' : 'conflict',
        changeHash: existing.change_hash,
      };
    }
    const row = await this.orderById(input.conversionId);
    if (!row) return { requestId: input.requestId, status: 'missing', changeHash: null };
    if (row.status !== 'placing') return { requestId: input.requestId, status: 'not_placing', changeHash: null };
    const changeHash = this.resolveHash(row);
    const evidence = await this.lookup(row);
    const lookedUpAt = this.now();
    await this.deps.sql`
      INSERT INTO pay.conversion_resolve_proposals (
        request_id, conversion_id, change_hash, reason, proposed_by, status, venue_lookup, venue_lookup_at
      ) VALUES (
        ${input.requestId}, ${row.id}, ${changeHash}, ${input.reason}, ${actor}, 'pending',
        ${evidence ? 'present' : 'absent'}, ${lookedUpAt}
      )
    `;
    await this.audit(row.id, 'resolve_proposed', actor, null, { changeHash });
    return { requestId: input.requestId, status: 'pending', changeHash };
  }

  /**
   * Second founder confirms. The fill or the release comes from the venue
   * lookup, never from a number on this call.
   */
  async confirmResolve(
    founderUserId: string,
    input: { requestId: string; decision: 'confirm' | 'reject'; reason: string; expectedChangeHash: string },
  ): Promise<{
    requestId: string;
    status: 'confirmed' | 'rejected' | 'missing' | 'hash_mismatch' | 'same_founder' | 'not_placing';
    changeHash: string | null;
    order: ConversionOrder | null;
  }> {
    const actor = founderUserId.trim().toLowerCase();
    const proposal = await this.resolveProposal(input.requestId);
    if (!proposal) return { requestId: input.requestId, status: 'missing', changeHash: null, order: null };
    if (proposal.status === 'confirmed') {
      const row = await this.orderById(proposal.conversion_id);
      return { requestId: input.requestId, status: 'confirmed', changeHash: proposal.change_hash, order: row ? orderView(row) : null };
    }
    if (proposal.status === 'rejected') {
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, order: null };
    }
    if (!changeHashesEqual(proposal.change_hash, input.expectedChangeHash)) {
      return { requestId: input.requestId, status: 'hash_mismatch', changeHash: proposal.change_hash, order: null };
    }
    if (proposal.proposed_by === actor) {
      return { requestId: input.requestId, status: 'same_founder', changeHash: proposal.change_hash, order: null };
    }
    const row = await this.orderById(proposal.conversion_id);
    if (!row || row.status !== 'placing' || !changeHashesEqual(this.resolveHash(row), proposal.change_hash)) {
      return { requestId: input.requestId, status: 'not_placing', changeHash: proposal.change_hash, order: null };
    }
    if (input.decision === 'reject') {
      await this.deps.sql`
        UPDATE pay.conversion_resolve_proposals
           SET status = 'rejected', confirmed_by = ${actor}, decided_at = now()
         WHERE request_id = ${input.requestId} AND status = 'pending'
      `;
      await this.audit(row.id, 'resolve_rejected', proposal.proposed_by, actor, { changeHash: proposal.change_hash });
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, order: null };
    }
    const evidence = await this.lookup(row);
    if (!evidence) this.assertAbsentProven(row, proposal);
    const applied = await this.deps.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const locked = await tx<OrderRow[]>`
        SELECT ${tx.unsafe(ORDER_COLS)} FROM pay.conversion_orders
         WHERE id = ${row.id}
           AND status = 'placing'
           AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ${row.updated_at}::timestamptz)
         FOR UPDATE
      `;
      if (!locked[0]) return null;
      if (!evidence) {
        return this.mark(locked[0].id, { status: 'failed', failureCode: 'pay.conversion_resolve_absent' }, tx);
      }
      return this.bookIn(tx, locked[0], evidence);
    });
    if (!applied) {
      return { requestId: input.requestId, status: 'not_placing', changeHash: proposal.change_hash, order: null };
    }
    let settled = applied;
    if (!evidence) {
      await this.releaseHold(applied, parseAmount(applied.from_amount), 0);
      settled = (await this.orderById(applied.id)) ?? applied;
    }
    await this.deps.sql`
      UPDATE pay.conversion_resolve_proposals
         SET status = 'confirmed', confirmed_by = ${actor}, decided_at = now()
       WHERE request_id = ${input.requestId} AND status = 'pending'
    `;
    await this.audit(row.id, 'resolve_confirmed', proposal.proposed_by, actor, {
      changeHash: proposal.change_hash,
      venueStatus: evidence?.status ?? 'absent',
      venueOrderId: evidence?.venueOrderId ?? null,
    });
    return { requestId: input.requestId, status: 'confirmed', changeHash: proposal.change_hash, order: orderView(settled) };
  }

  /**
   * Release holds whose conversion row is failed or gone. A live row is left
   * alone. The amount released is the hold the ledger still has, not a figure
   * supplied by the caller. One replica per pass: a busy lock returns without
   * releasing anything.
   */
  async sweepOrphanHolds(
    founderUserId: string,
  ): Promise<{ released: number; failures: Array<{ conversionId: string; code: string }>; busy: boolean }> {
    const actor = founderUserId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    return this.withAdvisoryLock(HOLD_SWEEP_LOCK_A, HOLD_SWEEP_LOCK_B, { released: 0, failures: [], busy: true }, async () => {
      return this.sweepOrphanHoldsLocked(actor);
    });
  }

  private async sweepOrphanHoldsLocked(
    actor: string,
  ): Promise<{ released: number; failures: Array<{ conversionId: string; code: string }>; busy: boolean }> {
    const merchants = await this.deps.sql<Array<{ id: string }>>`SELECT id FROM pay.merchants`;
    let released = 0;
    const failures: Array<{ conversionId: string; code: string }> = [];
    for (const merchant of merchants) {
      const balances = await this.deps.ledger.balances('module', `pay:clearing:${merchant.id}`);
      for (const balance of balances) {
        const purpose = balance.account.purpose ?? '';
        if (balance.account.kind !== 'hold' || !purpose.startsWith('conversion:') || balance.amount <= 0n) continue;
        const conversionId = purpose.slice('conversion:'.length);
        try {
          const row = await this.orderById(conversionId);
          if (row && row.status !== 'failed' && row.status !== 'expired') continue;
          await postPayLedger(
            this.deps.ledger,
            recipes.fxConversionRelease({
              conversionId,
              merchantId: merchant.id,
              fromAsset: balance.account.assetId,
              amount: balance.amount,
              sequence: 0,
            }),
          );
          await this.audit(row?.id ?? null, 'hold_swept', actor, null, { conversionId, amount: formatAmount(balance.amount) });
          released += 1;
        } catch (error) {
          failures.push({ conversionId, code: sweepFailureCode(error) });
        }
      }
    }
    return { released, failures, busy: false };
  }

  /**
   * First founder names how a late fill was settled. The hash binds the audit
   * row and that sentence. No amount is taken from the caller, and nothing is booked.
   */
  async proposeLateFillAck(
    founderUserId: string,
    input: { requestId: string; auditId: string; settlement: string; reason: string },
  ): Promise<{ requestId: string; status: 'pending' | 'missing' | 'conflict' | 'already_acked'; changeHash: string | null }> {
    const actor = founderUserId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    const settlement = input.settlement.trim();
    const reason = input.reason.trim();
    if (!settlement || !reason) throw new ConversionError('pay.conversion_late_fill_ack_invalid', 'BAD_REQUEST');
    const existing = await this.lateFillAckByRequest(input.requestId);
    if (existing) {
      if (existing.audit_id !== input.auditId || existing.settlement !== settlement) {
        return { requestId: input.requestId, status: 'conflict', changeHash: null };
      }
      return {
        requestId: input.requestId,
        status: existing.status === 'confirmed' ? 'already_acked' : existing.status === 'pending' ? 'pending' : 'conflict',
        changeHash: existing.change_hash,
      };
    }
    const audit = await this.lateFillAudit(input.auditId);
    if (!audit) return { requestId: input.requestId, status: 'missing', changeHash: null };
    const confirmed = await this.lateFillAckForAudit(audit.id, 'confirmed');
    if (confirmed) return { requestId: input.requestId, status: 'already_acked', changeHash: confirmed.change_hash };
    const pending = await this.lateFillAckForAudit(audit.id, 'pending');
    if (pending) return { requestId: input.requestId, status: 'conflict', changeHash: null };
    const changeHash = this.lateFillHash(audit, settlement);
    try {
      await this.deps.sql`
        INSERT INTO pay.conversion_late_fill_acks (
          request_id, audit_id, conversion_id, change_hash, settlement, reason, proposed_by, status
        ) VALUES (
          ${input.requestId}, ${audit.id}, ${audit.conversion_id}, ${changeHash}, ${settlement}, ${reason}, ${actor}, 'pending'
        )
      `;
    } catch (error) {
      const pg = error as { code?: string } | null;
      if (pg?.code === '23505') return { requestId: input.requestId, status: 'conflict', changeHash: null };
      throw error;
    }
    await this.audit(audit.conversion_id, 'late_fill_ack_proposed', actor, null, { changeHash, auditId: audit.id });
    return { requestId: input.requestId, status: 'pending', changeHash };
  }

  /**
   * Second founder confirms the same hash. Confirming records the settlement
   * sentence. It does not book the fill and it does not clear a halt.
   */
  async confirmLateFillAck(
    founderUserId: string,
    input: { requestId: string; decision: 'confirm' | 'reject'; reason: string; expectedChangeHash: string },
  ): Promise<{
    requestId: string;
    status: 'confirmed' | 'rejected' | 'missing' | 'hash_mismatch' | 'same_founder' | 'not_pending';
    changeHash: string | null;
    settlement: string | null;
  }> {
    const actor = founderUserId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    const proposal = await this.lateFillAckByRequest(input.requestId);
    if (!proposal) return { requestId: input.requestId, status: 'missing', changeHash: null, settlement: null };
    if (proposal.status === 'confirmed') {
      return { requestId: input.requestId, status: 'confirmed', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    if (proposal.status === 'rejected') {
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    if (!changeHashesEqual(proposal.change_hash, input.expectedChangeHash)) {
      return { requestId: input.requestId, status: 'hash_mismatch', changeHash: proposal.change_hash, settlement: null };
    }
    if (proposal.proposed_by === actor) {
      return { requestId: input.requestId, status: 'same_founder', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    const audit = await this.lateFillAudit(proposal.audit_id);
    if (!audit || !changeHashesEqual(this.lateFillHash(audit, proposal.settlement), proposal.change_hash)) {
      return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    if (input.decision === 'reject') {
      const rejected = await this.deps.sql<Array<{ request_id: string }>>`
        UPDATE pay.conversion_late_fill_acks
           SET status = 'rejected', confirmed_by = ${actor}, decided_at = now()
         WHERE request_id = ${input.requestId} AND status = 'pending'
         RETURNING request_id
      `;
      if (!rejected[0]) {
        return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, settlement: proposal.settlement };
      }
      await this.audit(audit.conversion_id, 'late_fill_ack_rejected', proposal.proposed_by, actor, { changeHash: proposal.change_hash });
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    const updated = await this.deps.sql<Array<{ request_id: string }>>`
      UPDATE pay.conversion_late_fill_acks
         SET status = 'confirmed', confirmed_by = ${actor}, decided_at = now()
       WHERE request_id = ${input.requestId} AND status = 'pending'
       RETURNING request_id
    `;
    if (!updated[0]) {
      return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, settlement: proposal.settlement };
    }
    await this.audit(audit.conversion_id, 'pay.conversion_late_fill_acknowledged', proposal.proposed_by, actor, {
      changeHash: proposal.change_hash,
      auditId: audit.id,
      settlement: proposal.settlement,
    });
    return { requestId: input.requestId, status: 'confirmed', changeHash: proposal.change_hash, settlement: proposal.settlement };
  }

  /**
   * First founder asks to book a detected late fill. The hash binds the audit
   * row and the venue evidence fetched here. The body carries no amount.
   */
  async proposeLateFillBook(
    founderUserId: string,
    input: { requestId: string; auditId: string; reason: string },
  ): Promise<{
    requestId: string;
    status: 'pending' | 'missing' | 'conflict' | 'already_booked' | 'absent' | 'below_minimum' | 'not_bookable';
    changeHash: string | null;
  }> {
    const actor = founderUserId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    const reason = input.reason.trim();
    if (!reason) throw new ConversionError('pay.conversion_late_fill_book_invalid', 'BAD_REQUEST');
    const existing = await this.lateFillBookByRequest(input.requestId);
    if (existing) {
      if (existing.audit_id !== input.auditId) return { requestId: input.requestId, status: 'conflict', changeHash: null };
      if (existing.status === 'confirmed')
        return { requestId: input.requestId, status: 'already_booked', changeHash: existing.change_hash };
      if (existing.status === 'pending') return { requestId: input.requestId, status: 'pending', changeHash: existing.change_hash };
      return { requestId: input.requestId, status: 'conflict', changeHash: null };
    }
    const audit = await this.lateFillAudit(input.auditId);
    if (!audit) return { requestId: input.requestId, status: 'missing', changeHash: null };
    const confirmed = await this.lateFillBookForAudit(audit.id, 'confirmed');
    if (confirmed) return { requestId: input.requestId, status: 'already_booked', changeHash: confirmed.change_hash };
    const pending = await this.lateFillBookForAudit(audit.id, 'pending');
    if (pending) return { requestId: input.requestId, status: 'conflict', changeHash: null };
    const row = await this.orderById(audit.conversion_id);
    if (!row || row.status !== 'failed' || row.failure_code !== 'pay.conversion_resolve_absent') {
      return { requestId: input.requestId, status: 'not_bookable', changeHash: null };
    }
    const evidence = await this.lookupLateFill(row);
    const economics = evidence ? this.lateFillEconomics(row, evidence) : null;
    if (!evidence || !economics) return { requestId: input.requestId, status: 'absent', changeHash: null };
    const canonical = lateFillEvidence(evidence);
    const changeHash = this.lateFillBookHash(audit, canonical);
    try {
      await this.deps.sql`
        INSERT INTO pay.conversion_late_fill_books (
          request_id, audit_id, conversion_id, change_hash, reason, evidence, proposed_by, status
        ) VALUES (
          ${input.requestId}, ${audit.id}, ${audit.conversion_id}, ${changeHash}, ${reason},
          ${this.deps.sql.json(canonical as never)}, ${actor}, 'pending'
        )
      `;
    } catch (error) {
      const pg = error as { code?: string } | null;
      if (pg?.code === '23505') return { requestId: input.requestId, status: 'conflict', changeHash: null };
      throw error;
    }
    await this.audit(audit.conversion_id, 'late_fill_book_proposed', actor, null, { changeHash, auditId: audit.id });
    return { requestId: input.requestId, status: 'pending', changeHash };
  }

  /**
   * Second founder confirms the hash. Confirm fetches the venue again and
   * posts only when that evidence still matches the hash. Amounts come from
   * the venue order and the original order's fee and spread, never from the
   * founder. Idempotent on the audit row.
   */
  async confirmLateFillBook(
    founderUserId: string,
    input: { requestId: string; decision: 'confirm' | 'reject'; reason: string; expectedChangeHash: string },
  ): Promise<{
    requestId: string;
    status:
      | 'confirmed'
      | 'rejected'
      | 'missing'
      | 'hash_mismatch'
      | 'same_founder'
      | 'not_pending'
      | 'evidence_changed'
      | 'below_minimum'
      | 'already_booked';
    changeHash: string | null;
    funding: 'merchant' | 'inventory' | null;
    order: ReturnType<typeof orderView> | null;
  }> {
    const actor = founderUserId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    const proposal = await this.lateFillBookByRequest(input.requestId);
    if (!proposal) return { requestId: input.requestId, status: 'missing', changeHash: null, funding: null, order: null };
    if (proposal.status === 'confirmed') {
      const booked = await this.orderById(proposal.conversion_id);
      return {
        requestId: input.requestId,
        status: 'confirmed',
        changeHash: proposal.change_hash,
        funding: proposal.funding,
        order: booked ? orderView(booked) : null,
      };
    }
    if (proposal.status === 'rejected') {
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, funding: null, order: null };
    }
    if (!changeHashesEqual(proposal.change_hash, input.expectedChangeHash)) {
      return { requestId: input.requestId, status: 'hash_mismatch', changeHash: proposal.change_hash, funding: null, order: null };
    }
    if (proposal.proposed_by === actor) {
      return { requestId: input.requestId, status: 'same_founder', changeHash: proposal.change_hash, funding: null, order: null };
    }
    const audit = await this.lateFillAudit(proposal.audit_id);
    if (!audit) return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, funding: null, order: null };
    if (input.decision === 'reject') {
      const rejected = await this.deps.sql<Array<{ request_id: string }>>`
        UPDATE pay.conversion_late_fill_books
           SET status = 'rejected', confirmed_by = ${actor}, decided_at = now()
         WHERE request_id = ${input.requestId} AND status = 'pending'
         RETURNING request_id
      `;
      if (!rejected[0]) {
        return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, funding: null, order: null };
      }
      await this.audit(audit.conversion_id, 'late_fill_book_rejected', proposal.proposed_by, actor, { changeHash: proposal.change_hash });
      return { requestId: input.requestId, status: 'rejected', changeHash: proposal.change_hash, funding: null, order: null };
    }
    const row = await this.orderById(audit.conversion_id);
    if (!row) return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, funding: null, order: null };
    const evidence = await this.lookupLateFill(row);
    const economics = evidence ? this.lateFillEconomics(row, evidence) : null;
    if (!evidence || !economics || !changeHashesEqual(this.lateFillBookHash(audit, lateFillEvidence(evidence)), proposal.change_hash)) {
      return { requestId: input.requestId, status: 'evidence_changed', changeHash: proposal.change_hash, funding: null, order: null };
    }
    const inventoryOnly = economics.kind === 'reverse';
    const key = `pay.conversion.late:${audit.id}`;
    const already = await this.deps.ledger.getTxByKey(key);
    let funding = already ? fundingOfReason(already.reason) : proposal.funding;
    if (!already && (inventoryOnly || !funding)) {
      if (inventoryOnly) {
        funding = 'inventory';
      } else {
        const clearing = await this.deps.ledger.balance(merchantClearing(row.merchant_id, row.from_asset));
        funding = clearing.amount >= economics.filled ? 'merchant' : 'inventory';
      }
      await this.deps.sql`
        UPDATE pay.conversion_late_fill_books
           SET funding = ${funding}
         WHERE request_id = ${input.requestId} AND status = 'pending'
      `;
      const stored = await this.lateFillBookByRequest(input.requestId);
      funding = inventoryOnly ? 'inventory' : (stored?.funding ?? funding);
    }
    if (!funding)
      return { requestId: input.requestId, status: 'not_pending', changeHash: proposal.change_hash, funding: null, order: null };
    if (!already) {
      try {
        await this.postLateFill(audit.id, row, economics, funding);
      } catch (error) {
        if (funding === 'merchant' && error instanceof InsufficientFundsError) {
          funding = 'inventory';
          await this.deps.sql`
            UPDATE pay.conversion_late_fill_books
               SET funding = 'inventory'
             WHERE request_id = ${input.requestId} AND status = 'pending'
          `;
          const raced = await this.deps.ledger.getTxByKey(key);
          if (!raced) await this.postLateFill(audit.id, row, economics, 'inventory');
          else funding = fundingOfReason(raced.reason);
        } else if (isIdempotencyConflict(error)) {
          const raced = await this.deps.ledger.getTxByKey(key);
          if (!raced) throw error;
          funding = fundingOfReason(raced.reason);
        } else {
          throw error;
        }
      }
    }
    const settled = await this.finishLateFillBook(proposal, actor, audit, row, evidence, economics, funding);
    return {
      requestId: input.requestId,
      status: 'confirmed',
      changeHash: proposal.change_hash,
      funding,
      order: orderView(settled),
    };
  }

  /**
   * Re-query resolve-absent rows for a fill the earlier miss did not see.
   * Founder calls pass `force` so a backoff stamp does not skip the row.
   * Force does not reopen a row past the 7-day horizon, counted from the
   * absent-resolve confirmation (or placing_at when that confirmation is missing).
   * A venue or rate error is counted and left unstamped. It does not throw.
   * One replica holds the tick lock. A busy lock makes no venue calls.
   */
  async sweepLateFills(
    actorId: string,
    opts?: { force?: boolean },
  ): Promise<{
    checked: number;
    found: number;
    finalized: number;
    busy: boolean;
    errors: Array<{ conversionId: string; code: string }>;
  }> {
    const actor = actorId.trim().toLowerCase();
    if (!actor) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    const idle = { checked: 0, found: 0, finalized: 0, busy: true, errors: [] as Array<{ conversionId: string; code: string }> };
    return this.withAdvisoryLock(LATE_FILL_SWEEP_LOCK_A, LATE_FILL_SWEEP_LOCK_B, idle, async (conn) => {
      return this.sweepLateFillsLocked(conn, actor, opts?.force === true);
    });
  }

  private async sweepLateFillsLocked(
    conn: Sql,
    actor: string,
    force: boolean,
  ): Promise<{
    checked: number;
    found: number;
    finalized: number;
    busy: boolean;
    errors: Array<{ conversionId: string; code: string }>;
  }> {
    const now = this.now();
    const horizon = new Date(now.getTime() - CONVERSION_LATE_FILL_HORIZON_MS);
    const finalizedRows = await conn<Array<{ id: string }>>`
      UPDATE pay.conversion_orders o
         SET late_fill_check_final_at = ${now}
       WHERE o.status = 'failed'
         AND o.failure_code = 'pay.conversion_resolve_absent'
         AND o.late_fill_check_final_at IS NULL
         AND ${conn.unsafe(LATE_FILL_HORIZON_ANCHOR)} <= ${horizon}
         AND NOT EXISTS (
           SELECT 1 FROM pay.conversion_audit a
            WHERE a.conversion_id = o.id AND a.action = ${LATE_FILL_AUDIT}
         )
       RETURNING id
    `;
    const rows = await conn<OrderRow[]>`
      SELECT ${conn.unsafe(ORDER_COLS)} FROM pay.conversion_orders o
       WHERE o.status = 'failed'
         AND o.failure_code = 'pay.conversion_resolve_absent'
         AND o.late_fill_check_final_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pay.conversion_audit a
            WHERE a.conversion_id = o.id AND a.action = ${LATE_FILL_AUDIT}
         )
         AND (${force} OR o.late_fill_next_check_at IS NULL OR o.late_fill_next_check_at <= ${now})
         AND ${conn.unsafe(LATE_FILL_HORIZON_ANCHOR)} > ${horizon}
       ORDER BY o.late_fill_next_check_at NULLS FIRST, o.id
       LIMIT ${CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK}
    `;
    let checked = 0;
    let found = 0;
    const errors: Array<{ conversionId: string; code: string }> = [];
    for (const row of rows) {
      let evidence: VenueOrder | null;
      try {
        evidence = await this.lookup(row);
      } catch (error) {
        errors.push({ conversionId: row.id, code: sweepFailureCode(error) });
        continue;
      }
      checked += 1;
      const checks = Number(row.late_fill_check_count) + 1;
      const next = new Date(now.getTime() + lateFillBackoffMs(row.id, checks));
      await conn`
        UPDATE pay.conversion_orders
           SET last_checked_at = ${now},
               late_fill_check_count = ${checks},
               late_fill_next_check_at = ${next}
         WHERE id = ${row.id}
           AND late_fill_check_final_at IS NULL
      `;
      if (!evidence || evidence.filled <= 0n) continue;
      const inserted = await this.recordLateFill(row, evidence, actor);
      if (inserted) found += 1;
    }
    return { checked, found, finalized: finalizedRows.length, busy: false, errors };
  }

  private resolveHash(row: OrderRow): string {
    return founderChangeHash(
      { kind: 'conversion_resolve', conversionId: row.id, clientOrderId: row.client_order_id, status: row.status },
      row.updated_at.toISOString(),
    );
  }

  private async resolveProposal(requestId: string): Promise<{
    request_id: string;
    conversion_id: string;
    change_hash: string;
    proposed_by: string;
    status: string;
    venue_lookup: string;
    venue_lookup_at: Date;
  } | null> {
    const rows = await this.deps.sql<
      Array<{
        request_id: string;
        conversion_id: string;
        change_hash: string;
        proposed_by: string;
        status: string;
        venue_lookup: string;
        venue_lookup_at: Date;
      }>
    >`
      SELECT request_id, conversion_id, change_hash, proposed_by, status, venue_lookup, venue_lookup_at
        FROM pay.conversion_resolve_proposals
       WHERE request_id = ${requestId}
    `;
    return rows[0] ?? null;
  }

  private async audit(
    conversionId: string | null,
    action: string,
    actorId: string,
    approverId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.sql`
      INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
      VALUES (${randomUUID()}, ${conversionId}, ${action}, ${actorId}, ${approverId}, ${this.deps.sql.json(detail as never)})
    `;
  }

  private assertWriteScope(principal: Principal | null): void {
    if (!principal?.scopes?.includes('pay:write')) {
      throw new ConversionError('pay.conversion_forbidden', 'FORBIDDEN');
    }
  }

  /** `pay:payout` is the transport scope. Moving the settlement also needs `payout.approve`. */
  private async assertApprover(principal: Principal | null, merchantId: string): Promise<void> {
    if (!principal) throw new ConversionError('pay.conversion_unauthenticated', 'BAD_REQUEST');
    try {
      const approver = await requireMerchantPermission(this.deps.sql, principal, 'payout.approve');
      if (approver.merchantId !== merchantId) throw conversionNotFound();
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      if (error instanceof MerchantOpsError && error.code === 'pay.merchant_ops_not_merchant') throw conversionNotFound();
      if (error instanceof MerchantOpsError && error.code === 'pay.team_role_forbidden') {
        throw new ConversionError('pay.team_role_forbidden', 'FORBIDDEN');
      }
      throw error;
    }
  }

  private async seeOrder(caller: ConversionCaller, row: OrderRow): Promise<void> {
    try {
      await assertOnMerchantTeam(this.deps.sql, caller, row.merchant_id);
    } catch (error) {
      if (error instanceof ConversionError && error.code === 'pay.merchant_not_found') throw conversionNotFound();
      throw error;
    }
  }

  private async insertOrder(
    quote: QuoteRow,
    requestId: string,
    status: 'intent_committed' | 'expired',
    failure: string | null,
  ): Promise<Inserted> {
    try {
      return await this.deps.sql.begin(async (raw) => {
        const tx = raw as unknown as Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.conversion:${quote.settlement_id}`}))`;
        const taken = await tx<Array<{ request_id: string }>>`
          SELECT request_id FROM pay.conversion_orders WHERE quote_id = ${quote.id}
        `;
        if (taken[0]) {
          if (taken[0].request_id !== requestId) {
            throw new ConversionError('pay.conversion_quote_consumed', 'PRECONDITION_FAILED');
          }
          const raced = await tx<OrderRow[]>`
            SELECT ${tx.unsafe(ORDER_COLS)} FROM pay.conversion_orders WHERE request_id = ${requestId}
          `;
          return { row: raced[0]!, raced: true };
        }
        const locked = await tx<Array<{ net: string }>>`
          SELECT net::text AS net FROM pay.settlements WHERE id = ${quote.settlement_id} FOR UPDATE
        `;
        const net = locked[0]?.net;
        if (net === undefined) throw new ConversionError('pay.settlement_not_found', 'NOT_FOUND');
        const requested = parseAmount(quote.from_amount);
        const filledBefore = await tx<Array<{ filled: string }>>`
          SELECT COALESCE(SUM(filled_from_amount), 0)::text AS filled
            FROM pay.conversion_orders
           WHERE settlement_id = ${quote.settlement_id}
        `;
        if (requested > parseAmount(net) || parseAmount(filledBefore[0]?.filled ?? '0') + requested > parseAmount(net)) {
          throw new ConversionError('pay.conversion_exceeds_settlement', 'PRECONDITION_FAILED');
        }
        const prior = await tx<Array<{ n: number }>>`
          SELECT COALESCE(MAX(attempt), 0)::int AS n FROM pay.conversion_orders WHERE settlement_id = ${quote.settlement_id}
        `;
        const attempt = Number(prior[0]?.n ?? 0) + 1;
        if (status === 'intent_committed') {
          await this.deps.guards.beforeConversion({
            sql: this.deps.sql,
            tx,
            merchantId: quote.merchant_id,
            settlementId: quote.settlement_id,
            fromAsset: quote.from_asset,
            toAsset: quote.to_asset,
            fromAmount: parseAmount(quote.from_amount),
            replay: FRESH,
          });
        }
        const id = randomUUID();
        const rows = await tx<OrderRow[]>`
          INSERT INTO pay.conversion_orders (
            id, request_id, quote_id, merchant_id, settlement_id, attempt, client_order_id, venue_id, symbol,
            status, from_asset, to_asset, from_amount, filled_from_amount, filled_to_amount,
            fee_amount, spread_amount, minimum_output, failure_code
          ) VALUES (
            ${id}, ${requestId}, ${quote.id}, ${quote.merchant_id}, ${quote.settlement_id}, ${attempt},
            ${conversionClientOrderId(quote.settlement_id, attempt)}, ${quote.venue_id}, ${quote.symbol},
            ${status}, ${quote.from_asset}, ${quote.to_asset}, ${quote.from_amount}::numeric, 0, 0,
            ${quote.fee_amount}::numeric, ${quote.spread_amount}::numeric, ${quote.minimum_output}::numeric, ${failure}
          ) RETURNING ${tx.unsafe(ORDER_COLS)}
        `;
        const row = rows[0]!;
        return { row, raced: false };
      });
    } catch (error) {
      const pg = error as { code?: string; constraint_name?: string } | null;
      if (pg?.code === '23505') {
        const raced = await this.orderByRequest(requestId);
        if (raced) return { row: raced, raced: true };
        if (pg.constraint_name === 'conversion_orders_one_live_idx') {
          throw new ConversionError('pay.conversion_settlement_live', 'PRECONDITION_FAILED');
        }
        throw new ConversionError('pay.conversion_quote_consumed', 'PRECONDITION_FAILED');
      }
      throw error;
    }
  }

  /**
   * `mayPlace` is false for the unique-violation loser: they return the row
   * and do not call the venue. A row that is already `placing` never places.
   *
   * The hold is posted here, after the intent row has committed, and outside
   * the `pay.treasury:USD` lock that `beforeConversion` holds only for that
   * transaction. The ledger key is the row id, so a timeout that actually
   * posted is the same hold on the next attempt.
   */
  private async resume(row: OrderRow, mayPlace: boolean): Promise<ConversionOrder> {
    const fresh = (await this.orderById(row.id)) ?? row;
    if (TERMINAL.has(fresh.status)) return orderView(fresh);
    if (fresh.status === 'placing' || fresh.status === 'placed') return this.reconcile(fresh);
    if (fresh.status !== 'intent_committed' || !mayPlace) return orderView(fresh);

    const found = await this.lookup(fresh);
    if (found) {
      const unfunded = await this.ensureHold(fresh);
      if (unfunded) return orderView(unfunded);
      const claimed = await this.claimPlacing(fresh.id);
      if (!claimed) return this.reconcile((await this.orderById(fresh.id)) ?? fresh);
      return orderView(await this.book(claimed, found));
    }
    await this.assertRunning(fresh.merchant_id);
    const unfunded = await this.ensureHold(fresh);
    if (unfunded) return orderView(unfunded);
    const prepared = await this.prepareLimit(fresh);
    if (prepared.kind === 'failed') return orderView(prepared.row);
    if (prepared.kind === 'live') {
      if (prepared.row.status === 'placing' || prepared.row.status === 'placed') return this.reconcile(prepared.row);
      return orderView(prepared.row);
    }
    const claimed = await this.claimPlacing(fresh.id);
    if (!claimed) return this.reconcile((await this.orderById(fresh.id)) ?? fresh);
    try {
      await this.assertRunning(fresh.merchant_id);
    } catch (error) {
      await this.releaseClaim(claimed.id);
      throw error;
    }
    let placed: VenueOrder;
    try {
      placed = await this.deps.venue.placeOrder(prepared.request);
    } catch (error) {
      const kind = classifyPlaceFailure(error);
      if (kind === 'pre_send') {
        await this.releaseClaim(claimed.id);
        throw new ConversionError('pay.conversion_not_sent', 'SERVICE_UNAVAILABLE');
      }
      if (kind === 'rejected') {
        await this.releaseHold(claimed, parseAmount(claimed.from_amount), 0);
        return orderView(
          await this.mark(claimed.id, {
            status: 'failed',
            failureCode: 'pay.conversion_venue_rejected',
          }),
        );
      }
      throw error;
    }
    if (this.deps.afterPlace) await this.deps.afterPlace(placed);
    return orderView(await this.book(claimed, placed));
  }

  /**
   * Post the hold idempotently. Returns the failed row when clearing cannot
   * cover it. A timeout that already posted is not a second hold.
   */
  private async ensureHold(row: OrderRow): Promise<OrderRow | null> {
    const request = recipes.fxConversionHold({
      conversionId: row.id,
      merchantId: row.merchant_id,
      fromAsset: row.from_asset,
      amount: parseAmount(row.from_amount),
    });
    try {
      await postPayLedger(this.deps.ledger, request);
      return null;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.mark(row.id, { status: 'failed', failureCode: 'pay.conversion_unfunded' });
      }
      const posted = await this.deps.ledger.getTxByKey(request.idempotencyKey).catch(() => null);
      if (posted?.reason === 'pay.conversion.held') return null;
      throw error;
    }
  }

  /**
   * Round onto the venue grid before the row is claimed. Below the min
   * notional the order can never be sent: it fails and the hold is released.
   * An unknown filter or rate leaves the row at `intent_committed`.
   */
  private async prepareLimit(
    row: OrderRow,
  ): Promise<{ kind: 'ready'; request: PlaceOrderRequest } | { kind: 'failed'; row: OrderRow } | { kind: 'live'; row: OrderRow }> {
    const quote = await this.quoteById(row.quote_id);
    if (!quote) throw new ConversionError('pay.conversion_filters_unconfigured', 'SERVICE_UNAVAILABLE');
    let filters: ConversionSymbolFilters | null;
    let liveRate: Amount | null;
    try {
      filters = await this.deps.venue.symbolFilters(row.symbol);
      liveRate = await this.deps.venue.commissionRate(row.symbol);
    } catch (error) {
      if (classifyPlaceFailure(error) === 'pre_send') {
        throw new ConversionError('pay.conversion_not_sent', 'SERVICE_UNAVAILABLE');
      }
      throw new ConversionError('pay.conversion_filters_unconfigured', 'SERVICE_UNAVAILABLE');
    }
    if (!filters) throw new ConversionError('pay.conversion_symbol_unknown', 'PRECONDITION_FAILED');
    if (liveRate === null) throw new ConversionError('pay.conversion_commission_rate_unknown', 'PRECONDITION_FAILED');
    const quotedRate = parseAmount(quote.commission_rate);
    const rate = liveRate > quotedRate ? liveRate : quotedRate;
    const price = roundUpToTick(
      conversionLimitPrice(parseAmount(row.minimum_output), parseAmount(row.from_amount), rate),
      filters.tickSize,
    );
    const quantity = roundDownToStep(parseAmount(row.from_amount), filters.stepSize);
    const notional = quantity > 0n && price > 0n ? mul(quantity, price) : 0n;
    if (quantity <= 0n || notional < filters.minNotional) {
      const failed = await this.markIf(row.id, 'intent_committed', {
        status: 'failed',
        failureCode: 'pay.conversion_below_min_notional',
      });
      if (!failed) {
        const live = (await this.orderById(row.id)) ?? row;
        return { kind: 'live', row: live };
      }
      await this.releaseHold(failed, parseAmount(failed.from_amount), 0);
      return { kind: 'failed', row: failed };
    }
    return {
      kind: 'ready',
      request: {
        symbol: row.symbol,
        side: 'sell',
        type: 'limit',
        amount: quantity,
        price,
        timeInForce: 'IOC',
        clientOrderId: row.client_order_id,
      },
    };
  }

  /**
   * Realtime first, then closed-order history inside the claim window
   * (`placing_at` minus one minute through `placing_at` plus ten minutes).
   * A miss is null only when both say so.
   */
  private historyWindow(row: OrderRow): { startTimeMs: number; endTimeMs: number; orderId: string | null } {
    const claim = (row.placing_at ?? row.created_at).getTime();
    return {
      startTimeMs: claim - CONVERSION_VENUE_WINDOW_LEAD_MS,
      endTimeMs: claim + CONVERSION_VENUE_WINDOW_TAIL_MS,
      orderId: row.venue_order_id,
    };
  }

  private async lookup(row: OrderRow): Promise<VenueOrder | null> {
    const live = await this.deps.venue.fetchOrder(row.symbol, row.client_order_id);
    if (live) return live;
    return this.deps.venue.fetchClosedOrder(row.symbol, row.client_order_id, this.historyWindow(row));
  }

  private async reconcile(row: OrderRow): Promise<ConversionOrder> {
    const found = await this.lookup(row);
    if (found) return orderView(await this.book(row, found));
    if (row.status !== 'placing') return orderView(row);
    const claim = row.placing_at ?? row.created_at;
    const age = this.now().getTime() - claim.getTime();
    // Younger than the technical floor: the place is still in progress.
    // PAY_CONVERSION_PLACING_MAX_AGE_MS is not read, so an unset knob cannot
    // fail the loser of a live race.
    if (age < CONVERSION_ABSENT_FLOOR_MS) return orderView(row);
    if (this.deps.placingMaxAgeMs === null) {
      throw new ConversionError('pay.conversion_placing_retry_unconfigured', 'PRECONDITION_FAILED');
    }
    if (age < Math.max(this.deps.placingMaxAgeMs, CONVERSION_ABSENT_FLOOR_MS)) return orderView(row);
    return orderView(await this.noteReconcile(row));
  }

  /**
   * Stamp the reconcile code once. A second retry must not rewrite `updated_at`,
   * or the founder proposal hash stops matching the row.
   */
  private async noteReconcile(row: OrderRow): Promise<OrderRow> {
    if (row.failure_code) return row;
    const rows = await this.deps.sql<OrderRow[]>`
      UPDATE pay.conversion_orders
         SET failure_code = 'pay.conversion_reconcile'
       WHERE id = ${row.id} AND status = 'placing' AND failure_code IS NULL
       RETURNING ${this.deps.sql.unsafe(ORDER_COLS)}
    `;
    return rows[0] ?? (await this.orderById(row.id)) ?? row;
  }

  private async claimPlacing(id: string): Promise<OrderRow | null> {
    const rows = await this.deps.sql<OrderRow[]>`
      UPDATE pay.conversion_orders
         SET status = 'placing', placing_at = COALESCE(placing_at, now()), updated_at = now()
       WHERE id = ${id} AND status = 'intent_committed'
       RETURNING ${this.deps.sql.unsafe(ORDER_COLS)}
    `;
    return rows[0] ?? null;
  }

  /** The claim was taken and the venue has not been called. A halt can put the row back. */
  private async releaseClaim(id: string): Promise<void> {
    await this.deps.sql`
      UPDATE pay.conversion_orders
         SET status = 'intent_committed', placing_at = NULL, updated_at = now()
       WHERE id = ${id} AND status = 'placing'
    `;
  }

  /** A halt pauses a not-yet-placed order. The intent row stays, so a later retry does not mint a new client id. */
  private async assertRunning(merchantId: string): Promise<void> {
    try {
      const blocking = await findBlockingHalt(this.deps.sql, 'conversion', merchantId);
      if (blocking) throw new PayGuardRefusal(GUARD_HALTED, 'unavailable');
    } catch (error) {
      if (error instanceof PayGuardRefusal) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (code === '40001' || code === '40P01') throw error;
      throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
    }
  }

  private async book(row: OrderRow, order: VenueOrder): Promise<OrderRow> {
    return this.deps.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      return this.bookIn(tx, row, order);
    });
  }

  /** Caller holds the row lock on `sql`. A terminal row is left alone. */
  private async bookIn(sql: Sql, row: OrderRow, order: VenueOrder): Promise<OrderRow> {
    const locked = await sql<OrderRow[]>`
      SELECT ${sql.unsafe(ORDER_COLS)} FROM pay.conversion_orders WHERE id = ${row.id} FOR UPDATE
    `;
    const fresh = locked[0] ?? row;
    if (TERMINAL.has(fresh.status)) return fresh;

    if (order.filled > 0n) return this.bookFill(sql, fresh, order);

    if (order.status === 'rejected' || order.status === 'expired' || order.status === 'canceled') {
      await this.releaseHold(fresh, parseAmount(fresh.from_amount), 0);
      return this.mark(
        fresh.id,
        {
          status: 'failed',
          failureCode: 'pay.conversion_venue_rejected',
          venueOrderId: order.venueOrderId,
        },
        sql,
      );
    }
    return this.mark(fresh.id, { status: 'placed', venueOrderId: order.venueOrderId }, sql);
  }

  private async bookFill(sql: Sql, row: OrderRow, order: VenueOrder): Promise<OrderRow> {
    let finalOrder = order;
    if (order.remaining > 0n && OPEN_AT_VENUE.has(order.status)) {
      try {
        finalOrder = await this.deps.venue.cancelOrder(row.symbol, row.client_order_id);
      } catch {
        throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      }
    }
    if (finalOrder.filled <= 0n) {
      await this.releaseHold(row, parseAmount(row.from_amount), 0);
      return this.mark(
        row.id,
        {
          status: 'failed',
          failureCode: 'pay.conversion_venue_rejected',
          venueOrderId: finalOrder.venueOrderId,
        },
        sql,
      );
    }

    const ordered = parseAmount(row.from_amount);
    const filled = finalOrder.filled;
    const received = receivedQuote(finalOrder);
    if (received <= 0n) throw new ConversionError('pay.conversion_commission_unknown', 'SERVICE_UNAVAILABLE');
    const fee = proRate(parseAmount(row.fee_amount), filled, ordered);
    const spread = proRate(parseAmount(row.spread_amount), filled, ordered);
    const minimum = proRate(parseAmount(row.minimum_output), filled, ordered);
    const split = splitFill(received, fee, spread, minimum);
    const merchantUserId = await this.merchantUser(row.merchant_id);
    const ledgerInput = {
      conversionId: row.id,
      merchantId: row.merchant_id,
      merchantUserId,
      venueId: row.venue_id,
      fromAsset: row.from_asset,
      toAsset: row.to_asset,
      fromAmount: filled,
      toAmount: split.merchant,
      feeAmount: split.fee,
      spreadAmount: split.spread,
    };
    // Booking and the under-floor reversal stay two posts. The recipe gate
    // allows a post only when its reason and leg signature match one sampled
    // recipe. These two reasons (`pay.conversion.booked`, `pay.conversion.reversed`)
    // are different signatures; one body cannot carry both, and a mashed body
    // under either reason is refused. The venue legs stay on the first post.
    await postPayLedger(this.deps.ledger, recipes.fxConversion(ledgerInput));
    const remainder = ordered - filled;
    if (remainder > 0n) await this.releaseHold(row, remainder, 1);
    if (split.kind === 'reverse') {
      await postPayLedger(this.deps.ledger, recipes.fxConversionReverse(ledgerInput));
      return this.mark(
        row.id,
        {
          status: 'reversed',
          failureCode: 'pay.conversion_below_minimum',
          filledFrom: filled,
          filledTo: received,
          venueOrderId: finalOrder.venueOrderId,
        },
        sql,
      );
    }
    // A full fill of the step-rounded venue quantity is filled. Comparing to
    // from_amount reports that dust, which was never sent, as a partial.
    const status = finalOrder.status === 'filled' && finalOrder.remaining === 0n ? 'filled' : 'partially_filled';
    return this.mark(
      row.id,
      {
        status,
        filledFrom: filled,
        filledTo: received,
        venueOrderId: finalOrder.venueOrderId,
      },
      sql,
    );
  }

  private async releaseHold(row: OrderRow, amount: Amount, sequence: number): Promise<void> {
    if (amount <= 0n) return;
    await postPayLedger(
      this.deps.ledger,
      recipes.fxConversionRelease({
        conversionId: row.id,
        merchantId: row.merchant_id,
        fromAsset: row.from_asset,
        amount,
        sequence,
      }),
    );
  }

  private async assertInventoryCovered(asset: string): Promise<void> {
    const balance = await this.deps.ledger.balance(conversionInventory(asset));
    if (balance.amount < 0n) throw new ConversionError('pay.conversion_inventory_short', 'PRECONDITION_FAILED');
  }

  private async readCommissionRate(symbol: string): Promise<Amount> {
    let rate: Amount | null;
    try {
      rate = await this.deps.venue.commissionRate(symbol);
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      throw new ConversionError('pay.conversion_commission_rate_unknown', 'PRECONDITION_FAILED');
    }
    if (rate === null || rate < 0n || rate >= SCALE) {
      throw new ConversionError('pay.conversion_commission_rate_unknown', 'PRECONDITION_FAILED');
    }
    return rate;
  }

  private async merchantUser(merchantId: string): Promise<string> {
    const rows = await this.deps.sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.merchants WHERE id = ${merchantId}`;
    const userId = rows[0]?.user_id;
    if (!userId) throw new ConversionError('pay.conversion_unavailable', 'SERVICE_UNAVAILABLE');
    return userId;
  }

  private async mark(
    id: string,
    patch: {
      status: string;
      failureCode?: string | null;
      filledFrom?: Amount;
      filledTo?: Amount;
      venueOrderId?: string | null;
    },
    sql: Sql = this.deps.sql,
  ): Promise<OrderRow> {
    const row = await this.markIf(id, null, patch, sql);
    if (!row) throw new ConversionError('pay.conversion_unavailable', 'SERVICE_UNAVAILABLE');
    return row;
  }

  /** `onlyStatus` null updates the row whatever its status is. Zero rows returns null. */
  private async markIf(
    id: string,
    onlyStatus: string | null,
    patch: {
      status: string;
      failureCode?: string | null;
      filledFrom?: Amount;
      filledTo?: Amount;
      venueOrderId?: string | null;
    },
    sql: Sql = this.deps.sql,
  ): Promise<OrderRow | null> {
    const rows = onlyStatus
      ? await sql<OrderRow[]>`
          UPDATE pay.conversion_orders SET
            status = ${patch.status},
            failure_code = ${patch.failureCode ?? null},
            filled_from_amount = COALESCE(${patch.filledFrom === undefined ? null : formatAmount(patch.filledFrom)}::numeric, filled_from_amount),
            filled_to_amount = COALESCE(${patch.filledTo === undefined ? null : formatAmount(patch.filledTo)}::numeric, filled_to_amount),
            venue_order_id = COALESCE(${patch.venueOrderId ?? null}, venue_order_id),
            updated_at = now()
          WHERE id = ${id} AND status = ${onlyStatus}
          RETURNING ${sql.unsafe(ORDER_COLS)}
        `
      : await sql<OrderRow[]>`
          UPDATE pay.conversion_orders SET
            status = ${patch.status},
            failure_code = ${patch.failureCode ?? null},
            filled_from_amount = COALESCE(${patch.filledFrom === undefined ? null : formatAmount(patch.filledFrom)}::numeric, filled_from_amount),
            filled_to_amount = COALESCE(${patch.filledTo === undefined ? null : formatAmount(patch.filledTo)}::numeric, filled_to_amount),
            venue_order_id = COALESCE(${patch.venueOrderId ?? null}, venue_order_id),
            updated_at = now()
          WHERE id = ${id}
          RETURNING ${sql.unsafe(ORDER_COLS)}
        `;
    return rows[0] ?? null;
  }

  /**
   * Absent is a release only after the claim has aged past the configured max
   * and the 15-minute technical floor, and only when propose and confirm both
   * missed with at least five minutes between those lookups.
   */
  private assertAbsentProven(row: OrderRow, proposal: { venue_lookup: string; venue_lookup_at: Date }): void {
    if (this.deps.placingMaxAgeMs === null || !row.placing_at) {
      throw new ConversionError('pay.conversion_resolve_absent_unproven', 'PRECONDITION_FAILED');
    }
    const required = Math.max(this.deps.placingMaxAgeMs, CONVERSION_ABSENT_FLOOR_MS);
    if (this.now().getTime() - row.placing_at.getTime() < required) {
      throw new ConversionError('pay.conversion_resolve_absent_unproven', 'PRECONDITION_FAILED');
    }
    if (proposal.venue_lookup !== 'absent') {
      throw new ConversionError('pay.conversion_resolve_absent_unproven', 'PRECONDITION_FAILED');
    }
    if (this.now().getTime() - new Date(proposal.venue_lookup_at).getTime() < ABSENT_LOOK_GAP_MS) {
      throw new ConversionError('pay.conversion_resolve_absent_unproven', 'PRECONDITION_FAILED');
    }
  }

  /**
   * New quotes and executes stop while any late-fill audit lacks a confirmed
   * acknowledgement. The halt switch is not this gate: clearing it does not
   * resume conversion. Detection does not run here.
   */
  private async refuseIfLateFill(): Promise<void> {
    const rows = await this.deps.sql<Array<{ id: string }>>`
      SELECT a.id FROM pay.conversion_audit a
       WHERE a.action = ${LATE_FILL_AUDIT}
         AND NOT EXISTS (
           SELECT 1 FROM pay.conversion_late_fill_acks k
            WHERE k.audit_id = a.id AND k.status = 'confirmed'
         )
       LIMIT 1
    `;
    if (rows[0]) throw new ConversionError('pay.conversion_late_fill_halt', 'SERVICE_UNAVAILABLE');
  }

  private lateFillHash(audit: { id: string; conversion_id: string; detail: unknown; created_at: Date }, settlement: string): string {
    return founderChangeHash(
      {
        kind: 'conversion_late_fill_ack',
        auditId: audit.id,
        conversionId: audit.conversion_id,
        settlement,
        detail: audit.detail,
      },
      new Date(audit.created_at).toISOString(),
    );
  }

  private async lateFillAudit(auditId: string): Promise<{
    id: string;
    conversion_id: string;
    detail: unknown;
    created_at: Date;
  } | null> {
    const rows = await this.deps.sql<Array<{ id: string; conversion_id: string; detail: unknown; created_at: Date }>>`
      SELECT id, conversion_id, detail, created_at FROM pay.conversion_audit
       WHERE id = ${auditId} AND action = ${LATE_FILL_AUDIT}
    `;
    return rows[0] ?? null;
  }

  private async lateFillAckByRequest(requestId: string): Promise<{
    request_id: string;
    audit_id: string;
    conversion_id: string;
    change_hash: string;
    settlement: string;
    proposed_by: string;
    status: string;
  } | null> {
    const rows = await this.deps.sql<
      Array<{
        request_id: string;
        audit_id: string;
        conversion_id: string;
        change_hash: string;
        settlement: string;
        proposed_by: string;
        status: string;
      }>
    >`
      SELECT request_id, audit_id, conversion_id, change_hash, settlement, proposed_by, status
        FROM pay.conversion_late_fill_acks
       WHERE request_id = ${requestId}
    `;
    return rows[0] ?? null;
  }

  private async lateFillAckForAudit(auditId: string, status: 'pending' | 'confirmed'): Promise<{ change_hash: string } | null> {
    const rows = await this.deps.sql<Array<{ change_hash: string }>>`
      SELECT change_hash FROM pay.conversion_late_fill_acks
       WHERE audit_id = ${auditId} AND status = ${status}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private lookupLateFill(row: OrderRow): Promise<VenueOrder | null> {
    return this.lookup(row);
  }

  private lateFillBookHash(
    audit: { id: string; conversion_id: string; detail: unknown; created_at: Date },
    evidence: LateFillEvidenceCanon,
  ): string {
    return founderChangeHash(
      {
        kind: 'conversion_late_fill_book',
        auditId: audit.id,
        conversionId: audit.conversion_id,
        detail: audit.detail,
        evidence,
      },
      new Date(audit.created_at).toISOString(),
    );
  }

  /** Amounts from the venue order and the original order. A miss is null. Below the original floor is `reverse`. */
  private lateFillEconomics(
    row: OrderRow,
    order: VenueOrder,
  ): { kind: 'accept' | 'reverse'; filled: Amount; received: Amount; merchant: Amount; fee: Amount; spread: Amount } | null {
    if (order.filled <= 0n || order.clientOrderId !== row.client_order_id) return null;
    const ordered = parseAmount(row.from_amount);
    if (order.filled > ordered) throw new ConversionError('pay.conversion_late_fill_book_invalid', 'PRECONDITION_FAILED');
    const received = receivedQuote(order);
    if (received <= 0n) throw new ConversionError('pay.conversion_commission_unknown', 'SERVICE_UNAVAILABLE');
    const split = splitFill(
      received,
      proRate(parseAmount(row.fee_amount), order.filled, ordered),
      proRate(parseAmount(row.spread_amount), order.filled, ordered),
      proRate(parseAmount(row.minimum_output), order.filled, ordered),
    );
    return { kind: split.kind, filled: order.filled, received, merchant: split.merchant, fee: split.fee, spread: split.spread };
  }

  private async postLateFill(
    auditId: string,
    row: OrderRow,
    economics: { filled: Amount; merchant: Amount; fee: Amount; spread: Amount },
    funding: 'merchant' | 'inventory',
  ): Promise<void> {
    const merchantUserId = await this.merchantUser(row.merchant_id);
    await postPayLedger(
      this.deps.ledger,
      recipes.fxConversionLateFill({
        auditId,
        conversionId: row.id,
        merchantId: row.merchant_id,
        merchantUserId,
        venueId: row.venue_id,
        fromAsset: row.from_asset,
        toAsset: row.to_asset,
        fromAmount: economics.filled,
        toAmount: economics.merchant,
        feeAmount: economics.fee,
        spreadAmount: economics.spread,
        funding,
      }),
    );
  }

  private async finishLateFillBook(
    proposal: { request_id: string; audit_id: string; proposed_by: string; change_hash: string },
    actor: string,
    audit: { id: string; conversion_id: string; detail: unknown; created_at: Date },
    row: OrderRow,
    evidence: VenueOrder,
    economics: { filled: Amount; received: Amount; merchant: Amount; fee: Amount; spread: Amount },
    funding: 'merchant' | 'inventory',
  ): Promise<OrderRow> {
    const status = evidence.status === 'filled' && evidence.remaining === 0n ? 'filled' : 'partially_filled';
    const clearing = await this.deps.ledger.balance(merchantClearing(row.merchant_id, row.from_asset));
    return this.deps.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const updated = await tx<Array<{ request_id: string }>>`
        UPDATE pay.conversion_late_fill_books
           SET status = 'confirmed', confirmed_by = ${actor}, funding = ${funding}, decided_at = now()
         WHERE request_id = ${proposal.request_id} AND status = 'pending'
         RETURNING request_id
      `;
      const marked =
        (await this.mark(
          row.id,
          {
            status,
            filledFrom: economics.filled,
            filledTo: economics.received,
            venueOrderId: evidence.venueOrderId,
          },
          tx,
        )) ?? row;
      if (updated[0]) {
        await tx`
          INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
          VALUES (
            ${randomUUID()}, ${row.id}, ${LATE_FILL_BOOKED}, ${proposal.proposed_by}, ${actor},
            ${tx.json({
              changeHash: proposal.change_hash,
              auditId: proposal.audit_id,
              funding,
              fromAmount: formatAmount(economics.filled),
              toAmount: formatAmount(economics.merchant),
              feeAmount: formatAmount(economics.fee),
              spreadAmount: formatAmount(economics.spread),
              venueOrderId: evidence.venueOrderId,
            } as never)}
          )
        `;
        if (funding === 'inventory') {
          await tx`
            INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
            VALUES (
              ${randomUUID()}, ${row.id}, ${LATE_FILL_SHORTFALL}, ${proposal.proposed_by}, ${actor},
              ${tx.json({
                auditId: proposal.audit_id,
                fromAmount: formatAmount(economics.filled),
                clearingAmount: formatAmount(clearing.amount),
                asset: row.from_asset,
              } as never)}
            )
          `;
        }
        await this.acknowledgeBookedLateFill(tx, proposal, actor, audit);
      }
      return marked;
    });
  }

  /**
   * The book is the acknowledgement. One confirmed sentence lifts the quote
   * halt in the same two-founder step. A pending sentence for this audit is
   * closed so the open-ack index can take the booked sentence.
   */
  private async acknowledgeBookedLateFill(
    tx: Sql,
    proposal: { request_id: string; audit_id: string; proposed_by: string },
    actor: string,
    audit: { id: string; conversion_id: string; detail: unknown; created_at: Date },
  ): Promise<void> {
    const settlement = `booked via late-fill book ${proposal.request_id}`;
    const rejected = await tx<Array<{ request_id: string }>>`
      UPDATE pay.conversion_late_fill_acks
         SET status = 'rejected', confirmed_by = ${actor}, decided_at = now()
       WHERE audit_id = ${audit.id} AND status = 'pending'
       RETURNING request_id
    `;
    if (rejected[0]) {
      await tx`
        INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
        VALUES (
          ${randomUUID()}, ${audit.conversion_id}, 'late_fill_ack_rejected', ${proposal.proposed_by}, ${actor},
          ${tx.json({ auditId: audit.id, supersededBy: proposal.request_id } as never)}
        )
      `;
    }
    const changeHash = this.lateFillHash(audit, settlement);
    const inserted = await tx<Array<{ request_id: string }>>`
      INSERT INTO pay.conversion_late_fill_acks (
        request_id, audit_id, conversion_id, change_hash, settlement, reason,
        proposed_by, status, confirmed_by, decided_at
      )
      VALUES (
        ${randomUUID()}, ${audit.id}, ${audit.conversion_id}, ${changeHash}, ${settlement}, ${settlement},
        ${proposal.proposed_by}, 'confirmed', ${actor}, now()
      )
      ON CONFLICT DO NOTHING
      RETURNING request_id
    `;
    if (!inserted[0]) return;
    await tx`
      INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
      VALUES (
        ${randomUUID()}, ${audit.conversion_id}, ${LATE_FILL_ACK}, ${proposal.proposed_by}, ${actor},
        ${tx.json({ changeHash, auditId: audit.id, settlement } as never)}
      )
    `;
  }

  private async lateFillBookByRequest(requestId: string): Promise<{
    request_id: string;
    audit_id: string;
    conversion_id: string;
    change_hash: string;
    proposed_by: string;
    status: string;
    funding: 'merchant' | 'inventory' | null;
  } | null> {
    const rows = await this.deps.sql<
      Array<{
        request_id: string;
        audit_id: string;
        conversion_id: string;
        change_hash: string;
        proposed_by: string;
        status: string;
        funding: string | null;
      }>
    >`
      SELECT request_id, audit_id, conversion_id, change_hash, proposed_by, status, funding
        FROM pay.conversion_late_fill_books
       WHERE request_id = ${requestId}
    `;
    const row = rows[0];
    if (!row) return null;
    return { ...row, funding: row.funding === 'merchant' || row.funding === 'inventory' ? row.funding : null };
  }

  private async lateFillBookForAudit(auditId: string, status: 'pending' | 'confirmed'): Promise<{ change_hash: string } | null> {
    const rows = await this.deps.sql<Array<{ change_hash: string }>>`
      SELECT change_hash FROM pay.conversion_late_fill_books
       WHERE audit_id = ${auditId} AND status = ${status}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async withAdvisoryLock<T>(keyA: number, keyB: number, onBusy: T, body: (conn: Sql) => Promise<T>): Promise<T> {
    const conn = await this.deps.sql.reserve();
    try {
      const [lock] = await conn<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(${keyA}, ${keyB}) AS locked
      `;
      if (lock?.locked !== true) return onBusy;
      try {
        return await body(conn);
      } finally {
        await conn`SELECT pg_advisory_unlock(${keyA}, ${keyB})`;
      }
    } finally {
      conn.release();
    }
  }

  /** Insert the late-fill audit once. A second sweeper sees the row and does not insert again. */
  private async recordLateFill(row: OrderRow, evidence: VenueOrder, actor: string): Promise<boolean> {
    return this.deps.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.conversion.late:${row.id}`}))`;
      const seen = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.conversion_audit
         WHERE conversion_id = ${row.id} AND action = ${LATE_FILL_AUDIT}
         LIMIT 1
      `;
      if (seen[0]) return false;
      await tx`
        INSERT INTO pay.conversion_audit (id, conversion_id, action, actor_id, approver_id, detail)
        VALUES (
          ${randomUUID()}, ${row.id}, ${LATE_FILL_AUDIT}, ${actor}, ${null},
          ${this.deps.sql.json({ venueOrderId: evidence.venueOrderId, filled: formatAmount(evidence.filled) } as never)}
        )
      `;
      return true;
    });
  }

  private async quoteById(id: string): Promise<QuoteRow | null> {
    const rows = await this.deps.sql<QuoteRow[]>`SELECT ${this.deps.sql.unsafe(QUOTE_COLS)} FROM pay.conversion_quotes WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  private async orderById(id: string): Promise<OrderRow | null> {
    const rows = await this.deps.sql<OrderRow[]>`SELECT ${this.deps.sql.unsafe(ORDER_COLS)} FROM pay.conversion_orders WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  private async orderByRequest(requestId: string): Promise<OrderRow | null> {
    const rows = await this.deps.sql<OrderRow[]>`
      SELECT ${this.deps.sql.unsafe(ORDER_COLS)} FROM pay.conversion_orders WHERE request_id = ${requestId}
    `;
    return rows[0] ?? null;
  }
}
