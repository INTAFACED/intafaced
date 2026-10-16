import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  InsufficientFundsError,
  SCALE,
  conversionInventory,
  div,
  formatAmount,
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
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { requireMerchantPermission } from '../merchant-ops/roles.js';
import type { RegistryReader } from '../registries/read-api.js';
import { FRESH, PayGuardRefusal, type PayGuards } from '../seams/guards.js';
import { GUARD_HALTED, GUARD_HALT_STORE_UNAVAILABLE } from '../halts/guards.js';
import { assertOnMerchantTeam, type ConversionCaller } from './access.js';
import { ConversionError, conversionNotFound } from './errors.js';
import { classifyPlaceFailure } from './place-error.js';
import type { ConversionSymbolFilters, ConversionVenue } from './venue.js';

const PAIR = 'USD/USDT';
const FROM = 'USD';
const TO = 'USDT';
const CLIENT_ORDER_ID_MAX = 36;
const TERMINAL = new Set(['filled', 'partially_filled', 'failed', 'reversed', 'expired']);
const OPEN_AT_VENUE = new Set<VenueOrder['status']>(['pending', 'open', 'partially_filled']);

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
  fee_amount::text, spread_amount::text, minimum_output::text, failure_code, venue_order_id, created_at, updated_at`;

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
    await this.deps.sql`
      INSERT INTO pay.conversion_resolve_proposals (request_id, conversion_id, change_hash, reason, proposed_by, status)
      VALUES (${input.requestId}, ${row.id}, ${changeHash}, ${input.reason}, ${actor}, 'pending')
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
    let settled: OrderRow;
    if (!evidence) {
      await this.releaseHold(row, parseAmount(row.from_amount), 0);
      settled = await this.mark(row.id, { status: 'failed', failureCode: 'pay.conversion_resolve_absent' });
    } else {
      settled = await this.book(row, evidence);
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
   * supplied by the caller.
   */
  async sweepOrphanHolds(): Promise<{ released: number }> {
    const merchants = await this.deps.sql<Array<{ id: string }>>`SELECT id FROM pay.merchants`;
    let released = 0;
    for (const merchant of merchants) {
      const balances = await this.deps.ledger.balances('module', `pay:clearing:${merchant.id}`);
      for (const balance of balances) {
        const purpose = balance.account.purpose ?? '';
        if (balance.account.kind !== 'hold' || !purpose.startsWith('conversion:') || balance.amount <= 0n) continue;
        const conversionId = purpose.slice('conversion:'.length);
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
        await this.audit(row?.id ?? null, 'hold_swept', 'sweeper', null, { conversionId, amount: formatAmount(balance.amount) });
        released += 1;
      }
    }
    return { released };
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
  } | null> {
    const rows = await this.deps.sql<
      Array<{ request_id: string; conversion_id: string; change_hash: string; proposed_by: string; status: string }>
    >`
      SELECT request_id, conversion_id, change_hash, proposed_by, status
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
  private async prepareLimit(row: OrderRow): Promise<{ kind: 'ready'; request: PlaceOrderRequest } | { kind: 'failed'; row: OrderRow }> {
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
      await this.releaseHold(row, parseAmount(row.from_amount), 0);
      return {
        kind: 'failed',
        row: await this.mark(row.id, { status: 'failed', failureCode: 'pay.conversion_below_min_notional' }),
      };
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

  /** Realtime first, then closed-order history. A miss is null only when both say so. */
  private async lookup(row: OrderRow): Promise<VenueOrder | null> {
    const live = await this.deps.venue.fetchOrder(row.symbol, row.client_order_id);
    if (live) return live;
    return this.deps.venue.fetchClosedOrder(row.symbol, row.client_order_id);
  }

  private async reconcile(row: OrderRow): Promise<ConversionOrder> {
    const found = await this.lookup(row);
    if (found) return orderView(await this.book(row, found));
    if (row.status !== 'placing') return orderView(row);
    if (this.deps.placingMaxAgeMs === null) {
      throw new ConversionError('pay.conversion_placing_retry_unconfigured', 'PRECONDITION_FAILED');
    }
    const age = this.now().getTime() - row.created_at.getTime();
    if (age < this.deps.placingMaxAgeMs) return orderView(row);
    return orderView(await this.mark(row.id, { status: 'placing', failureCode: 'pay.conversion_reconcile' }));
  }

  private async claimPlacing(id: string): Promise<OrderRow | null> {
    const rows = await this.deps.sql<OrderRow[]>`
      UPDATE pay.conversion_orders
         SET status = 'placing', updated_at = now()
       WHERE id = ${id} AND status = 'intent_committed'
       RETURNING ${this.deps.sql.unsafe(ORDER_COLS)}
    `;
    return rows[0] ?? null;
  }

  /** The claim was taken and the venue has not been called. A halt can put the row back. */
  private async releaseClaim(id: string): Promise<void> {
    await this.deps.sql`
      UPDATE pay.conversion_orders
         SET status = 'intent_committed', updated_at = now()
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
    const fresh = (await this.orderById(row.id)) ?? row;
    if (TERMINAL.has(fresh.status)) return fresh;

    if (order.filled > 0n) return this.bookFill(fresh, order);

    if (order.status === 'rejected' || order.status === 'expired' || order.status === 'canceled') {
      await this.releaseHold(fresh, parseAmount(fresh.from_amount), 0);
      return this.mark(fresh.id, {
        status: 'failed',
        failureCode: 'pay.conversion_venue_rejected',
        venueOrderId: order.venueOrderId,
      });
    }
    return this.mark(fresh.id, { status: 'placed', venueOrderId: order.venueOrderId });
  }

  private async bookFill(row: OrderRow, order: VenueOrder): Promise<OrderRow> {
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
      return this.mark(row.id, {
        status: 'failed',
        failureCode: 'pay.conversion_venue_rejected',
        venueOrderId: finalOrder.venueOrderId,
      });
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
      return this.mark(row.id, {
        status: 'reversed',
        failureCode: 'pay.conversion_below_minimum',
        filledFrom: filled,
        filledTo: received,
        venueOrderId: finalOrder.venueOrderId,
      });
    }
    const status = filled === ordered && finalOrder.remaining === 0n ? 'filled' : 'partially_filled';
    return this.mark(row.id, {
      status,
      filledFrom: filled,
      filledTo: received,
      venueOrderId: finalOrder.venueOrderId,
    });
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
  ): Promise<OrderRow> {
    const rows = await this.deps.sql<OrderRow[]>`
      UPDATE pay.conversion_orders SET
        status = ${patch.status},
        failure_code = ${patch.failureCode ?? null},
        filled_from_amount = COALESCE(${patch.filledFrom === undefined ? null : formatAmount(patch.filledFrom)}::numeric, filled_from_amount),
        filled_to_amount = COALESCE(${patch.filledTo === undefined ? null : formatAmount(patch.filledTo)}::numeric, filled_to_amount),
        venue_order_id = COALESCE(${patch.venueOrderId ?? null}, venue_order_id),
        updated_at = now()
      WHERE id = ${id}
      RETURNING ${this.deps.sql.unsafe(ORDER_COLS)}
    `;
    return rows[0]!;
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
