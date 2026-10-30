import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, sub, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { withMoneySpan } from '../tracing.js';
import { assertMarketOpen, assertNotional, assertPrice, assertQty, assertSettlementRails, assertTradable, holdFor } from './risk.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { EngineAmendResult, MatchingClient } from './matching-client.js';
import { BUYBACK_INVALID, isBuybackUser } from './buyback-order.js';
import { TradeError, type AmendOrderOutcome, type AmendOutcomeCode, type AmendPriority, type Market, type OrderRecord } from './types.js';
import { TradeService, type AmendOrderInput } from './trade-service.js';

/**
 * Native amend on the existing PATCH door.
 *
 * TRD-0504: amend may only REDUCE the remaining quantity. A larger quantity
 * is `trade.amend_qty_up` and must go through replace. `expectedRemaining`
 * or `expectedVersion` that does not match the engine is `trade.amend_stale`.
 *
 * Installed onto `TradeService.prototype` so the class file never moves.
 */
type AmendHost = {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  readonly matching: MatchingClient;
  readonly futuresEnabled: boolean;
  readonly optionsSettlementAssetLaw: string;
  now: () => Date;
  findOrder: (orderId: string) => Promise<OrderRecord | null>;
  marketById: (marketId: string) => Promise<Market | null>;
  remainingHold: (sql: Sql, order: OrderRecord) => Promise<Amount>;
  assertLifecycleAction: (market: Market, action: 'AMEND') => Promise<LifecycleAdmissionProof>;
  markRecoveryRequired: (orderId: string, reason: 'AMEND_UNKNOWN') => Promise<void>;
  applyNativeAmendHold: (
    order: OrderRecord,
    market: Market,
    newRemaining: Amount,
    version: number,
    sequence: number | null,
  ) => Promise<void>;
  settleOutcome: (market: Market, fills: EngineAmendResult['fills'], cancellations: EngineAmendResult['cancellations']) => Promise<void>;
  amendOutcome: (
    order: OrderRecord,
    code: AmendOutcomeCode,
    reasonCode: string | null,
    reconciliationRequired: boolean,
    idempotent: boolean,
    priority: AmendPriority | null,
  ) => AmendOrderOutcome;
};

const FLAG = Symbol.for('intafaced.trade.nativeQtyUpAmend');

function asHost(svc: object): AmendHost {
  return svc as unknown as AmendHost;
}

async function amendOrderWithQtyUp(
  this: TradeService,
  principal: Principal,
  orderId: string,
  input: AmendOrderInput,
): Promise<AmendOrderOutcome> {
  const host = asHost(this);
  return withMoneySpan('trade.amendOrder', { operation: 'amend_order', userId: principal.userId, orderId }, async () => {
    requireScope(principal, 'trade:write');

    const order = await host.findOrder(orderId);
    if (!order || order.userId !== principal.userId) {
      throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    }
    // A buyback order is IOC and its hold lives in the buyback account: refuse before the engine is asked to change it.
    if (isBuybackUser(order.userId)) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', BUYBACK_INVALID, false, false, null);
    }
    if (order.status === 'recovery_required') {
      return host.amendOutcome(order, 'AMEND_UNKNOWN', order.recoveryReason ?? 'AMEND_UNKNOWN', true, false, null);
    }
    if (order.status !== 'open') {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }

    if (input.side != null && input.side !== order.side) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_side_change', false, false, null);
    }
    if (input.type != null && input.type !== order.type) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_type_change', false, false, null);
    }
    if (input.tif != null && input.tif !== order.tif) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_tif_change', false, false, null);
    }
    if (input.price != null && order.price != null && input.price !== order.price) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_price_change', false, false, null);
    }
    if (input.marketId != null && input.marketId !== order.marketId) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
    }

    const market = await host.marketById(order.marketId);
    if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
    if (input.symbol != null && input.symbol !== market.symbol) {
      return host.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
    }

    if (market.kind !== 'spot' || market.paper) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.market_kind_unsupported', false, false, null);
    }
    if (order.type !== 'limit' || order.price == null) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.invalid_price', false, false, null);
    }
    if (order.tif === 'IOC' || order.tif === 'FOK') {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }
    if (input.qty <= 0n) {
      throw new TradeError('amend quantity must be strictly positive', 'trade.invalid_qty');
    }

    const remainingQty = sub(order.qty, order.filledQty);
    if (remainingQty <= 0n) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }
    if (input.qty > remainingQty) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
    }
    try {
      assertTradable(market, {
        futuresEnabled: host.futuresEnabled,
        optionsSettlementLawStamped: host.optionsSettlementAssetLaw.trim().length > 0,
        now: host.now(),
      });
      assertSettlementRails(market);
      assertMarketOpen(market, host.now());
      assertQty(market, input.qty);
      assertPrice(market, order.price);
      assertNotional(market, order.price, input.qty);
    } catch (err) {
      if (err instanceof TradeError) {
        return host.amendOutcome(order, 'NOT_AMENDABLE', err.code, false, false, null);
      }
      throw err;
    }

    let lifecycleProof: LifecycleAdmissionProof;
    try {
      lifecycleProof = await host.assertLifecycleAction(market, 'AMEND');
    } catch (err) {
      if (err instanceof TradeError && err.code.startsWith('trade.lifecycle_')) {
        return host.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
      }
      if (err instanceof TradeError && (err.code === 'trade.market_halted' || err.code === 'trade.market_suspended')) {
        return host.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
      }
      throw err;
    }

    const newHold = holdFor(market, order.side, order.price, input.qty).amount;
    const leftover = await host.remainingHold(host.sql, order);

    let listed;
    try {
      listed = await host.matching.listOrders(order.marketId, order.id);
    } catch {
      await host.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await host.findOrder(order.id)) ?? order;
      return host.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }
    const live = listed.orders.find((candidate) => candidate.orderId === order.id);
    if (!live) {
      await host.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await host.findOrder(order.id)) ?? order;
      return host.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }

    const engineRemaining = parseAmount(live.remaining);
    const expectedVersion = live.version ?? order.engineVersion;
    if (input.expectedRemaining != null && input.expectedRemaining !== engineRemaining) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_stale', false, false, null);
    }
    if (input.expectedVersion != null && input.expectedVersion !== expectedVersion) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_stale', false, false, null);
    }
    if (input.qty > engineRemaining) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
    }
    if (leftover < newHold) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.hold_uncovered', false, false, null);
    }

    const funded = order;

    if (engineRemaining === input.qty) {
      await host.applyNativeAmendHold(funded, market, input.qty, expectedVersion, live.sequence);
      const settled = (await host.findOrder(order.id)) ?? funded;
      return host.amendOutcome(settled, 'IDEMPOTENT_RETRY', null, false, true, 'retained');
    }

    let result: EngineAmendResult;
    try {
      result = await host.matching.amend(order.marketId, order.id, {
        expectedVersion,
        qty: formatAmount(input.qty),
        lifecycleProof,
      });
    } catch {
      await host.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await host.findOrder(order.id)) ?? funded;
      return host.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }

    if (!result.accepted) {
      if (result.rejected?.code === 'order_not_found') {
        await host.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
        const frozen = (await host.findOrder(order.id)) ?? funded;
        return host.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
      }
      if (result.rejected?.code === 'version_mismatch') {
        const after = (await host.findOrder(order.id)) ?? order;
        return host.amendOutcome(after, 'VERSION_MISMATCH', 'version_mismatch', false, false, null);
      }
      const after = (await host.findOrder(order.id)) ?? order;
      return host.amendOutcome(after, 'ENGINE_REFUSED', result.rejected?.code ?? 'refused', false, false, null);
    }

    await host.settleOutcome(market, result.fills, result.cancellations);
    const afterFills = (await host.findOrder(order.id)) ?? funded;
    if (afterFills.status !== 'open' && afterFills.status !== 'recovery_required') {
      return host.amendOutcome(afterFills, 'AMENDED', null, false, false, result.priority);
    }

    const version = result.version ?? expectedVersion + 1;
    await host.applyNativeAmendHold(afterFills, market, input.qty, version, result.sequence);
    const settled = (await host.findOrder(order.id)) ?? afterFills;
    return host.amendOutcome(settled, 'AMENDED', null, false, false, result.priority);
  });
}

export function installNativeQtyUpAmend(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as { amendOrder: unknown; [FLAG]?: true };
  if (proto[FLAG]) return;
  proto[FLAG] = true;
  proto.amendOrder = amendOrderWithQtyUp;
}

installNativeQtyUpAmend(TradeService);
