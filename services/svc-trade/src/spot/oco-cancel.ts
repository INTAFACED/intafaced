/**
 * Cancel the legs of a linked OCO through matching, one cancel per leg that rests.
 * Refuse if a sibling is already terminal with no fill recorded.
 * Trade does not invent a trigger.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { TradeError, type OrderRecord } from './types.js';
import { TradeService } from './trade-service.js';
import type { MatchingClient } from './matching-client.js';

export const OCO_SIBLING_TERMINAL = 'oco_sibling_terminal' as const;

const FLAG = Symbol.for('intafaced.trade.ocoCancel');

// A retry after a refused second pull finds one leg gone and no fill, which is otherwise indistinguishable from an
// unexplained terminal sibling. What explains it is the leg-end row written when THIS flow pulled the first leg
// (reason PULL_REASON, trade.oco_leg_end), so the explanation survives a restart.
const PULL_REASON = 'user_pull';

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
      sql: Sql;
      recordOcoLegEnd: (legId: string, remainingQty: string, reason?: string | null) => Promise<void>;
      ocoExecutionSettled: (parentId: string, opts?: { requireBothLegs?: boolean }) => Promise<boolean>;
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
      // An OCO with no leg resting but a recorded leg end is still this flow's (a crash after the pulls): it must not
      // fall through to the ordinary cancel, which would release over a fill that left the book unsettled.
      const hasLegEnd =
        ocoSiblingsLive(listed.orders, orderId) ||
        (await host.sql`SELECT 1 FROM trade.oco_leg_end WHERE parent_id = ${orderId} LIMIT 1`).length > 0;
      if (hasLegEnd) {
        requireScope(principal, 'trade:write');
        // The engine rests an OCO as its legs, and a cancel submitted to its order intake needs a PLACE lifecycle
        // proof (matching answers 400 without one, and a halted market could never be cancelled). Cancel the legs
        // that rest, directly, like any other cancel.
        const legs = ocoSiblingIds(orderId).filter((id) => listed.orders.some((row) => row.orderId === id));
        // One leg gone with no fill recorded is unexplained: refuse and keep the hold. After a partial fill the
        // engine has cancelled the sibling itself, and the remainder is what the user is cancelling.
        // Every leg that is gone must be one THIS flow pulled (its own user_pull row): a different leg that left the
        // book unfilled-and-unrecorded may have filled, and that fill may not be settled yet.
        if (legs.length < 2 && peek.filledQty <= 0n) {
          const missing = ocoSiblingIds(orderId)
            .filter((id) => !legs.includes(id))
            .map((id) => id.slice(-2));
          const pulledRows = await host.sql<Array<{ leg: string }>>`
            SELECT leg FROM trade.oco_leg_end WHERE parent_id = ${orderId} AND reason = ${PULL_REASON}
          `;
          if (!missing.every((leg) => pulledRows.some((row) => row.leg === leg))) {
            throw new TradeError('an OCO sibling is already terminal; trade does not invent a trigger', 'trade.oco_sibling_terminal');
          }
        }
        for (const leg of legs) {
          const pulled = await host.matching.cancel(peek.marketId, leg);
          // A refused pull means the leg moved (it may have filled): do not release over an unsettled fill.
          if (!pulled.cancelled) {
            throw new TradeError('an OCO leg changed while cancelling; retry', 'trade.matching_unavailable');
          }
          await host.recordOcoLegEnd(leg, pulled.cancellation?.remainingQty ?? '0', PULL_REASON);
        }
        // A taker may have filled a leg after the book was read: release only once the settled fills cover what
        // the legs executed. Retrying finds nothing resting and the late fill settles itself.
        if (!(await host.ocoExecutionSettled(orderId, { requireBothLegs: false }))) {
          throw new TradeError('an OCO leg filled while cancelling; retry', 'trade.matching_unavailable');
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
