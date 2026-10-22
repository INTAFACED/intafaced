/**
 * Liquidation tick (trade.futures residual).
 *
 * JOB SHAPE (not a wall-clock cron): one callable tick that:
 *  1. loads open positions
 *  2. finishes any rung already in flight for a position (stored recipes, no re-decision)
 *  3. else asks an external MarkSource for the mark (never invents)
 *  4. plans via the published ladder (never a silent full-close default)
 *  5. stores the rung, posts its ledger recipes, then moves the position row and the
 *     rung's state in one transaction (`liquidation-rungs.ts`)
 *
 * Out of scope: mark oracle product, matching engine, funding.
 *
 * THE LADDER IS THE ONLY PLANNER. A full close without a published ladder is
 * `DIRECTION` §1's failure mode, not a fallback policy. Omit `deps.ladder` and
 * the tick refuses (`trade.ladder_unset`) — it does not flatten the book.
 */
import { randomUUID } from 'node:crypto';
import {
  formatAmount,
  parseAmount,
  positionCollateralAccount,
  recipes,
  SCALE,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { type LiquidationPosition } from './liquidation-planner.js';
import { gateLiquidationRecipe } from './sub-account-loss.js';
import { planLiquidationFee } from './liquidation-fee.js';

async function postGuarded(
  ledger: Pick<LedgerClient, 'post'>,
  row: { readonly userId: string; readonly subAccountId?: string | null },
  recipe: PostRequest,
): Promise<void> {
  const gate = gateLiquidationRecipe(row, recipe);
  if (!gate.ok) {
    throw Object.assign(new Error(gate.reason), { code: gate.code });
  }
  await ledger.post(recipe);
}
import {
  DEPTH_UNKNOWN,
  FuturesLadderError,
  mayLiquidateFromExpiredMarginCallGrace,
  planLadderLiquidation,
  summarizeLadder,
  type FuturesLadderPolicy,
} from './maintenance-ladder.js';
import {
  DEFAULT_FUTURES_MARK_POLICY,
  acceptableForLiquidation,
  judgeLiquidationMark,
  type FuturesQuotedMark,
  type MarkPolicy,
  type PublishedLiquidationLimits,
} from './mark-policy.js';
import { breakerBasis, type AcceptedMarkStore } from './accepted-mark.js';
import { INSURANCE_UNDERFUNDED, checkInsuranceBound } from './insurance-bound.js';
import { parkUnderfundedWithAdl, type LiquidationAdlDeps } from './liquidation-adl-gate.js';
import { ADL_PAIR_REPLAYED } from './adl-pairing.js';
export type { LiquidationAdlDeps } from './liquidation-adl-gate.js';
import type { LiquidationRungStore, RungIdFactory, RungPlan, RungRecord } from './liquidation-rungs.js';

/**
 * WHAT A CALLER ASKS A MARK SOURCE FOR — AND WHAT THE ANSWER IS FOR.
 *
 * `marketId`, `symbol` and `at` are the question. `authorisesSize` is the STAKE:
 * the position, in base units, whose payout this mark would price. A
 * depth-backed source uses it to decide whether the book standing behind the
 * price is deep enough to stand behind that much money — see
 * `mark-from-depth.ts`, "AN ABSOLUTE FLOOR CANNOT GATE AN UNBOUNDED PAYOUT". A
 * source with no book behind it ignores it.
 *
 * OPTIONAL, AND ITS ABSENCE IS AN HONEST ANSWER rather than a weaker one: a
 * public ticker, a screen, a `markPrice()` for a chart authorises no payout at
 * all, so there is no stake to state and nothing to size a requirement against.
 * What must not happen is a payout-authorising read that omits it, and that is
 * enforced where the payout is: `PositionService` takes the size off the
 * position row it holds under `FOR UPDATE`.
 *
 * NEVER FROM A REQUEST BODY on the close path.
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md` — a price that moves money
 * is never supplied by the party it pays, and a parameter that decides which
 * prices are ACCEPTED is part of the price.
 */
export interface MarkRequest {
  marketId: string;
  symbol?: string;
  at: Date;
  /** Base units of the position whose payout this mark would authorise. */
  authorisesSize?: Amount;
}

/**
 * External mark for one market.
 *
 * `markPrice` may feed screens. **Money paths (this tick, position close/open)
 * require `quote()`** — a labelled FuturesQuotedMark. An unlabelled bare string
 * must not be stamped `quality: 'mid'` (Denon handoff §6).
 */
export interface MarkSource {
  markPrice(input: MarkRequest): Promise<string | null>;
  /**
   * LABELLED mark — price, observation time, and how it was derived.
   * Optional on the type so display adapters stay simple; the liquidation tick
   * and position money paths refuse when it is absent rather than invent mid.
   */
  quote?(input: MarkRequest): Promise<FuturesQuotedMark | null>;
}

/** A MarkSource that can say what kind of price it is handing you. */
export interface QuotedMarkSource extends MarkSource {
  quote(input: MarkRequest): Promise<FuturesQuotedMark | null>;
}

export interface LiquidationPositionRow extends LiquidationPosition {
  marketId: string;
  symbol?: string;
}

export interface LiquidationPositionLoader {
  listOpen(): Promise<readonly LiquidationPositionRow[]>;
}

/**
 * After recipes post, close the position row as liquidated.
 * Production wires PositionService; tests use a recorder.
 */
export interface PositionCloser {
  markLiquidated(positionId: string, meta: { liquidationId: string; reason: string }): Promise<void>;
  /**
   * The bus fan-out half of `markLiquidated`, for a row a RUNG already closed.
   * A rung closes the row inside its own transaction (`LiquidationRungStore.apply`),
   * so the announcement is a separate step that runs after that commit. Optional:
   * a closer with no bus has nothing to announce.
   */
  announceLiquidated?(positionId: string, meta: { liquidationId: string; reason: string }): Promise<void>;
}

/**
 * Shrink a position after a PARTIAL rung, once its recipes have posted.
 *
 * `sizeClosed` leaves the position and `marginRemaining` is what the ledger left
 * in the collateral pot after the tranche's realised loss — passed as an absolute
 * figure rather than a delta so the row cannot drift from the pot through a
 * missed or replayed call.
 *
 * THE ENTRY PRICE DOES NOT MOVE. The tranche was realised at the mark; the
 * remainder still carries the position the trader actually opened, and re-basing
 * it would silently rewrite their cost basis on the one day they are least able
 * to argue about it.
 */
export interface PositionReducer {
  /**
   * Resolves `false` when NO row moved (the row changed between the read and the
   * UPDATE, or it is no longer open). The caller must not treat that as success.
   * `void` is a legacy recorder that does not say; it is taken as applied.
   */
  reduce(
    positionId: string,
    input: { liquidationId: string; sizeClosed: Amount; marginRemaining: Amount; reason: string },
  ): Promise<boolean | void>;
}

/** The book this position would have to be closed INTO. Null → skip (never invent depth). */
export interface DepthNotionalSource {
  depthNotional(input: { marketId: string; side: 'long' | 'short'; symbol?: string }): Promise<Amount | null>;
}

/**
 * Everything the partial ladder needs, and nothing optional inside it.
 *
 * Grouped rather than spread across `LiquidationTickDeps` so the ladder cannot be
 * half-wired: a caller either supplies a depth source AND a reducer, or does not
 * use the ladder at all. A partial rung with no reducer would post a realised
 * loss and leave the position row at its original size — the ledger and the book
 * disagreeing about how big someone's position is, which is the worst available
 * outcome and precisely what an optional port would permit.
 */
export interface LiquidationLadderDeps {
  depth: DepthNotionalSource;
  reducer: PositionReducer;
  /**
   * Owner D3 table. Omitted is skip, not `DEFAULT_FUTURES_LADDER_POLICY`
   * placeholders — those numbers are not a risk opinion.
   */
  policy?: FuturesLadderPolicy;
}

/**
 * Deliver a futures margin-call notice.
 *
 * Port, so RAISING the rung and TELLING the trader stay separable facts (same
 * split as bank's `MarginCallSink`). Must return `delivered: true` only when
 * transport accepted the notice — that is the sole predicate that may start a
 * future grace clock (`mayStartMarginCallGrace` in `maintenance-ladder.ts`).
 *
 * Production wires `durableMarginCallNotifier` (store write ⇒ delivered).
 * Tests that want the pre-transport seal still use `stubMarginCallNotifier`
 * (always undelivered). An optional port that defaults to "pretend delivered"
 * would re-open C15; the tick still defaults to the stub when the dep is omitted.
 */
export interface MarginCallNotifier {
  notifyMarginCall(input: {
    positionId: string;
    userId: string;
    marketId: string;
    /** Health ratio the ladder computed (bps). Diagnostic only — not a grace key. */
    healthBps: number;
    at: Date;
  }): Promise<{ delivered: boolean }>;
}

/**
 * Honest default until real notify transport exists: never claims delivery.
 * Grace must not start; seizure must not proceed "from grace" off this.
 */
export const stubMarginCallNotifier: MarginCallNotifier = {
  async notifyMarginCall() {
    return { delivered: false };
  },
};

/**
 * THE CLAIM-BASED ATTEMPT RECORD — kept for rungs from before rung ids.
 *
 * New rungs are a state machine on `LiquidationRungStore` and do not claim; this
 * table is written (`markDone`) only after a closing rung has closed the row, and
 * a row found here on a still-open position is an old-code closing rung that must
 * not be planned again (its loss may be booked under the old key).
 *
 * Prevent double-liquidation attempts for the same position+attempt key.
 *
 * `tryClaim` must be called BEFORE any ledger post. A store that only records
 * success after posts (legacy `markDone`) leaves a multi-replica window where
 * two workers both pass `isDone`, both post under *different* minute-bucket
 * ids, and both apply a full loss. Claim-first + a stable id closes that.
 *
 * `tryClaim` returns false when another worker already owns the id (or the
 * attempt already finished). Callers must not post when false.
 */
export interface LiquidationAttemptStore {
  isDone(liquidationId: string): Promise<boolean>;
  /**
   * Atomically reserve `liquidationId` before money moves.
   * true = this worker owns the attempt; false = skip (busy or already done).
   * Implementations that only have insert-once storage treat claim as the same
   * row as done — a crash after claim and before post parks the position until
   * an operator clears the attempt row (same class as any mid-flight crash).
   * Prefer that park over a second full loss under a new id.
   */
  tryClaim(liquidationId: string): Promise<boolean>;
  markDone(liquidationId: string): Promise<void>;
}

/**
 * Stable liquidation attempt id for one open position.
 *
 * WHY NOT `liq:{positionId}:{isoMinute}`: that format minted a NEW loss id every
 * minute while a position stayed open. Crash after post / multi-replica race
 * then applied a second full `futures.loss` because ledger keys differed.
 * One position liquidates once — the key is the position, not the clock.
 */
export function defaultLiquidationId(positionId: string): string {
  return `liq:${positionId}`;
}

export interface LiquidationTickDeps {
  marks: MarkSource;
  positions: LiquidationPositionLoader;
  closer: PositionCloser;
  attempts: LiquidationAttemptStore;
  /**
   * `post` moves money; `balance` is the insurance shortfall bound — read before
   * any bankrupt rung that would credit `house:insurance-fund`. A ledger that
   * can post but cannot answer balances is not enough for the money path.
   */
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  /**
   * The rung state machine (see `liquidation-rungs.ts`). Production passes
   * `sqlLiquidationRungStore`. Omitted → the CLAIM-BASED path every rung used
   * before rung ids: plan fresh each tick, a closing rung claims `liq:{positionId}`
   * and parks on any failure. That path is kept for in-flight rungs and for unit
   * tests of the planner; it is NOT a degraded mode to ship — `startFuturesJobs`
   * always wires this.
   */
  rungs?: LiquidationRungStore;
  /** Mints rung ids. Default `crypto.randomUUID`. */
  newRungId?: RungIdFactory;
  /**
   * D-margin-07: the owner liquidation fee fraction (scaled), `null` when unset. When provided (null
   * included), each new rung records its fee decision (`feeState`, `plannedFee`) in its plan. Nothing is
   * charged: no fee recipe exists until ledger owner job J-3. Omitted: no fee decision is recorded.
   */
  liquidationFeeFraction?: Amount | null;
  /**
   * Ignored. The tick no longer full-closes through the legacy planner; a
   * published `ladder.policy` is the only maintenance table.
   */
  maintenanceBps?: number;
  now?: () => Date;
  /**
   * Build the attempt id used for ledger recipe keys and the attempt store.
   * Default: {@link defaultLiquidationId} — stable per open position for the
   * whole liquidation lifecycle (not wall-clock minutes).
   */
  liquidationIdFor?: (row: LiquidationPositionRow, at: Date) => string;
  /** Gates a labelled mark must clear before it may close a position. */
  markPolicy?: MarkPolicy;
  /**
   * Owner-published liquidation age and deviation limits.
   * `null` means none were published: the tick refuses and does not apply the
   * compiled 300 / 60 / 2000 figures. Omitted keeps `markPolicy` for callers
   * that already pass an explicit policy (unit tests). Production passes null
   * until an owner publication exists.
   */
  publishedLiquidationLimits?: PublishedLiquidationLimits | null;
  /**
   * Where the deviation breaker gets its basis, and where an accepted mark goes.
   *
   * REQUIRED, and required on purpose. This used to be
   * `previousMarkFor?: (row) => …` — optional, supplied by no production caller,
   * and therefore `null` on every tick, which is precisely the branch that skips
   * the breaker. An optional safety port is a disabled safety port. Making it
   * mandatory means a future call site that forgets it does not compile;
   * `memoryAcceptedMarkStore()` is the honest answer for a unit test, and
   * `sqlAcceptedMarkStore(sql)` for production.
   */
  acceptedMarks: AcceptedMarkStore;
  /**
   * Published ladder. Omitted → refuse (`trade.ladder_unset`). Never a silent
   * full-close default.
   */
  ladder?: LiquidationLadderDeps;
  /**
   * C15 transport for the `margin-call` rung. Defaults to
   * `stubMarginCallNotifier` (delivered=false) so a forgotten wire stays
   * honest. Production (`startFuturesJobs`) passes
   * `durableMarginCallNotifier`. Real notify must return delivered=true
   * before any future grace field may start; the tick never treats
   * margin_call as grace-expired seizure while grace is unimplemented.
   */
  notifyMarginCall?: MarginCallNotifier;
  /**
   * Last-resort ADL after insurance cannot cover a bankrupt rung.
   * Omitted / policy null → runAdlLastResort refuses `trade.adl_unconfigured`
   * and the reducer never runs. Owner maxReduceBps is never invented here.
   */
  adl?: LiquidationAdlDeps;
  /**
   * Resting orders that would grow the position. Cancelled after a liquidation
   * rung is planned and before it posts. Omitted: the tick does not invent a
   * book. A timeout leaves the rung unposted.
   */
  increasingOrders?: IncreasingOrderBook;
}

export interface RestingIncreaseOrder {
  readonly orderId: string;
  readonly side: 'buy' | 'sell';
  readonly reduceOnly?: boolean;
}

export interface IncreasingOrderBook {
  list(marketId: string, accountId: string): Promise<readonly RestingIncreaseOrder[]>;
  /** Cancel the order and release its hold. `timeout` means the book did not confirm. */
  cancelAndRelease(marketId: string, orderId: string): Promise<'released' | 'timeout'>;
}

/** A reduce-only order never increases. A long grows on a buy; a short grows on a sell. */
export function orderIncreasesPosition(
  positionSide: 'long' | 'short',
  order: { readonly side: 'buy' | 'sell'; readonly reduceOnly?: boolean },
): boolean {
  if (order.reduceOnly === true) return false;
  return positionSide === 'long' ? order.side === 'buy' : order.side === 'sell';
}

export async function cancelIncreasingOrdersBeforeRung(
  book: IncreasingOrderBook,
  row: { readonly marketId: string; readonly userId: string; readonly side: 'long' | 'short' },
): Promise<{ readonly ok: true; readonly released: readonly string[] } | { readonly ok: false; readonly reason: 'timeout' }> {
  const resting = await book.list(row.marketId, row.userId);
  const released: string[] = [];
  for (const order of resting) {
    if (!orderIncreasesPosition(row.side, order)) continue;
    const result = await book.cancelAndRelease(row.marketId, order.orderId);
    if (result === 'timeout') return { ok: false, reason: 'timeout' };
    released.push(order.orderId);
  }
  return { ok: true, released };
}

/** `skipped_already` reason: the position's latest rung is abandoned (see `LiquidationRungStore.isParked`). */
export const ABANDONED_PARKED = 'trade.liquidation_abandoned_parked';

export interface LiquidationTickItemResult {
  positionId: string;
  outcome:
    | 'skipped_no_mark'
    | 'skipped_mark_unusable'
    | 'skipped_no_depth'
    | 'skipped_d3_unset'
    | 'skipped_healthy'
    | 'skipped_already'
    | 'skipped_insurance_underfunded'
    /** A planned ADL pair touching this position was driven to applied; nothing else was decided for it this tick. */
    | 'adl_paired'
    /** The row moved (or closed) between the read that decided and the lock that would write. Nothing was posted. */
    | 'skipped_changed'
    | 'margin_call'
    | 'partially_liquidated'
    | 'liquidated'
    | 'invalid'
    /** The position's own processing threw. Its failure is reported here and never stops the others. */
    | 'errored';
  reason: string;
  summary?: string;
  /**
   * The rung applied, but its margin did not reconcile (see `RungAlert`). The item is
   * still a success; `reportLiquidationTick` raises the alert at error level.
   */
  alert?: { code: string; rungId: string; amount: string };
  /** The rung's margin release was amended down to what the pot held (`trade.liquidation_release_short`). Amount is the shortfall. */
  releaseShort?: { code: string; rungId: string; amount: string };
  /** A partial rung's loss was booked for less than planned because the pot held less (`trade.liquidation_loss_short`). Amount is the shortfall. */
  lossShort?: { code: string; rungId: string; amount: string };
  /**
   * The position row's margin and the ledger's collateral pot disagreed when this position was
   * evaluated (`trade.liquidation_margin_divergence`). The rung was planned against the SMALLER of
   * the two, so it cannot book a loss the pot does not hold. Amounts are decimal strings.
   */
  divergence?: { code: 'trade.liquidation_margin_divergence'; row: string; pot: string };
  /**
   * A CLOSING rung's loss was amended so MORE of it is drawn from the insurance fund than planned, because
   * the position's pot held less when it posted (`trade.liquidation_insurance_grown`). Amount is how much the
   * insurance leg grew. Funding, a withdrawal or a settlement took the margin first; the fund paid the
   * difference. Raised for every such amendment so the fund never pays for a pot shortfall silently.
   * Carried on the item of the drive that made the amendment (a crash after the amendment persisted and
   * before this item was returned loses the alert, but not the amended plan: `plan.fromInsurance` keeps it).
   */
  insuranceGrown?: { code: 'trade.liquidation_insurance_grown'; rungId: string; amount: string };
  /**
   * Set when `outcome === 'margin_call'`: whether the notify port accepted
   * delivery. Observable on the tick result; REST durability is the trader door.
   */
  delivered?: boolean;
}

export interface LiquidationTickResult {
  scanned: number;
  liquidated: number;
  /** Rungs that shrank a position without closing it. Not counted in `liquidated`. */
  partial: number;
  /** Positions under the margin-call threshold but not yet liquidatable. */
  marginCalls: number;
  /** Positions whose processing threw. Each has an `errored` item carrying the cause. */
  errored: number;
  /**
   * Open positions the tick skipped as `skipped_already`: an attempt/claim row
   * exists, yet the position is still open. Rungs that run through the rung store
   * write that row only once the position has closed, so on an open position it is
   * a closing rung claimed by the code that predates rung ids and parked after a
   * crash (see `LiquidationTickDeps.rungs`) — it needs an operator. Alert on it
   * staying non-zero.
   */
  parked: number;
  items: LiquidationTickItemResult[];
}

/**
 * "The source handed back something that is not a price."
 *
/**
 * Scan open positions once; liquidate those the planner says are underwater
 * given external marks only.
 */
export async function runLiquidationTick(deps: LiquidationTickDeps): Promise<LiquidationTickResult> {
  const at = (deps.now ?? (() => new Date()))();
  const open = await deps.positions.listOpen();
  const items: LiquidationTickItemResult[] = [];
  let liquidated = 0;
  let partial = 0;
  let marginCalls = 0;
  let errored = 0;

  for (const row of open) {
    /**
     * ONE POSITION'S FAILURE IS NOT THE BOOK'S.
     *
     * Positions are scanned oldest first and nothing below this line is
     * transactional across them. A throw out of one position (a refused ledger
     * post, an unreadable store) used to abort the loop, so every position
     * NEWER than the stuck one went unliquidated on every tick for as long as
     * it stayed stuck. The failure is reported on its own item and the scan
     * goes on; the stuck position is retried next tick like any other.
     */
    try {
      const liquidationId = deps.liquidationIdFor?.(row, at) ?? defaultLiquidationId(row.positionId);

      /**
       * A CLAIM ROW IS A RUNG FROM BEFORE RUNG IDS, OR A FINISHED CLOSE.
       *
       * Rungs that run through `deps.rungs` do not write `liquidation_attempts`
       * until the row has closed, so on a position that is still open this row can
       * only be a closing rung claimed by the old code. Its loss may already be
       * booked under the OLD key (`liq:{positionId}:loss`); planning a new rung
       * beside it would book the loss twice. It stays parked for an operator,
       * counted and logged every tick (`parked`).
       */
      if (await deps.attempts.isDone(liquidationId)) {
        items.push({ positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' });
        continue;
      }

      /**
       * A PLANNED ADL PAIR IS FINISHED FIRST, for the same reason as a live rung:
       * its legs may have posted and the rows not caught up (adl-pairing.ts).
       */
      if (deps.adl?.replayPlanned && (await deps.adl.replayPlanned(row.positionId))) {
        items.push({ positionId: row.positionId, outcome: 'adl_paired', reason: ADL_PAIR_REPLAYED });
        continue;
      }

      /**
       * A LIVE RUNG IS FINISHED BEFORE ANYTHING NEW IS DECIDED.
       *
       * It posted (or is posting) a loss the row has not caught up with. That is
       * owed whatever the mark, depth or policy say now — the position may have
       * recovered since, and re-deciding would skip it and leave the ledger and
       * the row disagreeing for good. So the replay runs before the mark gate and
       * needs neither a mark nor a book.
       */
      if (deps.rungs) {
        const live = await deps.rungs.findLive(row.positionId);
        if (live) {
          const item = await driveRung(deps, deps.rungs, row, live);
          items.push(item);
          if (item.outcome === 'liquidated') liquidated += 1;
          else if (item.outcome === 'partially_liquidated') partial += 1;
          else if (item.outcome === 'errored') errored += 1;
          continue;
        }

        /**
         * PARKED BEHIND AN ABANDONED RUNG.
         *
         * The latest rung booked a loss the row could not be reconciled with. A new
         * rung planned beside it would charge the same tranche again, so nothing is
         * planned until an operator has reconciled the margin and marked the rung
         * `resolved`. Counted in `parked` and logged every tick.
         */
        if (await deps.rungs.isParked(row.positionId)) {
          items.push({
            positionId: row.positionId,
            outcome: 'skipped_already',
            reason: ABANDONED_PARKED,
            summary:
              "the position's latest liquidation rung was abandoned after its loss was booked — reconcile it, then mark the rung resolved",
          });
          continue;
        }
      }

      /**
       * THE GATE, BEFORE ANYTHING IS SEIZED.
       *
       * Only a LABELLED quote enters the gate. Stamping bare `markPrice` as
       * `quality: 'mid'` used to invent a liquidation quality and set `asOf: now`,
       * disarming quality + staleness (Denon handoff §6). Missing `quote()` is
       * darkness — skip, never invent.
       *
       * ABSENT IS NOT ZERO. There is no branch below that turns a missing mark
       * into a price — on a perp, valuing a missing mark at zero does not
       * misprice one position, it liquidates every one of them.
       */
      // W4 R5: pass position size so depth-backed marks apply the relative
      // floor (authorisesSize). Omitting it re-opens the size-blind liq path
      // that close already sealed — absolute dust floor alone is not enough.
      const authorisesSize = parseAmount(row.size);
      if (!deps.marks.quote) {
        items.push({
          positionId: row.positionId,
          outcome: 'skipped_no_mark',
          reason: 'no_labelled_quote',
          summary: `${row.marketId}: mark source has no labelled quote() — refuse inventing quality from bare markPrice`,
        });
        continue;
      }
      const quoted = await deps.marks.quote({ marketId: row.marketId, symbol: row.symbol, at, authorisesSize });
      if (!quoted) {
        items.push({ positionId: row.positionId, outcome: 'skipped_no_mark', reason: 'no_mark' });
        continue;
      }

      /**
       * THE BREAKER, ARMED. `previous` is read from storage the position's owner
       * cannot reach — `trade.positions.accepted_mark`, written by this service
       * from marks it read itself. Before `accepted-mark.ts` existed this was a
       * literal `null` on every tick and the breaker never fired once.
       */
      const previous = await deps.acceptedMarks.previous(row.positionId);
      const check =
        deps.publishedLiquidationLimits !== undefined
          ? judgeLiquidationMark(quoted, breakerBasis(previous), at, deps.publishedLiquidationLimits)
          : acceptableForLiquidation(quoted, breakerBasis(previous), at, deps.markPolicy ?? DEFAULT_FUTURES_MARK_POLICY);
      if (!check.ok) {
        items.push({
          positionId: row.positionId,
          outcome: 'skipped_mark_unusable',
          reason: check.code ?? 'trade.mark_unusable',
          summary: check.reason,
        });
        continue;
      }

      /**
       * Recorded because it was ACCEPTED, not because it was acted on — a healthy
       * position's mark is still a mark this position was judged against, and it
       * is what keeps the basis walking with the market so an honest 30% day over
       * many ticks never looks like one impossible jump. A REFUSED mark is
       * deliberately not recorded: that is what stops a caller ratcheting the
       * basis along in sub-breaker steps.
       */
      await deps.acceptedMarks.record(row.positionId, { price: quoted.price, at });

      if (!deps.ladder) {
        items.push({
          positionId: row.positionId,
          outcome: 'skipped_d3_unset',
          reason: 'trade.ladder_unset',
          summary: `${row.marketId}: no published ladder — will not flatten the book as a silent default`,
        });
        continue;
      }

      const outcomeItem = await runLadderRung(deps, deps.ladder, row, quoted.price, liquidationId);
      items.push(outcomeItem);
      if (outcomeItem.outcome === 'liquidated') liquidated += 1;
      else if (outcomeItem.outcome === 'partially_liquidated') partial += 1;
      else if (outcomeItem.outcome === 'margin_call') marginCalls += 1;
      else if (outcomeItem.outcome === 'errored') errored += 1;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      items.push({
        positionId: row.positionId,
        outcome: 'errored',
        reason: typeof code === 'string' ? code : 'trade.liquidation_tick_error',
        summary: err instanceof Error ? err.message : String(err),
      });
      errored += 1;
    }
  }

  /**
   * ANNOUNCEMENTS RUN LAST, AND A DOWN BUS COSTS ONE ATTEMPT.
   *
   * A close commits in `apply`; telling the bus is a separate, slower, failure-prone
   * step (a JetStream publish waits for an ack). Doing it before or inside the scan
   * let a dead bus stall every liquidation behind it. Now the scan never waits on it,
   * and this pass stops at the first failure.
   */
  if (deps.rungs) {
    const failed = await announceMissing(deps, deps.rungs);
    if (failed) {
      items.push(failed);
      errored += 1;
    }
  }

  // Every item came off `listOpen`, so a `skipped_already` is an open position
  // that still has a claim — see `LiquidationTickResult.parked`.
  const parked = items.filter((i) => i.outcome === 'skipped_already').length;
  return { scanned: open.length, liquidated, partial, marginCalls, errored, parked, items };
}

/**
 * ONE POSITION, THROUGH THE LADDER — DECIDING A NEW RUNG.
 *
 * Split out rather than inlined because the ORDER of the steps is the whole
 * safety property, and it is easier to check when it is not buried in the scan
 * loop. A rung already in flight never reaches here: the scan loop replays it
 * first (`driveRung`).
 *
 *   1. Read the depth this position would be closed into. No depth → skip.
 *   2. Plan. A refusal or a healthy rung → skip, and nothing posts.
 *   3. Check the insurance bound for the shortfall leg.
 *   4. `rungs.begin`: under a row lock, confirm the row is still the one steps 1–3
 *      read, and persist the rung as 'planned'. Two replicas converge on one rung.
 *   5. `driveRung`: post its recipes, then move the row and mark the rung
 *      'applied' in one transaction.
 *
 * The row moves LAST: the reverse order would shrink a position whose loss never
 * posted. A crash anywhere between 4 and 5 leaves a live rung, and the next tick
 * replays the stored bodies (the ledger moves nothing twice) until the row
 * catches up.
 *
 * Without `deps.rungs` the claim-based path below runs instead (see
 * `LiquidationTickDeps.rungs`).
 */
async function runLadderRung(
  deps: LiquidationTickDeps,
  ladder: LiquidationLadderDeps,
  row: LiquidationPositionRow,
  markPrice: Amount,
  liquidationId: string,
): Promise<LiquidationTickItemResult> {
  if (ladder.policy == null) {
    return {
      positionId: row.positionId,
      outcome: 'skipped_d3_unset',
      reason: 'trade.ladder_d3_unset',
      summary: `${row.marketId}: D3 ladder numbers are owner-unset — will not rate or seize on placeholder rungs`,
    };
  }

  let depthNotional: Amount | null;
  try {
    depthNotional = await ladder.depth.depthNotional({ marketId: row.marketId, side: row.side, symbol: row.symbol });
  } catch {
    depthNotional = null;
  }

  if (depthNotional == null || depthNotional <= 0n) {
    /**
     * A BOOK WE COULD NOT READ IS NOT A DEEP BOOK.
     *
     * The maintenance requirement is keyed on depth, so an unreadable side has no
     * requirement — and the only honest answers are "assume the worst tier" or
     * "do not act". Assuming the worst tier would liquidate every position on the
     * venue the moment a depth call failed, which is the missing-mark mistake
     * wearing a different hat. The position sits and an operator looks at it.
     */
    return {
      positionId: row.positionId,
      outcome: 'skipped_no_depth',
      reason: DEPTH_UNKNOWN,
      summary: `${row.marketId}: no readable ${row.side === 'long' ? 'bid' : 'ask'} depth to rate this position against`,
    };
  }

  /**
   * THE LEDGER POT IS WHAT A LOSS CAN BE TAKEN FROM — NOT THE ROW'S IDEA OF IT.
   *
   * `trade.positions.margin_current` is a mirror; the position's collateral pot in the ledger is the
   * truth. They diverge when a crash lands between a ledger release and the row update (pot below
   * row), or when a row was hand-edited. Planning against a row margin the pot does not hold has two
   * bad outcomes: a PHANTOM-MARGIN PARTIAL (the position looks solvent and a tranche is booked
   * against margin that is not there, so the shortfall lands on the house) and a loss the ledger
   * refuses at post time. So the plan uses `min(row, pot)`, and any difference is raised as
   * `trade.liquidation_margin_divergence` for an operator (runbook section 3).
   *
   * Read only here, after the cheap skips above (no policy, no depth): a deployment with no ladder
   * numbers makes no ledger call per position. The rung's compare-and-set (`begin`) still compares the
   * ROW snapshot, so a divergent position cannot create a rung that errors every tick: the plan is
   * always payable from the pot, and `begin` is checked against the same row the plan was taken from.
   */
  const pot = (await deps.ledger.balance(positionCollateralAccount(row.userId, row.marginAsset, row.positionId))).amount;
  const planRow: LiquidationPositionRow = pot < row.margin ? { ...row, margin: pot < 0n ? 0n : pot } : row;
  const item = await planAndDrive(deps, ladder, row, planRow, ladder.policy, depthNotional, markPrice, liquidationId);
  return pot === row.margin
    ? item
    : { ...item, divergence: { code: 'trade.liquidation_margin_divergence', row: formatAmount(row.margin), pot: formatAmount(pot) } };
}

/**
 * The deciding half of `runLadderRung`: plan against `planRow` (the row, its margin capped at what
 * the ledger pot holds), then store and drive the rung. `row` is the snapshot the rung's
 * compare-and-set is taken against; `planRow` differs from it only in `margin`.
 */
async function planAndDrive(
  deps: LiquidationTickDeps,
  ladder: LiquidationLadderDeps,
  row: LiquidationPositionRow,
  planRow: LiquidationPositionRow,
  policy: FuturesLadderPolicy,
  depthNotional: Amount,
  markPrice: Amount,
  liquidationId: string,
): Promise<LiquidationTickItemResult> {
  // Minted per decision, BEFORE planning, so every key the plan produces carries it.
  const rungId = deps.rungs ? (deps.newRungId ?? randomUUID)() : undefined;

  let decision;
  try {
    decision = planLadderLiquidation({
      liquidationId,
      position: planRow,
      markPrice,
      depthNotional,
      policy,
      ...(rungId !== undefined ? { rungId } : {}),
    });
  } catch (err) {
    // An incoherent policy is an operator problem on every position, not a market
    // event on this one — surfaced per position so it cannot be scrolled past.
    const code = err instanceof FuturesLadderError ? err.code : 'trade.ladder_failed';
    return { positionId: row.positionId, outcome: 'invalid', reason: code, summary: (err as Error).message };
  }

  if (!decision.liquidate) {
    if (decision.rung.action === 'margin-call') {
      /**
       * C15 — MARGIN CALL, NOT SEIZURE.
       *
       * Report the rung, attempt delivery, and STOP. Grace is not implemented
       * on futures (no graceExpiresAt on the position); inventing a timer here
       * would be D3. The seal `mayLiquidateFromExpiredMarginCallGrace` is the
       * only lawful future path from "called" to "seize after grace", and with
       * undelivered notice + null grace it always refuses. If a later change
       * wrongly treats margin_call as grace-expired without delivery, that
       * helper (and its tests) fail closed — do not liquidate from this branch.
       */
      const at = (deps.now ?? (() => new Date()))();
      const notifier = deps.notifyMarginCall ?? stubMarginCallNotifier;
      const delivery = await notifier.notifyMarginCall({
        positionId: row.positionId,
        userId: row.userId,
        marketId: row.marketId,
        healthBps: decision.rung.healthBps,
        at,
      });
      // graceExpiresAt: null — no durable grace clock on futures today.
      // Undelivered or no clock → never seize "from grace".
      const seizeFromGrace = mayLiquidateFromExpiredMarginCallGrace({
        delivered: delivery.delivered,
        graceExpiresAt: null,
        now: at,
      });
      if (seizeFromGrace) {
        // Unreachable while graceExpiresAt is always null. Fail closed if a
        // future edit breaks the seal without wiring real escalate-after-grace.
        return {
          positionId: row.positionId,
          outcome: 'margin_call',
          reason: 'margin_call_grace_not_wired',
          summary: `${summarizeLadder(decision)}; refused seize-from-grace without durable grace state`,
        };
      }
      return {
        positionId: row.positionId,
        outcome: 'margin_call',
        reason: decision.reason,
        summary: summarizeLadder(decision),
        delivered: delivery.delivered,
      };
    }

    const outcome =
      decision.rung.action === 'refuse' &&
      (decision.reason === 'invalid_mark' || decision.reason === 'empty_position' || decision.reason === 'invalid_margin')
        ? 'invalid'
        : decision.rung.action === 'refuse'
          ? 'invalid'
          : 'skipped_healthy';
    return { positionId: row.positionId, outcome, reason: decision.reason, summary: summarizeLadder(decision) };
  }

  if (deps.increasingOrders) {
    const pulled = await cancelIncreasingOrdersBeforeRung(deps.increasingOrders, row);
    if (!pulled.ok) {
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_increasing_cancel_timeout',
        summary: `${row.marketId}: a resting order that increases the position did not cancel; the rung was not posted`,
      };
    }
  }

  /**
   * Same insurance bound as the full-close path — bankrupt ladder rungs are the
   * case that invents cover when the fund is empty. Partial rungs with
   * `fromInsurance === 0` pass through without a balance read cost that matters.
   */
  const insurance = await checkInsuranceBound({
    assetId: row.marginAsset,
    fromInsurance: decision.fromInsurance,
    balance: (ref) => deps.ledger.balance(ref),
  });
  if (!insurance.ok) {
    return parkUnderfundedWithAdl({
      adl: deps.adl,
      row,
      fromInsurance: decision.fromInsurance,
      insuranceReason: insurance.reason ?? INSURANCE_UNDERFUNDED,
      at: (deps.now ?? (() => new Date()))(),
    });
  }

  if (deps.rungs && rungId !== undefined) {
    const begun = await deps.rungs.begin({
      rungId,
      positionId: row.positionId,
      liquidationId,
      kind: decision.closesPosition ? 'closing' : 'partial',
      fromSize: row.size,
      fromMargin: row.margin,
      plan: {
        recipes: decision.recipes as PostRequest[],
        sizeClosed: decision.sizeClosed,
        marginRemaining: decision.marginRemaining,
        marginTaken: decision.fromMargin,
        releaseShort: 0n,
        lossShort: 0n,
        reason: decision.reason,
        fromInsurance: decision.fromInsurance,
        marginAsset: row.marginAsset,
        ...rungFeeDecision(deps.liquidationFeeFraction, rungId, decision.sizeClosed, markPrice, feeLeftoverCollateral(decision)),
      },
    });
    if (begun.status === 'changed') {
      return {
        positionId: row.positionId,
        outcome: 'skipped_changed',
        reason: 'trade.liquidation_row_changed_before_plan',
        summary: `${row.marketId}: the position moved (or closed) since it was read; nothing was posted — the next tick reads it again`,
      };
    }
    // 'live': another worker planned this position first. Its rung wins and is
    // replayed as stored; what this tick computed is discarded.
    return driveRung(deps, deps.rungs, row, begun.rung);
  }

  /**
   * CLAIM-BASED PATH (no `deps.rungs`).
   *
   * Closing rungs claim the lifecycle id so a second worker cannot full-close
   * twice. Partial rungs deliberately do NOT claim `liq:{positionId}` — the
   * position stays open for the next rung, and recipe keys already include the
   * closed size so two partials do not share a ledger id.
   *
   * A claim that outlives its worker parks the position here until an operator
   * clears it. The tick counts these (`parked`) and `startFuturesJobs` logs each
   * one every tick, so the park is a signal and not a silence.
   */
  if (decision.closesPosition) {
    if (!(await deps.attempts.tryClaim(liquidationId))) {
      return { positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' };
    }
  }

  for (const recipe of decision.recipes) {
    await postGuarded(deps.ledger, row, recipe as PostRequest);
  }

  if (decision.closesPosition) {
    await deps.closer.markLiquidated(row.positionId, { liquidationId, reason: decision.reason });
    await deps.attempts.markDone(liquidationId);
  } else {
    const moved = await ladder.reducer.reduce(row.positionId, {
      liquidationId,
      sizeClosed: decision.sizeClosed,
      marginRemaining: decision.marginRemaining,
      reason: decision.reason,
    });
    if (moved === false) {
      // The loss is booked and no row moved. Reporting success here is how a row
      // ends up claiming more margin than the ledger holds.
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_row_changed_after_post',
        summary: `${row.marketId}: the partial rung's loss is booked but the position row did not move (it changed since it was read)`,
      };
    }
  }

  return {
    positionId: row.positionId,
    outcome: decision.closesPosition ? 'liquidated' : 'partially_liquidated',
    reason: decision.reason,
    summary: summarizeLadder(decision),
  };
}

/**
 * ADVANCE ONE STORED RUNG TO THE END — for a fresh rung and for a replay alike.
 *
 *   planned ─ post every recipe ─▶ posted ─ apply (row + state, one tx) ─▶ applied
 *
 * A replay is NOT a decision: it does not look at health, depth or the mark. The
 * rung committed to its recipes and to the figures in them, and that is what this
 * finishes. Posting is idempotent on the stored keys, so a recipe that is already
 * booked returns its old transaction. The ledger is also the only judge of whether
 * a recipe that is NOT yet booked is affordable:
 *
 *   · INSURANCE. If the ledger refuses a rung's insurance leg for insufficient
 *     funds, the fund drained since the rung was planned. The tick reports
 *     `trade.liquidation_insurance_underfunded_on_replay` (with the last-resort ADL
 *     answer), and the rung stays live — loud on every tick — until the fund is
 *     back. There is deliberately NO lookup of "is this key booked" first: the
 *     production ledger client cannot answer one (it throws), and a guess would
 *     either wedge a rung that is fine or wave through one that is not.
 *   · THE ROW. `apply` takes the row lock and moves the row by the rung's DELTA
 *     (see `liquidation-rungs.ts`). Only a row that cannot be reconciled with the
 *     booked loss abandons the rung — `trade.liquidation_row_changed_after_post`,
 *     and the position is parked until an operator resolves it.
 *
 * A closing rung that throws anywhere here is simply replayed next tick; there is
 * no claim to park behind. `liquidation_attempts` is written (`markDone`) only
 * after the row has closed, for the benefit of everything that still reads it.
 */
async function driveRung(
  deps: LiquidationTickDeps,
  rungs: LiquidationRungStore,
  row: LiquidationPositionRow,
  rung: RungRecord,
  depth = 0,
): Promise<LiquidationTickItemResult> {
  const { plan } = rung;
  const closing = rung.kind === 'closing';
  const outcome = closing ? ('liquidated' as const) : ('partially_liquidated' as const);
  const label = `rung ${rung.rungId} (${rung.kind}) close=${formatAmount(plan.sizeClosed)} marginTaken=${formatAmount(plan.marginTaken)}`;

  let releaseShort = plan.releaseShort;
  let lossShort = plan.lossShort;
  let insuranceGrown = 0n;

  if (rung.state === 'planned') {
    let current: RungPlan = plan;
    let version = rung.planVersion;
    /** Persist an amended plan BEFORE it posts. Null: somebody else amended first — the caller re-reads. */
    const amend = async (next: RungPlan): Promise<boolean> => {
      const v = await rungs.amendPlan(rung.rungId, next, version);
      if (v === null) return false;
      version = v;
      current = next;
      return true;
    };
    /** Lost the compare-and-set: take what the winner stored and post THAT. */
    const rereadAndDrive = async (): Promise<LiquidationTickItemResult> => {
      const fresh = await rungs.findLive(row.positionId);
      if (!fresh || depth >= 3) throw new Error(`rung ${rung.rungId} changed under a concurrent amendment — replayed next tick`);
      return driveRung(deps, rungs, row, fresh, depth + 1);
    };
    const replace = (key: string, recipe: PostRequest | null): PostRequest[] => {
      const legs = current.recipes; // named local: the live-path scanner reads `recipes.<name>` as a recipe-book call
      return legs.flatMap((r) => (r.idempotencyKey !== key ? [r] : recipe ? [recipe] : []));
    };
    const underfundedItem = async (fromInsurance: Amount, why: string): Promise<LiquidationTickItemResult> => {
      const parked = await parkUnderfundedWithAdl({
        adl: deps.adl,
        row,
        fromInsurance,
        insuranceReason: INSURANCE_UNDERFUNDED,
        at: (deps.now ?? (() => new Date()))(),
      });
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_insurance_underfunded_on_replay',
        summary: `${label}: ${why} ${formatAmount(fromInsurance)} — rung stays live and is retried every tick (${parked.summary})`,
      };
    };

    for (const stored of plan.recipes) {
      try {
        await postGuarded(deps.ledger, row, stored);
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== 'ledger.insufficient_funds') throw err;
        // WHICH ACCOUNT IS SHORT? The ledger's refusal is not reliable about it over HTTP
        // (`accountId` arrives as 'unknown' or a ledger uuid, not an account ref), so the
        // balances are read instead.
        const potEntry = stored.entries.find((e) => e.direction === 'credit' && e.account.kind === 'collateral');

        if (stored.reason === 'futures.margin.release' && potEntry) {
          /**
           * THE RELEASE CAME UP SHORT — AMEND IT, NEVER LEAVE THE POSITION OPEN.
           *
           * The loss is booked (it posted first). The release returns the margin the loss
           * did not consume, as planned from the row; if the pot holds less now (funding
           * or a margin withdrawal took some before the release posted) the ledger refuses
           * it and, unamended, the rung would error every tick with the row still open and
           * tradable after its loss was booked. So: read the pot, release what it holds
           * under the SAME key (a refused post leaves nothing booked, so a different body
           * is not a key reuse), skip the release when the pot is empty, and persist the
           * amended plan BEFORE posting so a replay posts the same body.
           */
          const pot = (await deps.ledger.balance(potEntry.account)).amount;
          if (pot >= potEntry.amount) throw err; // the pot is not short: this refusal is something else
          const amended = pot > 0n ? pot : 0n;
          const recipe: PostRequest | null =
            amended > 0n ? { ...stored, entries: stored.entries.map((e) => ({ ...e, amount: amended })) } : null;
          releaseShort += potEntry.amount - amended;
          if (!(await amend({ ...current, recipes: replace(stored.idempotencyKey, recipe), releaseShort }))) return rereadAndDrive();
          if (recipe) await postGuarded(deps.ledger, row, recipe);
        } else if (
          stored.reason === 'futures.loss.realized' &&
          potEntry &&
          (await deps.ledger.balance(potEntry.account)).amount < potEntry.amount
        ) {
          /**
           * THE LOSS CAME UP SHORT — THE POT SHRANK AFTER PLANNING.
           *
           * Funding (or a withdrawal) left the position's pot holding less than the loss's
           * pot leg, so the ledger refuses the whole loss. The loss key was never booked, so
           * a different body is safe.
           *   · CLOSING rung: the pot leg becomes what the pot holds and the difference moves
           *     to the INSURANCE leg — the position is liquidated either way, and insurance
           *     is what covers loss beyond the margin. Only if insurance cannot cover the
           *     grown leg is it a genuine shortfall (the ADL park path).
           *   · PARTIAL rung: the pot leg becomes what the pot holds and the under-booked loss
           *     is recorded (`lossShort`, alert `trade.liquidation_loss_short`); the row is
           *     reduced by the margin actually taken.
           */
          const pot = (await deps.ledger.balance(potEntry.account)).amount;
          const potLegNow = pot > 0n ? pot : 0n;
          const shift = potEntry.amount - potLegNow;
          const lossId = stored.idempotencyKey.slice('futures.loss:'.length);
          let recipe: PostRequest | null;
          let next: RungPlan;
          if (closing) {
            const fromInsurance = current.fromInsurance + shift;
            const bound = await checkInsuranceBound({
              assetId: plan.marginAsset,
              fromInsurance,
              balance: (ref) => deps.ledger.balance(ref),
            });
            if (!bound.ok)
              return underfundedItem(fromInsurance, 'the position pot shrank and the insurance fund cannot cover the grown leg of');
            recipe = recipes.futuresRealizeLoss({
              positionId: row.positionId,
              userId: row.userId,
              assetId: plan.marginAsset,
              fromMargin: potLegNow,
              fromInsurance,
              lossId,
            });
            next = { ...current, recipes: replace(stored.idempotencyKey, recipe), fromInsurance, marginTaken: potLegNow };
          } else {
            recipe =
              potLegNow > 0n
                ? recipes.futuresRealizeLoss({
                    positionId: row.positionId,
                    userId: row.userId,
                    assetId: plan.marginAsset,
                    fromMargin: potLegNow,
                    fromInsurance: 0n,
                    lossId,
                  })
                : null;
            // `current.fromInsurance` is 0 on every partial rung planned today; it is added so that a
            // partial rung that ever carries an insurance leg cannot leave the plan claiming a leg the
            // re-amended recipe (pot only) no longer posts.
            lossShort += shift + current.fromInsurance;
            next = {
              ...current,
              recipes: replace(stored.idempotencyKey, recipe),
              marginTaken: potLegNow,
              fromInsurance: 0n,
              lossShort,
            };
          }
          if (!(await amend(next))) return rereadAndDrive();
          if (closing) insuranceGrown += shift; // the amendment is persisted: the fund now pays `shift` more than planned
          if (recipe) await postGuarded(deps.ledger, row, recipe);
        } else if (current.fromInsurance > 0n) {
          // The pot holds what the recipe needs, so a refusal on a rung that draws on insurance is
          // the insurance fund — but only if the fund is actually below the leg. Otherwise it is
          // something else, and telling the operator to top up insurance (or letting ADL deleverage
          // others) would be wrong. `current`, not `plan`: an amendment earlier in this loop (the
          // pot shrank and the leg grew) is what is posted, so it is what must be checked.
          const bound = await checkInsuranceBound({
            assetId: plan.marginAsset,
            fromInsurance: current.fromInsurance,
            balance: (ref) => deps.ledger.balance(ref),
          });
          if (bound.ok) throw err;
          if (closing || stored.reason !== 'futures.loss.realized') {
            // CLOSING rung: insurance is the only cover for a bankrupt close — stay live, loud, ADL answer.
            return underfundedItem(current.fromInsurance, 'the ledger refused the insurance leg of');
          }
          /**
           * A PARTIAL rung whose insurance leg is refused does NOT park, and does not go to ADL.
           *
           * Parking a still-open leveraged position over a small gap leaves risk on the book to save a
           * bookkeeping entry. The loss re-amends to what the pot holds (same key: the refused post booked
           * nothing, so a different body is not a key reuse), the gap is recorded as `lossShort` and
           * paged, and the rung applies. The remainder of the position is bankrupt and is taken by the
           * closing-rung path on the next evaluation. REACHABLE ONLY ONCE A PARTIAL RUNG CAN CARRY AN
           * INSURANCE LEG (phase 2 of `docs/adr/2026-10-14-liquidation-shortfall-insurance-leg.md`):
           * today `planLadderLiquidation` plans a partial rung only while equity > 0, so its
           * `fromInsurance` is 0 and this branch is not entered.
           */
          const gap = current.fromInsurance;
          const lossId = stored.idempotencyKey.slice('futures.loss:'.length);
          const marginLeg = potEntry?.amount ?? 0n;
          const recipe: PostRequest | null =
            marginLeg > 0n
              ? recipes.futuresRealizeLoss({
                  positionId: row.positionId,
                  userId: row.userId,
                  assetId: plan.marginAsset,
                  fromMargin: marginLeg,
                  fromInsurance: 0n,
                  lossId,
                })
              : null;
          lossShort += gap;
          if (!(await amend({ ...current, recipes: replace(stored.idempotencyKey, recipe), fromInsurance: 0n, lossShort }))) {
            return rereadAndDrive();
          }
          if (recipe) await postGuarded(deps.ledger, row, recipe);
        } else {
          throw err;
        }
      }
    }
    await rungs.markPosted(rung.rungId);
  }

  const applied = await rungs.apply(row.positionId, rung.rungId);
  switch (applied.status) {
    case 'applied':
    case 'already_applied': {
      // The announcement is NOT made here: it is the after-scan pass's job
      // (`announceMissing`), so a slow or dead bus never delays a rung.
      if (closing) await deps.attempts.markDone(rung.liquidationId);
      const alert = applied.status === 'applied' ? applied.alert : undefined;
      return {
        positionId: row.positionId,
        outcome,
        reason: plan.reason,
        summary: `${label} ${applied.status === 'applied' ? 'applied' : 'already applied'}${alert ? ` — ${alert.code} ${formatAmount(alert.amount)}` : ''}`,
        ...(alert ? { alert: { code: alert.code, rungId: rung.rungId, amount: formatAmount(alert.amount) } } : {}),
        ...(lossShort > 0n && applied.status === 'applied'
          ? { lossShort: { code: 'trade.liquidation_loss_short', rungId: rung.rungId, amount: formatAmount(lossShort) } }
          : {}),
        ...(insuranceGrown > 0n && applied.status === 'applied'
          ? {
              insuranceGrown: {
                code: 'trade.liquidation_insurance_grown' as const,
                rungId: rung.rungId,
                amount: formatAmount(insuranceGrown),
              },
            }
          : {}),
        ...(releaseShort > 0n && applied.status === 'applied'
          ? { releaseShort: { code: 'trade.liquidation_release_short', rungId: rung.rungId, amount: formatAmount(releaseShort) } }
          : {}),
      };
    }
    case 'abandoned':
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_row_changed_after_post',
        summary: `${label}: the position row cannot be reconciled with the booked loss (${applied.reason}) — rung abandoned and the position parked; operator must reconcile, then mark the rung resolved`,
      };
    case 'not_live':
      return {
        positionId: row.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_rung_not_live',
        summary: `${label}: the rung was abandoned before it could apply`,
      };
  }
}

/**
 * Publish a closed rung's `positionUpdated`, then record that it went out.
 *
 * AT-LEAST-ONCE. The row closed in `apply`'s transaction; the bus is a separate
 * system, so a crash between the two used to lose the event for good. Now the rung
 * row says whether the announcement is recorded (`announced_at`), and every tick's
 * last pass (`announceMissing`) publishes the applied closing rungs that are not.
 * The publish key `trade.position.liquidated:{id}:{liquidationId}` makes a repeat
 * harmless.
 */
async function announceRung(deps: LiquidationTickDeps, rungs: LiquidationRungStore, rung: RungRecord): Promise<void> {
  await deps.closer.announceLiquidated?.(rung.positionId, { liquidationId: rung.liquidationId, reason: rung.plan.reason });
  await rungs.markAnnounced(rung.rungId);
}

/**
 * Publish the closes that have not been announced — oldest first, and STOPPING AT THE
 * FIRST FAILURE: a bus that is down fails every publish and each one can wait for an
 * ack, so trying fifty of them would turn one outage into minutes of stall per tick.
 * Returns the single errored item, or null.
 */
async function announceMissing(deps: LiquidationTickDeps, rungs: LiquidationRungStore): Promise<LiquidationTickItemResult | null> {
  let pending: RungRecord[];
  try {
    pending = await rungs.listUnannounced(50);
  } catch (err) {
    return {
      positionId: 'announce-scan',
      outcome: 'errored',
      reason: 'trade.liquidation_announce_failed',
      summary: `could not list unannounced liquidations (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  for (const rung of pending) {
    try {
      await announceRung(deps, rungs, rung);
    } catch (err) {
      return {
        positionId: rung.positionId,
        outcome: 'errored',
        reason: 'trade.liquidation_announce_failed',
        summary: `rung ${rung.rungId}: the liquidation closed the position but its announcement did not publish (${err instanceof Error ? err.message : String(err)}) — retried next tick, ${pending.length} unannounced`,
      };
    }
  }
  return null;
}

export function memoryLiquidationAttemptStore(): LiquidationAttemptStore {
  const done = new Set<string>();
  return {
    async isDone(id) {
      return done.has(id);
    },
    async tryClaim(id) {
      if (done.has(id)) return false;
      done.add(id);
      return true;
    },
    async markDone(id) {
      done.add(id);
    },
  };
}

/**
 * D-margin-07: collateral left after the rung's loss. A closing rung hands it back as `residualRelease`
 * (its `marginRemaining` is 0); a partial rung keeps it as `marginRemaining` (its `residualRelease` is 0).
 */
export function feeLeftoverCollateral(decision: { marginRemaining: Amount; residualRelease: Amount }): Amount {
  return decision.marginRemaining + decision.residualRelease;
}

/**
 * D-margin-07: the fee decision a new rung records. Charges nothing (no recipe until J-3); the plan's
 * recipes are unchanged. `undefined` fraction (not wired) records nothing.
 */
export function rungFeeDecision(
  fraction: Amount | null | undefined,
  rungId: string,
  sizeClosed: Amount,
  markPrice: Amount,
  leftoverCollateral: Amount,
): { feeState?: 'fee_unset' | 'ledger_job_pending'; plannedFee?: Amount } {
  if (fraction === undefined) return {};
  const plan = planLiquidationFee({
    rungId,
    fraction,
    notionalClosed: (sizeClosed * markPrice) / SCALE,
    leftoverCollateral,
  });
  return plan.state === 'planned' ? { feeState: plan.chargeState, plannedFee: plan.fee } : { feeState: plan.state };
}
