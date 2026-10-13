import { requireScope, type Principal } from '@intafaced/auth';
import {
  add,
  formatAmount,
  InsufficientFundsError,
  orderHoldAmend,
  parseAmount,
  recipes as ledgerRecipes,
  sub,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { withMoneySpan } from '../tracing.js';
import { assertMarketOpen, assertNotional, assertPrice, assertQty, assertSettlementRails, assertTradable, holdFor } from './risk.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { EngineAmendResult, MatchingClient } from './matching-client.js';
import { attributionFromOrder, withLedgerAttribution } from './auth-attribution.js';
import { TradeError, type AmendOrderOutcome, type AmendOutcomeCode, type AmendPriority, type Market, type OrderRecord } from './types.js';
import { TradeService, type AmendOrderInput } from './trade-service.js';
import { businessPayload } from '../controls/business-payload.js';

/**
 * Native qty-up on the existing PATCH door.
 *
 * Extra size posts `recipes.orderHoldAmend` (same pot, sequenced key) before
 * matching. Refuse if that hold cannot be taken. Stop/TP funding stays a socket.
 *
 * Installed onto `TradeService.prototype` so the class file never moves.
 *
 * `orderHoldAmend` is a named ledger-client export, not a registry key yet.
 * Bind it here so the live post is `recipes.orderHoldAmend` (inventory scan).
 */
const recipes = { ...ledgerRecipes, orderHoldAmend };

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

/**
 * A qty-down already posts `order.release:<orderId>:<engineVersion>`.
 * The refused qty-up must not reuse that key: the ledger would replay the
 * old release and leave the extra in the order hold. Engine versions stay
 * small. This band is only the rolled-back extra.
 */
const QTY_UP_ROLLBACK_SEQUENCE = 1_000_000_000;

function asHost(svc: object): AmendHost {
  return svc as unknown as AmendHost;
}

async function takeQtyUpHold(
  host: AmendHost,
  order: OrderRecord,
  extra: Amount,
  sequence: number,
): Promise<{ ok: true } | { ok: false; code: AmendOutcomeCode; reason: string }> {
  try {
    await host.ledger.post(
      withLedgerAttribution(
        recipes.orderHoldAmend({
          orderId: order.id,
          userId: order.userId,
          assetId: order.holdAsset,
          amount: extra,
          sequence,
        }),
        attributionFromOrder(order),
      ),
    );
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return { ok: false, code: 'NOT_AMENDABLE', reason: err.code };
    }
    return { ok: false, code: 'AMEND_UNKNOWN', reason: 'AMEND_UNKNOWN' };
  }
  await host.sql`
    UPDATE trade.orders
       SET hold_amount = ${formatAmount(add(order.holdAmount, extra))}::numeric,
           updated_at = now()
     WHERE id = ${order.id}
       AND hold_amount = ${formatAmount(order.holdAmount)}::numeric
  `;
  return { ok: true };
}

async function releaseQtyUpHold(host: AmendHost, order: OrderRecord, extra: Amount, sequence: number): Promise<void> {
  await host.ledger.post(
    withLedgerAttribution(
      recipes.orderHoldRelease({
        orderId: order.id,
        userId: order.userId,
        assetId: order.holdAsset,
        amount: extra,
        sequence,
      }),
      attributionFromOrder(order),
    ),
  );
  await host.sql`
    UPDATE trade.orders
       SET hold_amount = ${formatAmount(order.holdAmount)}::numeric,
           updated_at = now()
     WHERE id = ${order.id}
  `;
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
      listed = await host.matching.listOrders(order.marketId);
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
    const extra = leftover < newHold ? sub(newHold, leftover) : 0n;
    if (extra > 0n && engineRemaining > input.qty) {
      return host.amendOutcome(order, 'NOT_AMENDABLE', 'trade.hold_uncovered', false, false, null);
    }

    let funded = order;
    if (input.qty > engineRemaining) {
      // Each native increase is fresh exposure. Original parent placement is
      // not authority for it; the stable engine version identifies this intent.
      await this.admitNativeQtyIncrease(
        principal,
        `amend:${order.id}:${expectedVersion}`,
        businessPayload({
          orderId: order.id,
          expectedVersion,
          qty: input.qty,
          extra,
          newHold,
          holdAmount: order.holdAmount,
          holdAsset: order.holdAsset,
          lifecycleProof,
        }),
      );
    }
    if (extra > 0n) {
      const taken = await takeQtyUpHold(host, order, extra, expectedVersion);
      if (!taken.ok) {
        if (taken.code === 'AMEND_UNKNOWN') {
          await host.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
          const frozen = (await host.findOrder(order.id)) ?? order;
          return host.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
        }
        return host.amendOutcome(order, taken.code, taken.reason, false, false, null);
      }
      funded = (await host.findOrder(order.id)) ?? { ...order, holdAmount: add(order.holdAmount, extra) };
    }

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
      if (extra > 0n) {
        await releaseQtyUpHold(host, order, extra, QTY_UP_ROLLBACK_SEQUENCE + expectedVersion);
      }
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
