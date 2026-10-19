/**
 * Cancel both siblings of a linked OCO through matching (#3642).
 * Refuse if either sibling is already terminal.
 * Trade does not invent a trigger.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount } from '@intafaced/ledger-client';
import { TradeError, type OrderRecord } from './types.js';
import { TradeService } from './trade-service.js';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from './matching-client.js';

export const OCO_SIBLING_TERMINAL = 'oco_sibling_terminal' as const;

const FLAG = Symbol.for('intafaced.trade.ocoCancel');

export function ocoSiblingIds(parentId: string): readonly [string, string] {
  return [`${parentId}:tp`, `${parentId}:sl`];
}

export function ocoSiblingsLive(orders: readonly { readonly orderId: string }[], parentId: string): boolean {
  const [tp, sl] = ocoSiblingIds(parentId);
  return orders.some((row) => row.orderId === tp || row.orderId === sl);
}

export function matchingOcoCancelRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== OCO_SIBLING_TERMINAL) return null;
  return new TradeError('an OCO sibling is already terminal; trade does not invent a trigger', 'trade.oco_sibling_terminal');
}

function ocoCancelSubmit(order: OrderRecord): EngineSubmitRequest {
  return {
    orderId: order.id,
    accountId: order.userId,
    type: order.type,
    side: order.side,
    qty: formatAmount(order.qty),
    price: order.price == null ? null : formatAmount(order.price),
    tif: order.tif,
    cancel: true,
    oco: true,
  } as EngineSubmitRequest;
}

export function installOcoCancel(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    cancelOrder: (principal: Principal, orderId: string) => Promise<OrderRecord>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origCancel = proto.cancelOrder;
  proto.cancelOrder = async function (this: TradeService, principal: Principal, orderId: string) {
    const host = this as unknown as {
      matching: MatchingClient;
      findOrder: (id: string) => Promise<OrderRecord | null>;
      finalize: (orderId: string, status: 'cancelled' | 'filled' | 'expired' | 'rejected') => Promise<void>;
    };

    const peek = await host.findOrder(orderId);
    if (
      peek &&
      peek.userId === principal.userId &&
      (peek.status === 'open' || peek.status === 'pending' || peek.status === 'recovery_required')
    ) {
      let listed: Awaited<ReturnType<MatchingClient['listOrders']>>;
      try {
        listed = await host.matching.listOrders(peek.marketId);
      } catch {
        return origCancel.call(this, principal, orderId);
      }
      if (ocoSiblingsLive(listed.orders, orderId)) {
        requireScope(principal, 'trade:write');
        const result: EngineSubmitResult = await host.matching.submit(peek.marketId, ocoCancelSubmit(peek));
        if (result.rejected?.code === OCO_SIBLING_TERMINAL && peek.filledQty > 0n) {
          // The engine cancels a sibling on any first fill, so after a partial fill one leg is gone and the
          // other still rests. The user is cancelling that remainder: pull each leg still listed, then close.
          // With no fill recorded a missing sibling is unexplained, and the refusal below stands.
          for (const row of listed.orders) {
            if (!ocoSiblingIds(orderId).includes(row.orderId)) continue;
            await host.matching.cancel(peek.marketId, row.orderId);
          }
          await host.finalize(orderId, 'cancelled');
          const closed = await host.findOrder(orderId);
          if (!closed) throw new TradeError(`order ${orderId} vanished during OCO cancel`, 'trade.order_not_found');
          return closed;
        }
        const refuse = matchingOcoCancelRefuse(result.rejected);
        if (refuse) throw refuse;
        if (!result.accepted) {
          if (result.rejected?.code === 'order_not_found') return origCancel.call(this, principal, orderId);
          throw new TradeError(result.rejected?.message ?? 'linked OCO cancel refused', 'trade.matching_unavailable');
        }
        await host.finalize(orderId, 'cancelled');
        const settled = await host.findOrder(orderId);
        if (!settled) throw new TradeError(`order ${orderId} vanished during OCO cancel`, 'trade.order_not_found');
        return settled;
      }
    }

    return origCancel.call(this, principal, orderId);
  };
}

installOcoCancel(TradeService);
