/**
 * Convert, the firm RFQ: quotes, standing instructions and executing a quote. The book is the source, not the trade.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { TradingControlError } from '../../controls/trading-controls.js';
import { businessPayload } from '../../controls/business-payload.js';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, LedgerError, parseAmount, userAvailable, type Amount } from '@intafaced/ledger-client';
import { withMoneySpan } from '../../tracing.js';
import { assertMarketOpen, assertQty, assertSettlementRails, assertSpotSurface, assertTradable } from '../risk.js';
import { DROP_COPY_SOURCE_RFQ } from '../drop-copy-ingest.js';
import { assertEmailProved } from '../email-proof.js';
import {
  acceptConvertQuote,
  buildFirmConvertQuote,
  estimateConvert,
  estimateConvertForSpend,
  presentBoundConvertFill,
  presentConvertQuote,
  requireConvertQuoteTtlMs,
  requireConvertSpreadBps,
  type BoundConvertFill,
  type ConvertQuoteResult,
  type ConvertTradeWire,
} from '../../convert/quote.js';
import { checkMaxOrderNotional, resolveAdmissionLimits } from '../../futures/pretrade-limits.js';
import { convertSettleIdsFor } from '../../convert/ids.js';
import { convertCustomerHoldKey, planConvertSettle, postConvertSettle, releaseStrandedHouseHold } from '../../convert/settle.js';
import { bindConvertClientId, markConvertRefusal } from '../../convert/convert-history.js';
import { TradeError, type TradeErrorCode } from '../types.js';
import type { ConvertExecuteRequest, ConvertQuoteRequest, PlaceOrderInput, TradeServiceInternal } from '../trade-service.js';

export async function convertQuoteFor(svc: TradeServiceInternal, userId: string, input: ConvertQuoteRequest) {
  const quote = await svc.buildConvertQuote(userId, input);
  await svc.convertStore.saveOpen(quote);
  return presentConvertQuote(quote);
}

/**
 * Settle a stored quote for a user on behalf of a svc-bank schedule. Same quote,
 * ledger recipes and idempotency as the interactive door; only admission differs.
 */
export async function standingConvertExecute(
  svc: TradeServiceInternal,
  userId: string,
  instructionId: string,
  input: ConvertExecuteRequest,
): Promise<ConvertTradeWire> {
  svc.requireStandingInstructions();
  return svc.convertExecuteFor(userId, input, (businessId, payload) => {
    if (!svc.accountAdmission) throw new TradingControlError('authority.unavailable');
    if (typeof svc.accountAdmission.admitStanding !== 'function') throw new TradingControlError('authority.unavailable');
    return svc.accountAdmission.admitStanding(userId, instructionId, businessId, payload);
  });
}

export async function convertExecute(
  svc: TradeServiceInternal,
  principal: Principal,
  input: ConvertExecuteRequest,
): Promise<ConvertTradeWire> {
  requireScope(principal, 'trade:write');
  return svc.convertExecuteFor(principal.userId, input, (businessId, payload) =>
    svc.admitAccountOperation(principal, 'order.place', businessId, payload),
  );
}

export async function convertExecuteFor(
  svc: TradeServiceInternal,
  userId: string,
  input: ConvertExecuteRequest,
  admit: (businessId: string, payload: unknown) => Promise<unknown>,
): Promise<ConvertTradeWire> {
  return withMoneySpan(
    'trade.convertExecute',
    {
      operation: 'convert',
      userId,
      orderId: input.quoteId,
    },
    async (span) => {
      if (!svc.convertEnabled) {
        throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
      }
      requireConvertSpreadBps(svc.convertSpreadBps);
      requireConvertQuoteTtlMs(svc.convertQuoteTtlMs);
      if (!input.quoteId || input.quoteId.trim().length < 1) {
        throw new TradeError('convert quote id is required — refuse rather than invent a mid', 'trade.convert_quote_missing');
      }

      const stored = await svc.convertStore.load(input.quoteId);
      if (!stored) {
        throw new TradeError('convert quote not found', 'trade.convert_quote_missing');
      }
      if (stored.quote.userId !== userId) {
        throw new TradeError('convert quote belongs to another user', 'trade.convert_not_owner');
      }
      await bindConvertClientId(svc.sql, userId, stored.quote.quoteId, input.clientConvertId);

      const ids = convertSettleIdsFor(stored.quote.quoteId);
      if (stored.lifecycle === 'settled') {
        span.setAttribute('intafaced.fill_id', ids.fillId);
        return presentBoundConvertFill(stored.bound, { ...ids, settledAt: stored.settledAt });
      }
      // A convert holds and swaps customer funds: same email-proof gate as an order (RC-identity-01),
      // for the customer's accept and for a standing schedule alike. A settled replay returned above.
      await assertEmailProved(svc.emailProof, userId);

      if (input.symbol != null && input.symbol !== stored.quote.symbol) {
        throw new TradeError('convert accept must honour the quoted symbol', 'trade.convert_price_moved');
      }
      if (input.side != null && input.side !== stored.quote.side) {
        throw new TradeError('convert accept must honour the quoted side', 'trade.convert_price_moved');
      }
      if (input.qty != null && input.qty !== stored.quote.requestedQty) {
        throw new TradeError('convert accept must honour the quoted quantity', 'trade.convert_price_moved');
      }

      const original = await svc.accountAdmission?.original(userId, `convert:${stored.quote.quoteId}`);
      const recordedBound = (original?.payload as { bound?: { fillPrice: string; fillNotional: string; acceptedAt: string } } | undefined)
        ?.bound;
      let bound: BoundConvertFill;
      if (recordedBound) {
        bound = {
          quote: stored.quote,
          fillPrice: parseAmount(recordedBound.fillPrice),
          fillNotional: parseAmount(recordedBound.fillNotional),
          acceptedAt: recordedBound.acceptedAt,
        };
      } else if (stored.lifecycle === 'bound') {
        bound = stored.bound;
      } else {
        bound = acceptConvertQuote({
          quote: stored.quote,
          now: svc.now(),
          assertedPrice: input.maxAvgPrice ?? null,
        });
      }
      // A recorded price (a `bound` quote, or one put back to `open` after a
      // refused settle, #4676) is replayed on retry. With no customer hold
      // booked nothing is committed yet, so the TTL applies: refuse before
      // anything is posted or re-bound, else a top-up hours later (or a retry
      // after a timed-out hold post) settles at a stale rate. With the hold
      // booked, the original recovery semantics stand.
      if (stored.lifecycle === 'bound' || (stored.lifecycle === 'open' && recordedBound)) {
        const expiresAt = Date.parse(stored.quote.expiresAt);
        if (svc.now().getTime() > expiresAt && !(await svc.ledger.getTxByKey(convertCustomerHoldKey(ids.takerOrderId)))) {
          // A legacy attempt may have booked the house hold first: give it back.
          await releaseStrandedHouseHold(svc.ledger, planConvertSettle({ bound, ...ids, now: new Date(bound.acceptedAt) }));
          throw new TradeError('convert quote expired — refuse rather than requote', 'trade.convert_quote_expired');
        }
      }
      // Owner pre-trade max-order limit (#4725) on a FRESH accept only: a
      // bound or admitted original is a recovery and never creates new risk.
      if (stored.lifecycle === 'open' && !original) {
        const resolved = resolveAdmissionLimits();
        if ('refusal' in resolved) throw new TradeError(resolved.refusal.message, resolved.refusal.code as TradeErrorCode);
        const refusal = checkMaxOrderNotional({
          limits: resolved.limits,
          quoteAsset: bound.quote.quoteAsset,
          notional: bound.fillNotional,
          what: 'convert',
        });
        if (refusal) throw new TradeError(refusal.message, refusal.code as TradeErrorCode);
      }
      // The quote's immutable original bound is the business payload. A retry
      // recovers this decision rather than sampling a new price or quantity.
      if (stored.lifecycle === 'open' || original) {
        await admit(`convert:${stored.quote.quoteId}`, original?.payload ?? businessPayload({ quote: stored.quote, bound, ids }));
      }
      if (stored.lifecycle === 'open') {
        await svc.convertStore.saveBound(stored.quote, bound);
      }

      // Expiry governs the original accept, not recovery of already bound effects.
      const plan = planConvertSettle({ bound, ...ids, now: new Date(bound.acceptedAt) });
      try {
        await postConvertSettle(svc.ledger, plan);
      } catch (err) {
        // A definite refusal posted nothing that is still held (customer
        // shortfall posts nothing; house shortfall already released the
        // customer hold), so the quote must not stay `bound`. Unknown
        // outcomes stay bound: effects may exist and recovery needs them.
        if (
          (err instanceof LedgerError && err.code === 'ledger.insufficient_funds') ||
          (err instanceof TradeError && err.code === 'trade.convert_liquidity_unavailable')
        ) {
          await svc.convertStore.saveOpen(stored.quote);
          await markConvertRefusal(svc.sql, stored.quote.quoteId, err.code);
        }
        throw err;
      }
      const settledAt = svc.now();
      await svc.convertStore.saveSettled(stored.quote, bound, settledAt);
      await svc.notifyDropCopyFill({
        fillId: ids.fillId,
        orderId: ids.takerOrderId,
        userId: bound.quote.userId,
        marketId: bound.quote.marketId,
        side: bound.quote.side,
        price: formatAmount(bound.fillPrice),
        qty: formatAmount(bound.quote.filledQty),
        quoteAmount: formatAmount(bound.fillNotional),
        feeAsset: bound.quote.quoteAsset,
        feeAmount: '0',
        ts: settledAt.toISOString(),
        source: DROP_COPY_SOURCE_RFQ,
      });
      span.setAttribute('intafaced.fill_id', ids.fillId);
      return presentBoundConvertFill(bound, { ...ids, settledAt: settledAt.toISOString() });
    },
  );
}

export function scalePorts(svc: TradeServiceInternal) {
  return {
    sql: svc.sql,
    placeOrder: (principal: Principal, input: PlaceOrderInput) => svc.placeOrder(principal, input),
    cancelOrder: (principal: Principal, orderId: string) => svc.cancelOrder(principal, orderId),
    findClientOrder: (principal: Principal, input: { marketId: string; clientOrderId: string }) => svc.findClientOrder(principal, input),
    marketBySymbol: (symbol: string) => svc.marketBySymbol(symbol),
    available: async (userId: string, assetId: string) => (await svc.ledger.balance(userAvailable(userId, assetId))).amount,
  };
}

export async function buildConvertQuote(svc: TradeServiceInternal, userId: string, input: ConvertQuoteRequest) {
  if (!svc.convertEnabled) {
    throw new TradeError('convert is disabled by the operator kill-switch', 'trade.convert_disabled');
  }
  const convertSpreadBps = requireConvertSpreadBps(svc.convertSpreadBps);
  const quoteTtlMs = requireConvertQuoteTtlMs(svc.convertQuoteTtlMs);
  if (!svc.spotEnabled) {
    throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  }

  const market = await svc.requireMarket(input);
  // Convert is a spot-shaped RFQ and says so itself, rather than inheriting the
  // order path's kind refusal — which is about to become a flag. See
  // `assertSpotSurface`.
  assertSpotSurface(market, 'convert');
  assertTradable(market);
  assertSettlementRails(market);
  // Same schedule gate as placeOrder / TWAP create — before qty or book walk.
  // A quote for a shut / unrecognised venue is a lie (invented mid / weekend
  // EUR/USD fundable quote while place refuses market_closed).
  assertMarketOpen(market, svc.now());
  if ((input.qty == null) === (input.quoteQty == null)) {
    throw new TradeError('convert takes exactly one of qty (base amount) or quoteQty (spend)', 'trade.convert_invalid_qty');
  }
  // Same gate order as before: a bad base quantity refuses before the book is read.
  if (input.qty != null) assertQty(market, input.qty);

  const depth = await svc.matching.depth(market.id, 50);
  const levels = input.side === 'buy' ? depth.asks : depth.bids;
  let requestedQty: Amount;
  let estimate: ConvertQuoteResult;
  if (input.quoteQty != null) {
    // Spend: round DOWN to the lot grid so the charge can never exceed what the user typed.
    const spend = estimateConvertForSpend({
      side: input.side,
      quoteQty: input.quoteQty,
      levels,
      convertSpreadBps,
      tickSize: market.tickSize,
      lotSize: market.lotSize,
    });
    requestedQty = spend.qty;
    estimate = spend;
    // Same floors an order meets: min qty and min notional (floored like a fill), then max qty.
    if (requestedQty < market.minQty || spend.bookNotional < market.minNotional) {
      throw new TradeError(
        `spend ${formatAmount(input.quoteQty)} ${market.quoteAsset} buys ${formatAmount(requestedQty)} ${market.baseAsset}, below the ${formatAmount(market.minQty)} ${market.baseAsset} / ${formatAmount(market.minNotional)} ${market.quoteAsset} minimum`,
        'trade.below_min_notional',
      );
    }
    assertQty(market, requestedQty);
  } else {
    requestedQty = input.qty as Amount;
    estimate = estimateConvert({
      side: input.side,
      qty: requestedQty,
      levels,
      convertSpreadBps,
      tickSize: market.tickSize,
    });
  }

  if (!estimate.fullyFilled) {
    throw new TradeError(
      `insufficient book depth to convert ${formatAmount(requestedQty)} ${market.baseAsset} — only ${formatAmount(estimate.filledQty)} available`,
      'trade.convert_insufficient_depth',
    );
  }

  const now = svc.now();
  return buildFirmConvertQuote({
    quoteId: crypto.randomUUID(),
    userId,
    symbol: market.symbol,
    marketId: market.id,
    side: input.side,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    requestedQty,
    estimate,
    convertSpreadBps,
    source: { kind: 'book', symbol: market.symbol, asOf: now.toISOString() },
    now,
    quoteTtlMs,
  });
}
