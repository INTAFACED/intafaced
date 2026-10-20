/**
 * LIQUIDATION THROUGH THE BOOK (docs/adr/2026-10-20-futures-matched-traders.md section 5, phase 1 slice 7).
 *
 * While matched orders are on, a ladder rung that would liquidate a position no longer closes its tranche at the mark.
 * It becomes a rung of kind `matched`:
 *
 *   planned ── one reduce-only IOC for the tranche, every fill settled ──▶ posted ── remainder to ADL ──▶ applied
 *
 *   1. THE BOOK. `MatchedFuturesOrders.driveLiquidationBook` stores one reduce-only IOC order for the tranche (its id
 *      and client id are derived from the liquidation id and the rung id), cancels the trader's resting reduce-only
 *      orders on the position, and sends it. Its limit is the position's bankruptcy price, widened by what the insurance
 *      fund holds right now when the rung closes the whole position, and pulled in to the price band around the mark the
 *      rung was planned against. Each fill settles through the reduce-fill path: the loss goes from the margin into the
 *      clearing pot, a loss past the whole margin is drawn from the insurance fund (bounded by its live balance), and no
 *      margin is handed back until the fill that closes the position. No liquidation fee is charged (none is set; the
 *      at-mark ladder charges none either).
 *   2. THE REMAINDER. Once the engine has said how much the IOC filled and every one of those fills has settled, the rung
 *      is `posted`. What the book did not take is the position's size above the size the rung leaves behind; it goes to
 *      ADL at the bankruptcy price through the existing pairing path and its owner gate. With no ADL policy and ranking
 *      (production today) the gate refuses `trade.adl_unconfigured`, the rung is finished, and the remainder stays open
 *      and is reported exactly as a rung the insurance fund cannot cover is: `skipped_insurance_underfunded`, every tick.
 *
 * THE RUNG HOLDS THE POSITION THE WHOLE TIME, as every live rung does: other fills on it wait (`refuseIfPositionBusy`),
 * the trader cannot close, adjust or add margin, funding's race is absorbed, and new rungs are not planned. Only the
 * liquidation's own fills pass, because the order row names its rung. The ADL pairing lets the bankrupt side's own
 * matched rung through only once it is `posted` (book done, no fill pending), so a pair is never planned against a row a
 * fill has not caught up with.
 *
 * A CRASH ANYWHERE FINISHES ON THE NEXT TICK. The rung is stored before the order; the order is stored (with its limit)
 * before it is sent; each fill is an intent before it posts and replays its keys; `posted` is written only after the
 * book is settled; the remainder is read back from the position row, which nothing but this rung's fills and pairs can
 * move while it is live; an ADL pair is planned before it posts and is driven first on the next tick.
 *
 * An engine submit whose outcome is unknown is never sent again (slice 6's rule). The rung waits, reported as errored
 * with `trade.futures_submit_unknown`, until the engine's fill and cancellation events say what happened. When those
 * events carry the fill that closes the position, that fill finishes the rung in its own transaction: the closed row
 * leaves the liquidation scan, so no tick would.
 *
 * A margin adjustment finishing on the position (`margin_adjust_request`) holds the IOC back: nothing is stored or
 * sent until it has finished, and the rung waits (`in_book`, `trade.margin_adjustment_in_progress`), never fails.
 */
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { runLastResortAdlAfterInsuranceUnderfunded } from './liquidation-adl-gate.js';
import type { AdlLastResortOutcome } from './adl-last-resort.js';
import type { LiquidationRungStore, RungRecord } from './liquidation-rungs.js';
import type { LiquidationPositionRow, LiquidationTickDeps, LiquidationTickItemResult } from './liquidation-tick.js';

/** The engine took the IOC but did not say what happened: never sent again, the rung waits for the engine's events. */
export const LIQUIDATION_SUBMIT_UNKNOWN = 'trade.futures_submit_unknown' as const;
/** A live matched rung, but this process has no matched-order port to work it with. */
export const LIQUIDATION_MATCHED_UNWIRED = 'trade.liquidation_matched_unwired' as const;
/** The remainder is still being paired by ADL; the rung stays live and the next tick goes on. */
export const LIQUIDATION_ADL_CONTINUING = 'trade.liquidation_adl_continuing' as const;

/** How many ADL pairs one drive of a rung plans before it leaves the rest to the next tick. A batch size, not a limit. */
export const LIQUIDATION_ADL_PAIRS_PER_DRIVE = 16;

export interface LiquidationBookInput {
  readonly rungId: string;
  /** The lifecycle id (`liq:<positionId>`). With the rung id it names the order. */
  readonly liquidationId: string;
  readonly positionId: string;
  /** The tranche the IOC asks the book for. */
  readonly sizeClosed: Amount;
  /** The tranche is the whole position. Only then can the insurance fund widen the limit (see the header). */
  readonly closesPosition: boolean;
  /** The accepted mark the rung was planned against. The band is drawn around it, never around a fresh read. */
  readonly mark: Amount;
}

export type LiquidationBookResult =
  /** The engine has said how much the IOC filled, and every one of those fills has settled. */
  | { readonly status: 'done'; readonly orderId: string; readonly filled: Amount; readonly code: string | null }
  /** Not yet: a fill is still settling or waiting on a busy counterparty, or the submit's outcome is unknown. */
  | { readonly status: 'waiting'; readonly orderId: string; readonly code: string; readonly reason: string };

/** What the liquidation tick needs from the matched-order path. `MatchedFuturesOrders.liquidationPort` implements it. */
export interface MatchedLiquidationPort {
  /** TRADE_FUTURES_MATCHING_ENABLED. Gates NEW matched rungs only: a live one is always worked to the end. */
  readonly enabled: boolean;
  /** Why a NEW matched rung cannot be worked on this deployment (no band, no engine), or null when it can. */
  readiness(): string | null;
  /** The tranche on the market's lot grid: rounded UP (never less than the ladder asked for), capped at the position. */
  trancheFor(input: { marketId: string; positionSize: Amount; sizeClosed: Amount }): Promise<Amount>;
  /** Store, send and settle the rung's IOC. Safe to call again: everything is decided by the stored order. */
  driveBook(input: LiquidationBookInput): Promise<LiquidationBookResult>;
  /** The position's size if it is still open, else null. Read from the row the rung holds. */
  openSize(positionId: string): Promise<Amount | null>;
}

/**
 * Drive a live `matched` rung as far as it goes this tick. Never posts on its own: every post is a fill's or a pair's,
 * under their own keys.
 */
export async function driveMatchedRung(
  deps: LiquidationTickDeps,
  rungs: LiquidationRungStore,
  row: LiquidationPositionRow,
  rung: RungRecord,
): Promise<LiquidationTickItemResult> {
  const port = deps.matched;
  const label = `rung ${rung.rungId} (matched) tranche=${formatAmount(rung.plan.sizeClosed)}`;
  if (!port) {
    return {
      positionId: row.positionId,
      outcome: 'errored',
      reason: LIQUIDATION_MATCHED_UNWIRED,
      summary: `${label}: a liquidation is working in the book but this process has no matched-order port — it is not re-planned at the mark`,
    };
  }
  const target = rung.fromSize - rung.plan.sizeClosed;
  let bookNote = 'book settled earlier';

  if (rung.state === 'planned') {
    if (rung.plan.markPrice == null) {
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_rung_mark_missing',
        summary: `${label}: the rung carries no mark to draw the band around — this needs an operator`,
      };
    }
    const book = await port.driveBook({
      rungId: rung.rungId,
      liquidationId: rung.liquidationId,
      positionId: row.positionId,
      sizeClosed: rung.plan.sizeClosed,
      closesPosition: target === 0n,
      mark: rung.plan.markPrice,
    });
    if (book.status === 'waiting') {
      return {
        positionId: row.positionId,
        // An unknown submit needs the engine's events or an operator; a fill still settling only needs time.
        outcome: book.code === LIQUIDATION_SUBMIT_UNKNOWN ? 'errored' : 'in_book',
        reason: book.code,
        summary: `${label} order ${book.orderId}: ${book.reason}`,
      };
    }
    // Every fill of the IOC is in the row: from here the remainder is read from the row, and ADL may pair it.
    await rungs.markPosted(rung.rungId);
    bookNote = `book filled ${formatAmount(book.filled)}${book.code ? ` (${book.code})` : ''}`;
  }

  // While the rung is live only its own fills and pairs move the row, so the row says exactly what is left to do.
  const remainderNow = async (): Promise<Amount> => {
    const size = await port.openSize(row.positionId);
    if (size == null || size <= target) return 0n;
    return size - target;
  };
  let remainder = await remainderNow();
  const startRemainder = remainder;
  let adl: AdlLastResortOutcome | null = null;
  for (let i = 0; i < LIQUIDATION_ADL_PAIRS_PER_DRIVE && remainder > 0n; i += 1) {
    adl = await runLastResortAdlAfterInsuranceUnderfunded({
      adl: deps.adl,
      bankrupt: {
        positionId: row.positionId,
        userId: row.userId,
        marketId: row.marketId,
        side: row.side,
        // Diagnostic only. The remainder pairs at the bankruptcy price, where the insurance fund pays nothing.
        uncoveredShortfall: 0n,
        size: remainder,
      },
      at: (deps.now ?? (() => new Date()))(),
    });
    if (adl.action !== 'reduced') break;
    remainder = await remainderNow();
  }
  const adlNote = startRemainder > 0n ? `; ADL paired ${formatAmount(startRemainder - remainder)} of ${formatAmount(startRemainder)}` : '';

  if (remainder > 0n && adl?.action === 'reduced') {
    // Still pairing: the rung stays live (posted) and the next tick carries on from the row.
    return {
      positionId: row.positionId,
      outcome: 'partially_liquidated',
      reason: LIQUIDATION_ADL_CONTINUING,
      summary: `${label}: ${bookNote}${adlNote}; ${formatAmount(remainder)} left for the next tick`,
    };
  }

  await rungs.finishMatched(row.positionId, rung.rungId);
  const closed = (await port.openSize(row.positionId)) == null;
  if (closed) await deps.attempts.markDone(rung.liquidationId);

  if (remainder > 0n && adl && adl.action === 'refused') {
    // The book could not take it and ADL refuses (unconfigured, or no eligible candidate): the remainder parks open,
    // reported every tick exactly as a rung the insurance fund cannot cover. Nothing was invented for it.
    return {
      positionId: row.positionId,
      outcome: 'skipped_insurance_underfunded',
      reason: adl.code,
      summary: `${label}: ${bookNote}; the book did not take ${formatAmount(remainder)} within the insurance-widened bankruptcy price; last-resort ADL: ${adl.reason}`,
    };
  }
  return {
    positionId: row.positionId,
    outcome: closed ? 'liquidated' : 'partially_liquidated',
    reason: rung.plan.reason,
    summary: `${label}: ${bookNote}${adlNote}`,
  };
}
