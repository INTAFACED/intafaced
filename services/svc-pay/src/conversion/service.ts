import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { formatAmount, merchantClearing, mul, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { VenueOrder } from '@intafaced/venue-contracts';
import type { ConversionOrder, ConversionQuote, ConversionQuoteInput } from '@intafaced/contracts';
import { loadApplicableRules, loadMerchantControl, monthlyIntake } from '../control/store.js';
import { computePricing, resolvePricingRule } from '../control/pricing.js';
import { findBlockingHalt } from '../halts/store.js';
import { postPayLedger } from '../ledger-receipt.js';
import type { RegistryReader } from '../registries/read-api.js';
import { FRESH, PayGuardRefusal, type PayGuards } from '../seams/guards.js';
import { GUARD_HALTED, GUARD_HALT_STORE_UNAVAILABLE } from '../halts/guards.js';
import { assertOnMerchantTeam, type ConversionCaller } from './access.js';
import { ConversionError, conversionNotFound } from './errors.js';
import type { ConversionVenue } from './venue.js';

const PAIR = 'USD/USDT';
const FROM = 'USD';
const TO = 'USDT';
const TERMINAL = new Set(['filled', 'partially_filled', 'failed', 'reversed', 'expired']);

export interface ConversionServiceDeps {
  sql: Sql;
  ledger: LedgerClient;
  guards: PayGuards;
  venue: ConversionVenue;
  registries: RegistryReader;
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

/** clientOrderId is the settlement id plus the attempt, so a restart can find the same venue order. */
export function conversionClientOrderId(settlementId: string, attempt: number): string {
  return `${settlementId}:${attempt}`;
}

function receivedQuote(order: VenueOrder): Amount {
  if (order.filled === 0n) return 0n;
  if (order.averagePrice === null || order.averagePrice <= 0n) {
    throw new ConversionError('pay.conversion_fill_unpriced', 'SERVICE_UNAVAILABLE');
  }
  return mul(order.filled, order.averagePrice);
}

/**
 * Locked fee and spread come off the fill. A fill that still leaves the merchant
 * at least the quoted minimum is accepted. Anything less is booked and reversed.
 * When the locked charges do not fit in the fill, the whole fill is reversed and
 * no fee is taken — a smaller fee would be a number we invented.
 */
function splitFill(
  filledTo: Amount,
  fee: Amount,
  spread: Amount,
  minimum: Amount,
): { kind: 'accept' | 'reverse'; merchant: Amount; fee: Amount; spread: Amount } {
  if (filledTo > fee + spread) {
    const merchant = filledTo - fee - spread;
    if (merchant >= minimum) return { kind: 'accept', merchant, fee, spread };
    return { kind: 'reverse', merchant, fee, spread };
  }
  return { kind: 'reverse', merchant: filledTo, fee: 0n, spread: 0n };
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
    const fromAmount = parseAmount(input.fromAmount);
    if (fromAmount <= 0n) throw new ConversionError('pay.conversion_amount_invalid', 'BAD_REQUEST');

    const settlements = await this.deps.sql<Array<{ merchant_id: string; asset_id: string }>>`
      SELECT merchant_id, asset_id FROM pay.settlements WHERE id = ${input.settlementId}
    `;
    const settlement = settlements[0];
    if (!settlement || settlement.merchant_id !== input.merchantId) {
      throw new ConversionError('pay.settlement_not_found', 'NOT_FOUND');
    }
    if (settlement.asset_id !== FROM) throw new ConversionError('pay.conversion_settlement_asset', 'PRECONDITION_FAILED');

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
    if (quoted.rateScaled <= 0n || quoted.targetAmount <= 0n) {
      throw new ConversionError('pay.conversion_quote_unconfigured', 'PRECONDITION_FAILED');
    }
    const feeTo = mul(priced.fee, quoted.rateScaled);
    const spreadTo = mul(priced.spread ?? 0n, quoted.rateScaled);
    const expected = quoted.targetAmount - feeTo - spreadTo;
    if (expected <= 0n) throw new ConversionError('pay.conversion_output_non_positive', 'PRECONDITION_FAILED');

    const id = randomUUID();
    const rows = await this.deps.sql<QuoteRow[]>`
      INSERT INTO pay.conversion_quotes (
        id, merchant_id, settlement_id, from_asset, to_asset, from_amount, rate,
        fee_amount, spread_amount, minimum_output, expected_output, gross_output, venue_id, symbol, expires_at
      ) VALUES (
        ${id}, ${input.merchantId}, ${input.settlementId}, ${FROM}, ${TO},
        ${formatAmount(fromAmount)}::numeric, ${formatAmount(quoted.rateScaled)}::numeric,
        ${formatAmount(feeTo)}::numeric, ${formatAmount(spreadTo)}::numeric,
        ${formatAmount(expected)}::numeric, ${formatAmount(expected)}::numeric,
        ${formatAmount(quoted.targetAmount)}::numeric, ${venue.venueId}, ${PAIR}, ${quoted.expiresAt}
      ) RETURNING ${this.deps.sql.unsafe(QUOTE_COLS)}
    `;
    return quoteView(rows[0]!);
  }

  async execute(principal: Principal | null, input: { requestId: string; quoteId: string }): Promise<ConversionOrder> {
    const caller = callerOf(principal);
    const existing = await this.orderByRequest(input.requestId);
    if (existing) {
      await this.seeOrder(caller, existing);
      return this.advance(existing);
    }
    const quote = await this.quoteById(input.quoteId);
    if (!quote) throw conversionNotFound();
    try {
      await assertOnMerchantTeam(this.deps.sql, caller, quote.merchant_id);
    } catch (error) {
      if (error instanceof ConversionError && error.code === 'pay.merchant_not_found') throw conversionNotFound();
      throw error;
    }
    if (quote.expires_at.getTime() <= this.now().getTime()) {
      const expired = await this.insertOrder(quote, input.requestId, 'expired', 'pay.conversion_quote_expired');
      return orderView(expired);
    }
    const intent = await this.insertOrder(quote, input.requestId, 'intent_committed', null);
    return this.advance(intent);
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
  ): Promise<OrderRow> {
    try {
      return await this.deps.sql.begin(async (raw) => {
        // postgres.js types a transaction more narrowly than `Sql`. Every other pay path treats it as `Sql`.
        const tx = raw as unknown as Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay.conversion:${quote.settlement_id}`}))`;
        const taken = await tx<Array<{ id: string }>>`SELECT id FROM pay.conversion_orders WHERE quote_id = ${quote.id}`;
        if (taken[0]) throw new ConversionError('pay.conversion_quote_consumed', 'PRECONDITION_FAILED');
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
        return rows[0]!;
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        const raced = await this.orderByRequest(requestId);
        if (raced) return raced;
        throw new ConversionError('pay.conversion_quote_consumed', 'PRECONDITION_FAILED');
      }
      throw error;
    }
  }

  private async advance(row: OrderRow): Promise<ConversionOrder> {
    if (TERMINAL.has(row.status)) return orderView(row);
    const found = await this.deps.venue.fetchOrder(row.symbol, row.client_order_id);
    if (found) return orderView(await this.book(row, found));
    await this.assertRunning(row.merchant_id);
    const balance = await this.deps.ledger.balance(merchantClearing(row.merchant_id, row.from_asset));
    if (balance.amount < parseAmount(row.from_amount)) {
      return orderView(await this.mark(row.id, { status: 'failed', failureCode: 'pay.conversion_unfunded' }));
    }
    const placed = await this.deps.venue.placeOrder({
      symbol: row.symbol,
      side: 'sell',
      type: 'market',
      amount: parseAmount(row.from_amount),
      clientOrderId: row.client_order_id,
    });
    if (this.deps.afterPlace) await this.deps.afterPlace(placed);
    return orderView(await this.book(row, placed));
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

    if (order.status === 'rejected' || order.status === 'expired' || (order.status === 'canceled' && order.filled === 0n)) {
      return this.mark(fresh.id, {
        status: 'failed',
        failureCode: 'pay.conversion_venue_rejected',
        venueOrderId: order.venueOrderId,
      });
    }
    if (order.filled === 0n) {
      return this.mark(fresh.id, { status: 'placed', venueOrderId: order.venueOrderId });
    }

    let finalOrder = order;
    if (order.remaining > 0n) {
      try {
        finalOrder = await this.deps.venue.cancelOrder(fresh.symbol, fresh.client_order_id);
      } catch {
        throw new ConversionError('pay.conversion_venue_unknown', 'SERVICE_UNAVAILABLE');
      }
    }
    if (finalOrder.filled <= 0n) {
      return this.mark(fresh.id, { status: 'failed', failureCode: 'pay.conversion_venue_rejected', venueOrderId: finalOrder.venueOrderId });
    }

    const filledTo = receivedQuote(finalOrder);
    const split = splitFill(filledTo, parseAmount(fresh.fee_amount), parseAmount(fresh.spread_amount), parseAmount(fresh.minimum_output));
    const merchantUserId = await this.merchantUser(fresh.merchant_id);
    const ledgerInput = {
      conversionId: fresh.id,
      merchantId: fresh.merchant_id,
      merchantUserId,
      venueId: fresh.venue_id,
      fromAsset: fresh.from_asset,
      toAsset: fresh.to_asset,
      fromAmount: finalOrder.filled,
      toAmount: split.merchant,
      feeAmount: split.fee,
      spreadAmount: split.spread,
    };
    await postPayLedger(this.deps.ledger, recipes.fxConversion(ledgerInput));
    if (split.kind === 'reverse') {
      await postPayLedger(this.deps.ledger, recipes.fxConversionReverse(ledgerInput));
      return this.mark(fresh.id, {
        status: 'reversed',
        failureCode: 'pay.conversion_below_minimum',
        filledFrom: finalOrder.filled,
        filledTo,
        venueOrderId: finalOrder.venueOrderId,
      });
    }
    const status = finalOrder.filled === parseAmount(fresh.from_amount) && finalOrder.remaining === 0n ? 'filled' : 'partially_filled';
    return this.mark(fresh.id, {
      status,
      filledFrom: finalOrder.filled,
      filledTo,
      venueOrderId: finalOrder.venueOrderId,
    });
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
