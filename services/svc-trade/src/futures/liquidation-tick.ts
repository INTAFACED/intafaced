/**
 * Liquidation tick (trade.futures residual).
 *
 * JOB SHAPE (not a wall-clock cron): one callable tick that:
 *  1. loads open positions
 *  2. asks an external MarkSource for each mark (never invents)
 *  3. plans via the published ladder (never a silent full-close default)
 *  4. posts ledger recipes + marks position liquidated (via PositionCloser)
 *
 * Out of scope: mark oracle product, matching engine, funding.
 *
 * THE LADDER IS THE ONLY PLANNER. A full close without a published ladder is
 * `DIRECTION` §1's failure mode, not a fallback policy. Omit `deps.ladder` and
 * the tick refuses (`trade.ladder_unset`) — it does not flatten the book.
 */
import { formatAmount, parseAmount, type Amount, type EntryInput, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { type LiquidationPosition } from './liquidation-planner.js';
import {
  DEPTH_UNKNOWN,
  FuturesLadderError,
  mayLiquidateFromExpiredMarginCallGrace,
  planLadderLiquidation,
  summarizeLadder,
  type FuturesLadderPolicy,
} from './maintenance-ladder.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForLiquidation, type FuturesQuotedMark, type MarkPolicy } from './mark-policy.js';
import { breakerBasis, type AcceptedMarkStore } from './accepted-mark.js';
import { INSURANCE_UNDERFUNDED, checkInsuranceBound } from './insurance-bound.js';
import { parkUnderfundedWithAdl, type LiquidationAdlDeps } from './liquidation-adl-gate.js';
export type { LiquidationAdlDeps } from './liquidation-adl-gate.js';

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
  reduce(
    positionId: string,
    input: {
      liquidationId: string;
      sizeClosed: Amount;
      marginRemaining: Amount;
      reason: string;
      /**
       * The size the plan was made against. When given, the reduction applies only to a row still at exactly this
       * size, so two workers replaying one stored plan shrink the position once, not twice.
       */
      expectedSize?: Amount;
    },
  ): Promise<void>;
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
  /**
   * The UNFINISHED rung plan persisted under `rungKey`, or null — a completed
   * plan is history and is never handed back. OPTIONAL, and the three plan
   * methods are a set: a store implements all of them or none.
   *
   * WHY A STORED PLAN. The ledger dedupes on the recipe key, and the key does
   * not carry the amounts. A rung that posted and then crashed before the row
   * moved gets re-planned on the next tick from the LIVE mark: same key, new
   * fromMargin / fromInsurance. Depending on the ledger that is either a
   * silent return of the old tx (the row then moves by the NEW margin, which
   * is not what was booked) or a refused post. Persisting the plan before the
   * first post and re-posting THAT on every replay makes the key and the
   * amounts one fact again.
   */
  loadPlan?(rungKey: string): Promise<StoredRungPlan | null>;
  /**
   * Insert, then return whichever plan is now live under `rungKey`, so two
   * workers racing to plan the same rung agree on one set of amounts. An
   * UNFINISHED row wins and is returned as it stands; a COMPLETED row is
   * replaced by `plan` — the position row has since moved on, and a rung that
   * comes round again at the same size is a new rung.
   */
  savePlan?(rungKey: string, plan: StoredRungPlan): Promise<StoredRungPlan>;
  /**
   * The row has moved by the plan: retire it so it can never be replayed. Called
   * after `reduce` / `markLiquidated` succeeds and before anything is done.
   */
  completePlan?(rungKey: string): Promise<void>;
}

/**
 * What one rung committed to, fixed before its first post.
 *
 * `recipes` are exactly what posts (idempotency keys included); `sizeClosed`,
 * `marginRemaining` and `reason` are what the position row is moved by after
 * they post. All three come from the plan, never from a re-plan.
 */
export interface StoredRungPlan {
  recipes: PostRequest[];
  sizeClosed: Amount;
  marginRemaining: Amount;
  reason: string;
  closesPosition: boolean;
}

/** {@link StoredRungPlan} as it sits in jsonb: every amount a decimal string, because JSON cannot hold a bigint. */
export interface EncodedRungPlan {
  recipes: (Omit<PostRequest, 'entries'> & {
    entries: { account: EntryInput['account']; direction: EntryInput['direction']; amount: string }[];
  })[];
  sizeClosed: string;
  marginRemaining: string;
  reason: string;
  closesPosition: boolean;
}

export function encodeRungPlan(plan: StoredRungPlan): EncodedRungPlan {
  return {
    recipes: plan.recipes.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
    })),
    sizeClosed: formatAmount(plan.sizeClosed),
    marginRemaining: formatAmount(plan.marginRemaining),
    reason: plan.reason,
    closesPosition: plan.closesPosition,
  };
}

export function decodeRungPlan(encoded: EncodedRungPlan): StoredRungPlan {
  return {
    recipes: encoded.recipes.map((r) => ({
      ...r,
      entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: parseAmount(e.amount) })),
    })),
    sizeClosed: parseAmount(encoded.sizeClosed),
    marginRemaining: parseAmount(encoded.marginRemaining),
    reason: encoded.reason,
    closesPosition: encoded.closesPosition,
  };
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
}

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
    | 'margin_call'
    | 'partially_liquidated'
    | 'liquidated'
    | 'invalid'
    /** The position's own processing threw. Its failure is reported here and never stops the others. */
    | 'errored';
  reason: string;
  summary?: string;
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

      if (await deps.attempts.isDone(liquidationId)) {
        items.push({ positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' });
        continue;
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
      const check = acceptableForLiquidation(quoted, breakerBasis(previous), at, deps.markPolicy ?? DEFAULT_FUTURES_MARK_POLICY);
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

  return { scanned: open.length, liquidated, partial, marginCalls, errored, items };
}

/**
 * ONE POSITION, THROUGH THE LADDER.
 *
 * Split out rather than inlined because the ORDER of the four steps below is the
 * whole safety property, and it is easier to check when it is not buried in the
 * scan loop.
 *
 *   1. Read the depth this position would be closed into. No depth → skip.
 *   2. Plan. A refusal or a healthy rung → skip, and nothing posts.
 *   3. Fix the plan (below) and post ITS recipes. The ledger dedupes on the
 *      recipe keys.
 *   4. THEN move the row — reduce on a partial rung, close on a closing one.
 *
 * Step 4 last, and the attempt only marked done after it, so a crash between 3
 * and 4 replays the rung: the stored plan re-posts the same recipes, so the ledger
 * moves nothing twice and the row catches up by the amounts that were BOOKED. The
 * reverse order would shrink a position whose loss never posted.
 *
 * THE PLAN IS STORED, NOT RE-DERIVED. The recipe keys do not carry the amounts,
 * and the amounts come from the live mark. Re-planning a crashed rung at a new
 * mark would present the same key with different money — see
 * `LiquidationAttemptStore.loadPlan`. A store without plan methods keeps the old
 * behaviour: plan fresh every tick.
 */
async function runLadderRung(
  deps: LiquidationTickDeps,
  ladder: LiquidationLadderDeps,
  row: LiquidationPositionRow,
  markPrice: Amount,
  liquidationId: string,
): Promise<LiquidationTickItemResult> {
  /**
   * FINISH WHAT WAS BOOKED BEFORE DECIDING ANYTHING NEW.
   *
   * An unfinished stored plan means a rung already posted (or is posting) its
   * loss and the row has not moved by it. That is owed regardless of what the
   * mark says now, and regardless of whether the policy or the book is readable:
   * the position may have recovered to healthy since, and re-planning would
   * then skip it and leave the ledger and the row disagreeing for good.
   */
  const stored = planStore(deps.attempts);
  if (stored) {
    // A closing rung's plan sits under its claimed lifecycle id. A replay of one
    // still parks, exactly as `tryClaim` returning false does below: a crash
    // after the claim waits for an operator rather than risk a second full loss.
    if (await stored.loadPlan(liquidationId)) {
      return { positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' };
    }
    const owed = await stored.loadPlan(partialRungKey(liquidationId, row));
    if (owed) {
      await executePlan(deps, ladder, row, liquidationId, partialRungKey(liquidationId, row), owed, stored);
      return {
        positionId: row.positionId,
        outcome: 'partially_liquidated',
        reason: owed.reason,
        summary: `replayed stored rung plan: close=${formatAmount(owed.sizeClosed)} marginRemaining=${formatAmount(owed.marginRemaining)}`,
      };
    }
  }

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

  let decision;
  try {
    decision = planLadderLiquidation({
      liquidationId,
      position: row,
      markPrice,
      depthNotional,
      policy: ladder.policy,
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

  /**
   * Closing rungs claim the lifecycle id so a second worker cannot full-close
   * twice. Partial rungs deliberately do NOT claim `liq:{positionId}` — the
   * position stays open for the next rung, and recipe keys already include the
   * closed size so two partials do not share a ledger id.
   */
  if (decision.closesPosition) {
    if (!(await deps.attempts.tryClaim(liquidationId))) {
      return { positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' };
    }
  }

  /**
   * What posts and what moves the row are ONE plan. First worker to save wins;
   * a racing second worker reads that plan back and ignores what this tick just
   * computed from its own mark. (A crashed rung is picked up at the top, before
   * any planning, so a replay never gets here with a different plan.)
   *
   * A partial rung is keyed by the row size it was planned against, NOT by the
   * size it closes: the closed size comes from the mark, so a key that carried it
   * would change with the mark and the replay would never find its own plan (it
   * would book a second tranche under a new ledger key). The reducer is the only
   * thing that shrinks the row and it runs after the post, so an unfinished rung
   * is exactly one whose row is still this size; a finished one is completed and
   * a row that regrows to that size gets a fresh plan.
   */
  const fresh: StoredRungPlan = {
    recipes: decision.recipes as PostRequest[],
    sizeClosed: decision.sizeClosed,
    marginRemaining: decision.marginRemaining,
    reason: decision.reason,
    closesPosition: decision.closesPosition,
  };
  const rungKey = decision.closesPosition ? liquidationId : partialRungKey(liquidationId, row);
  const plan = stored ? ((await stored.loadPlan(rungKey)) ?? (await stored.savePlan(rungKey, fresh))) : fresh;

  await executePlan(deps, ladder, row, liquidationId, rungKey, plan, stored);

  return {
    positionId: row.positionId,
    outcome: decision.closesPosition ? 'liquidated' : 'partially_liquidated',
    reason: plan.reason,
    summary: summarizeLadder(decision),
  };
}

/** The plan methods, or null for a store that has none (plan fresh every tick, as before). */
function planStore(
  attempts: LiquidationAttemptStore,
): (LiquidationAttemptStore & Required<Pick<LiquidationAttemptStore, 'loadPlan' | 'savePlan' | 'completePlan'>>) | null {
  return attempts.loadPlan && attempts.savePlan && attempts.completePlan ? (attempts as never) : null;
}

function partialRungKey(liquidationId: string, row: LiquidationPositionRow): string {
  return `${liquidationId}:partial:${formatAmount(parseAmount(row.size))}`;
}

/**
 * Post the plan, move the row by the PLAN's figures, then retire the plan.
 * Retiring comes last: a crash before it replays the same plan, and the ledger
 * dedupes the posts. (A crash between the row moving and the retire leaves an
 * unfinished plan under a size the row has left; only a row that regrows to
 * exactly that size could meet it, and the reducer's own guards refuse a move
 * that does not fit the row.)
 */
async function executePlan(
  deps: LiquidationTickDeps,
  ladder: LiquidationLadderDeps,
  row: LiquidationPositionRow,
  liquidationId: string,
  rungKey: string,
  plan: StoredRungPlan,
  stored: ReturnType<typeof planStore>,
): Promise<void> {
  for (const recipe of plan.recipes) {
    await deps.ledger.post(recipe);
  }

  if (plan.closesPosition) {
    await deps.closer.markLiquidated(row.positionId, { liquidationId, reason: plan.reason });
    await stored?.completePlan(rungKey);
    await deps.attempts.markDone(liquidationId);
  } else {
    await ladder.reducer.reduce(row.positionId, {
      liquidationId,
      sizeClosed: plan.sizeClosed,
      marginRemaining: plan.marginRemaining,
      reason: plan.reason,
      expectedSize: parseAmount(row.size),
    });
    await stored?.completePlan(rungKey);
  }
}

export function memoryLiquidationAttemptStore(): LiquidationAttemptStore {
  const done = new Set<string>();
  // Held ENCODED, as the sql store holds it, so a test through here exercises the
  // same round trip production does rather than sharing object identity.
  const plans = new Map<string, { plan: EncodedRungPlan; completed: boolean }>();
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
    async loadPlan(rungKey) {
      const stored = plans.get(rungKey);
      return stored && !stored.completed ? decodeRungPlan(stored.plan) : null;
    },
    async savePlan(rungKey, plan) {
      const existing = plans.get(rungKey);
      if (!existing || existing.completed) plans.set(rungKey, { plan: encodeRungPlan(plan), completed: false });
      return decodeRungPlan(plans.get(rungKey)!.plan);
    },
    async completePlan(rungKey) {
      const existing = plans.get(rungKey);
      if (existing) existing.completed = true;
    },
  };
}
