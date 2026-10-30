/**
 * Reconciling one order against the engine and the ledger.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { formatAmount } from '@intafaced/ledger-client';
import { holdAccountOf } from '../buyback-order.js';
import { withMoneySpan } from '../../tracing.js';
import { ocoLegParent, settlementOrderId } from '../oco-legs.js';
import { HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS } from '../hold-outcome.js';
import { type ReconcileResult } from '../types.js';
import type { TradeServiceInternal } from '../trade-service.js';
import { fillsProveNoFill } from './internal.js';

/**
 * CX-9 — open ↔ hold ↔ engine reconcile (Plan P1-5).
 *
 * Operator / recovery entry for a **single** suspect order. Not a cancel-all.
 *
 * | Case | Detection | Action |
 * | --- | --- | --- |
 * | orphan pending | `pending` + hold 0 + older than the in-flight bound | delete row (never held) |
 * | pending in flight | `pending` + hold 0 + inside the bound | no action (a hold may still commit) |
 * | open+hold, engine live | `open` + hold > 0 + list hit | cancel then release remainder once |
 * | open+hold, engine miss, proven empty fills | list miss + `trade.fills` empty + `filled_qty` 0 | cancel remainder (existing path, fills are the evidence) |
 * | open+hold, engine miss, unknown fills | list miss + fills do not prove no fill | **fail closed** — named break, hold stays |
 * | open+engine no hold | `open` + hold 0 | **fail closed** — do not invent hold; cancel free book risk if live |
 *
 * Liveness is **list first** (`GET` engine orders). Cancel is repair, not probe
 * (W6/W7 residual: cancel-as-probe emptied the book to ask if it was live).
 * Fail closed means: never mint a hold from this path; never mark filled without fills;
 * never auto-release on funded engine-miss when `trade.fills` cannot prove no fill.
 */
export async function reconcileOrder(svc: TradeServiceInternal, orderId: string): Promise<ReconcileResult> {
  return withMoneySpan('trade.reconcileOrder', { operation: 'reconcile_order', orderId }, async () => {
    const order = await svc.findOrder(orderId);
    if (!order) {
      return {
        orderId,
        case: 'not_found',
        action: 'none',
        holdBefore: '0',
        engineLive: null,
        detail: 'no order row',
      };
    }

    if (order.status !== 'pending' && order.status !== 'open' && order.status !== 'recovery_required') {
      return {
        orderId,
        case: 'terminal',
        action: 'none',
        holdBefore: '0',
        engineLive: null,
        detail: `status=${order.status}`,
      };
    }

    const holdBal = (await svc.ledger.balance(holdAccountOf(order))).amount;
    const holdBefore = formatAmount(holdBal);

    // ── orphan pending: intent row, never funded ───────────────────────────
    // Same age floor as the scheduled reconcile. Inside it, a hold post can
    // still commit after this balance read; deleting the row would strand it.
    if (order.status === 'pending' && holdBal === 0n) {
      const removed = await svc.sql<{ id: string }[]>`
        DELETE FROM trade.orders
         WHERE id = ${orderId}
           AND status = 'pending'
           AND updated_at <= now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS})
        RETURNING id
      `;
      if (removed.length === 0) {
        const current = await svc.findOrder(orderId);
        if (!current) {
          return {
            orderId,
            case: 'not_found',
            action: 'none',
            holdBefore,
            engineLive: null,
            detail: 'pending row vanished before the age-bounded delete',
          };
        }
        return {
          orderId,
          case: 'pending_in_flight',
          action: 'none',
          holdBefore,
          engineLive: null,
          detail:
            current.status === 'pending'
              ? 'pending row is inside the hold in-flight bound — left in place'
              : `status=${current.status} changed before the pending delete — left in place`,
        };
      }
      return {
        orderId,
        case: 'orphan_pending',
        action: 'deleted',
        holdBefore,
        engineLive: false,
        detail: 'pending row with no hold — deleted (fail-closed safe)',
      };
    }

    // Non-destructive liveness: list before any cancel.
    const listed = await svc.matching.listOrders(order.marketId, orderId);
    const engineLive = listed.orders.some((o) => settlementOrderId(o.orderId) === orderId);

    // Recovery is a lookup, not a blind resubmit. A live engine order stays
    // unresolved and encumbered. List miss still consults trade.fills before
    // any release — unknown fills are a named break, not a refund.
    if (order.status === 'recovery_required') {
      if (holdBal === 0n) {
        await svc.finalize(orderId, 'cancelled');
        return {
          orderId,
          case: 'recovery_required_no_hold',
          action: 'fail_closed',
          holdBefore,
          engineLive,
          detail: engineLive
            ? 'recovery-required order is live but has no hold — cancelled free book risk; NO hold invented'
            : 'recovery-required order has no hold and is absent — terminalized; NO hold invented',
        };
      }
      if (engineLive) {
        return {
          orderId,
          case: 'recovery_required_live',
          action: 'none',
          holdBefore,
          engineLive: true,
          detail: `recovery-required (${order.recoveryReason ?? 'unknown'}) is live; hold retained pending engine outcome`,
        };
      }
      const recoveryFills = await svc.fillEvidence(orderId);
      if (!fillsProveNoFill(order.filledQty, recoveryFills)) {
        return {
          orderId,
          case: 'open_hold_no_engine_unknown',
          action: 'fail_closed',
          holdBefore,
          engineLive: false,
          detail: `trade.reconcile_unknown_engine_miss: recovery-required (${order.recoveryReason ?? 'unknown'}) absent from engine; trade.fills count=${recoveryFills.count} qty=${formatAmount(recoveryFills.qty)} filled_qty=${formatAmount(order.filledQty)} — hold retained`,
        };
      }
      await svc.finalize(orderId, 'cancelled');
      return {
        orderId,
        case: 'recovery_required_absent',
        action: 'released',
        holdBefore,
        engineLive: false,
        detail: `recovery-required (${order.recoveryReason ?? 'unknown'}) absent from engine; trade.fills prove empty; remainder released once`,
      };
    }

    // ── open (or pending-with-hold) + no ledger hold — FAIL CLOSED ────────
    // Spec: open+engine no hold. We treat any open/pending with zero hold as
    // fail-closed: never invent a hold. Cancel only if list says live (free book risk).
    if (holdBal === 0n) {
      if (engineLive) {
        await svc.matching.cancel(order.marketId, orderId);
      }
      // Terminalize without release (remainder already 0). Do not invent money.
      await svc.finalize(orderId, 'cancelled');
      return {
        orderId,
        case: 'open_engine_no_hold',
        action: 'fail_closed',
        holdBefore,
        engineLive,
        detail: engineLive
          ? 'open/pending with zero hold while engine list had the order — cancelled free book risk; NO hold invented'
          : 'open/pending with zero hold and engine list miss — terminalized; NO hold invented',
      };
    }

    // ── open+hold: list then cancel-if-live, or miss → consult fills ───────
    // Engine miss + hold is three shapes (never live / already gone / lost
    // fill). Order row + hold cannot tell them apart. `trade.fills` is the
    // only local proof of no fill. No fills table row and filled_qty 0 is
    // the existing cancel path. Anything else is unknown: refuse, no refund.
    if (engineLive) {
      // An OCO rests as its legs, never under the parent id: pull each leg, and release only if every pull held.
      const legs = listed.orders.map((o) => o.orderId).filter((id) => ocoLegParent(id) === orderId);
      if (legs.length > 0) {
        for (const leg of legs) {
          const pulled = await svc.matching.cancel(order.marketId, leg);
          if (!pulled.cancelled) {
            return {
              orderId,
              case: 'open_hold_no_engine_unknown',
              action: 'fail_closed',
              holdBefore,
              engineLive: true,
              detail: `OCO leg ${leg} changed while reconciling; hold retained, no refund`,
            };
          }
          if (pulled.cancellation) await svc.recordOcoLegEnd(leg, pulled.cancellation.remainingQty, pulled.cancellation.reason);
        }
        if (!(await svc.ocoExecutionSettled(orderId, { requireBothLegs: false }))) {
          return {
            orderId,
            case: 'open_hold_no_engine_unknown',
            action: 'fail_closed',
            holdBefore,
            engineLive: true,
            detail: 'OCO legs executed more than has settled; hold retained until the late fill settles',
          };
        }
      } else {
        await svc.matching.cancel(order.marketId, orderId);
      }
      await svc.finalize(orderId, 'cancelled');
      return {
        orderId,
        case: 'open_hold_engine_cleared',
        action: 'released',
        holdBefore,
        engineLive: true,
        detail: 'open+hold; engine list live then cancelled; remainder released once',
      };
    }

    const fills = await svc.fillEvidence(orderId);
    if (!fillsProveNoFill(order.filledQty, fills)) {
      return {
        orderId,
        case: 'open_hold_no_engine_unknown',
        action: 'fail_closed',
        holdBefore,
        engineLive: false,
        detail: `trade.reconcile_unknown_engine_miss: open+hold; engine list miss; trade.fills count=${fills.count} qty=${formatAmount(fills.qty)} filled_qty=${formatAmount(order.filledQty)} — hold retained, no refund`,
      };
    }

    await svc.finalize(orderId, 'cancelled');
    return {
      orderId,
      case: 'open_hold_no_engine',
      action: 'released',
      holdBefore,
      engineLive: false,
      detail: 'open+hold; engine list miss; trade.fills prove empty; remainder released once',
    };
  });
}
