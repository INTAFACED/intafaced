/**
 * Reconciling one order against the engine and the ledger.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { holdAccountOf } from '../buyback-order.js';
import { withMoneySpan } from '../../tracing.js';
import { ocoLegParent, settlementOrderId } from '../oco-legs.js';
import { HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS } from '../hold-outcome.js';
import { TradeError, type ReconcileResult } from '../types.js';
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
 * | open+hold, engine miss, proven empty fills | list miss + `trade.fills` empty + `filled_qty` 0 | first sighting: record it, hold stays; a sighting the owner's floor old with no listing since: cancel remainder |
 * | open+hold, engine miss, unknown fills | list miss + fills do not prove no fill | **fail closed** — named break, hold stays |
 * | open+engine no hold | `open` + hold 0 | **fail closed** — do not invent hold; cancel free book risk if live |
 *
 * Liveness is **list first** (`GET` engine orders). Cancel is repair, not probe
 * (W6/W7 residual: cancel-as-probe emptied the book to ask if it was live).
 * Fail closed means: never mint a hold from this path; never mark filled without fills;
 * never auto-release on funded engine-miss when `trade.fills` cannot prove no fill, and never on the first look at a
 * miss: an order the engine filled in full leaves the book at once and its fill reaches `trade.fills` later (#8560), so
 * the release waits for a miss first sighted the owner's floor ago (`finalize`'s `engineMissSighted`).
 */
export interface ReconcileOptions {
  /**
   * The operator sweep's mode: an order the engine lists as live is left exactly as it is (no cancel, no release).
   * Only an order the book no longer has is repaired, and then only when `trade.fills` prove it never filled.
   */
  readonly leaveLive?: boolean;
  /**
   * The owner's floor (TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS): an engine miss is released only once it was first
   * sighted at least this long ago with no listing since. Absent or null, an engine miss is never released here.
   */
  readonly engineMissFloorSeconds?: number | null;
  /** Who records a first sighting (`trade.operator_sweep_sightings.sweep_request_id`). */
  readonly sightedBy?: string;
}

/**
 * Release an order the engine's book does not list, only on `finalize`'s engine-miss evidence: the first look records
 * the sighting and keeps the hold; a later look, the owner's floor after it with no listing in between, releases if
 * trade.fills still show no fill. Returns why the hold stays, or null when it was released.
 */
async function releaseEngineMiss(
  svc: TradeServiceInternal,
  orderId: string,
  opts: ReconcileOptions,
  lookedAt: Date | null,
): Promise<string | null> {
  const floor = opts.engineMissFloorSeconds ?? null;
  if (floor === null || lookedAt === null) {
    return 'trade.engine_miss_unproven: TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS is not set, and an engine miss is released only after a sighting that old; hold retained';
  }
  // The sighting is when this look began, not when it ended: a submit that rests the order after the list but before
  // this insert changes the row after the look, and `finalize` then refuses the sighting (#2658). A sighting older
  // than the row's last change is replaced by this one, so the wait starts again from a look the row has not moved since.
  await svc.sql`
    INSERT INTO trade.operator_sweep_sightings (order_id, first_seen_at, sweep_request_id)
    VALUES (${orderId}, ${lookedAt}, ${opts.sightedBy ?? 'reconcile'})
    ON CONFLICT (order_id) DO UPDATE
      SET first_seen_at = EXCLUDED.first_seen_at, sweep_request_id = EXCLUDED.sweep_request_id
      WHERE trade.operator_sweep_sightings.first_seen_at
            < (SELECT o.updated_at FROM trade.orders o WHERE o.id = EXCLUDED.order_id)
  `;
  try {
    await svc.finalize(orderId, 'cancelled', undefined, { engineMissSighted: { floorSeconds: floor } });
  } catch (err) {
    if (!(err instanceof TradeError && err.code === 'trade.engine_miss_unproven')) throw err;
    return `trade.engine_miss_unproven: ${err.message}; hold retained, reconcile again after the floor`;
  }
  await svc.sql`DELETE FROM trade.operator_sweep_sightings WHERE order_id = ${orderId}`;
  return null;
}

export async function reconcileOrder(svc: TradeServiceInternal, orderId: string, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
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

    // When this look began, read before the list, so a sighting it records is never later than the miss it saw.
    const lookedAt = opts.engineMissFloorSeconds == null ? null : ((await svc.sql<Array<{ at: Date }>>`SELECT now() AS at`)[0]?.at ?? null);
    // Non-destructive liveness: list before any cancel.
    const listed = await svc.matching.listOrders(order.marketId, orderId);
    const engineLive = listed.orders.some((o) => settlementOrderId(o.orderId) === orderId);
    // Listed: whatever miss was sighted before was not continuous, so a later miss starts its wait from zero.
    if (engineLive) await svc.sql`DELETE FROM trade.operator_sweep_sightings WHERE order_id = ${orderId}`;
    if (opts.leaveLive && engineLive) {
      return {
        orderId,
        case: 'open_engine_live_left',
        action: 'none',
        holdBefore,
        engineLive: true,
        detail: 'live on the book; a sweep leaves a live order and its hold as they are',
      };
    }

    // Recovery is a lookup, not a blind resubmit. A live engine order stays
    // unresolved and encumbered. List miss still consults trade.fills before
    // any release — unknown fills are a named break, not a refund.
    if (order.status === 'recovery_required') {
      if (holdBal === 0n) {
        await svc.finalize(orderId, 'cancelled', undefined, { noEngineFill: 'no_hold' });
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
      const keptRecovery = await releaseEngineMiss(svc, orderId, opts, lookedAt);
      if (keptRecovery !== null) {
        return {
          orderId,
          case: 'open_hold_no_engine_unknown',
          action: 'fail_closed',
          holdBefore,
          engineLive: false,
          detail: `recovery-required (${order.recoveryReason ?? 'unknown'}) absent from engine; ${keptRecovery}`,
        };
      }
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
      await svc.finalize(orderId, 'cancelled', undefined, { noEngineFill: 'no_hold' });
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
        await svc.finalize(orderId, 'cancelled', undefined, { noEngineFill: 'oco_legs_settled' });
      } else {
        // The engine may have matched part of this order a moment ago with that fill not written yet (#8560). Its
        // own remainder says how much it executed; `finalize` refuses until the fills show that much, and the hold
        // stays. A cancel that took nothing off the book (it filled, or moved) is not a release either.
        const pulled = await svc.matching.cancel(order.marketId, orderId);
        if (!pulled.cancelled || !pulled.cancellation) {
          return {
            orderId,
            case: 'open_hold_no_engine_unknown',
            action: 'fail_closed',
            holdBefore,
            engineLive: true,
            detail: 'engine list showed the order live but its cancel took nothing off the book; hold retained, no refund',
          };
        }
        await svc.sql`
          UPDATE trade.orders SET engine_left_qty = ${pulled.cancellation.remainingQty}::numeric
           WHERE id = ${orderId} AND engine_left_qty IS NULL
        `;
        try {
          await svc.finalize(orderId, 'cancelled', undefined, { engineLeftQty: parseAmount(pulled.cancellation.remainingQty) });
        } catch (err) {
          if (!(err instanceof TradeError && err.code === 'trade.cancel_ahead_of_fill')) throw err;
          return {
            orderId,
            case: 'open_hold_no_engine_unknown',
            action: 'fail_closed',
            holdBefore,
            engineLive: true,
            detail: `${err.message}; hold retained until the fill settles and the engine's cancel event closes it`,
          };
        }
      }
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

    const kept = await releaseEngineMiss(svc, orderId, opts, lookedAt);
    if (kept !== null) {
      return {
        orderId,
        case: 'open_hold_no_engine_unknown',
        action: 'fail_closed',
        holdBefore,
        engineLive: false,
        detail: `open+hold; engine list miss; ${kept}`,
      };
    }
    return {
      orderId,
      case: 'open_hold_no_engine',
      action: 'released',
      holdBefore,
      engineLive: false,
      detail: 'open+hold; engine list miss sighted the floor ago with no listing since; trade.fills prove empty; remainder released once',
    };
  });
}
