import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import {
  InsufficientFundsError,
  div,
  formatAmount,
  mul,
  mulBps,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
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
import type { ConversionVenue } from './venue.js';

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
  venue_id, symbol, expires_at, created_at`;

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

/** Limit price is the gross floor divided by the from-amount, rounded up so a full fill cannot land under it. */
export function conversionLimitPrice(minimum: Amount, fromAmount: Amount): Amount {
  const price = div(minimum, fromAmount, 'ceil');
  if (price <= 0n) throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
  return price;
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
        fee_amount, spread_amount, minimum_output, expected_output, gross_output, venue_id, symbol, expires_at
      ) VALUES (
        ${id}, ${input.merchantId}, ${input.settlementId}, ${FROM}, ${TO},
        ${formatAmount(fromAmount)}::numeric, ${formatAmount(worst)}::numeric,
        ${formatAmount(feeTo)}::numeric, ${formatAmount(spreadTo)}::numeric,
        ${formatAmount(gross)}::numeric, ${formatAmount(expected)}::numeric,
        ${formatAmount(gross)}::numeric, ${venue.venueId}, ${PAIR}, ${quoted.expiresAt}
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
    let heldId: string | null = null;
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
        if (parseAmount(quote.from_amount) > parseAmount(net)) {
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
        if (status !== 'intent_committed') return { row, raced: false };
        try {
          await postPayLedger(
            this.deps.ledger,
            recipes.fxConversionHold({
              conversionId: id,
              merchantId: quote.merchant_id,
              fromAsset: quote.from_asset,
              amount: parseAmount(quote.from_amount),
            }),
          );
          heldId = id;
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          const failed = await tx<OrderRow[]>`
            UPDATE pay.conversion_orders
               SET status = 'failed', failure_code = 'pay.conversion_unfunded', updated_at = now()
             WHERE id = ${id}
             RETURNING ${tx.unsafe(ORDER_COLS)}
          `;
          heldId = null;
          return { row: failed[0]!, raced: false };
        }
        return { row, raced: false };
      });
    } catch (error) {
      if (heldId) {
        await postPayLedger(
          this.deps.ledger,
          recipes.fxConversionRelease({
            conversionId: heldId,
            merchantId: quote.merchant_id,
            fromAsset: quote.from_asset,
            amount: parseAmount(quote.from_amount),
            sequence: 0,
          }),
        );
      }
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
   */
  private async resume(row: OrderRow, mayPlace: boolean): Promise<ConversionOrder> {
    const fresh = (await this.orderById(row.id)) ?? row;
    if (TERMINAL.has(fresh.status)) return orderView(fresh);
    if (fresh.status === 'placing' || fresh.status === 'placed') return this.reconcile(fresh);
    if (fresh.status !== 'intent_committed' || !mayPlace) return orderView(fresh);

    const found = await this.lookup(fresh);
    if (found) {
      const claimed = await this.claimPlacing(fresh.id);
      if (!claimed) return this.reconcile((await this.orderById(fresh.id)) ?? fresh);
      return orderView(await this.book(claimed, found));
    }
    await this.assertRunning(fresh.merchant_id);
    const claimed = await this.claimPlacing(fresh.id);
    if (!claimed) return this.reconcile((await this.orderById(fresh.id)) ?? fresh);
    try {
      await this.assertRunning(fresh.merchant_id);
    } catch (error) {
      await this.releaseClaim(claimed.id);
      throw error;
    }
    const placed = await this.deps.venue.placeOrder(this.limitRequest(claimed));
    if (this.deps.afterPlace) await this.deps.afterPlace(placed);
    return orderView(await this.book(claimed, placed));
  }

  private limitRequest(row: OrderRow): PlaceOrderRequest {
    return {
      symbol: row.symbol,
      side: 'sell',
      type: 'limit',
      amount: parseAmount(row.from_amount),
      price: conversionLimitPrice(parseAmount(row.minimum_output), parseAmount(row.from_amount)),
      timeInForce: 'IOC',
      clientOrderId: row.client_order_id,
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
