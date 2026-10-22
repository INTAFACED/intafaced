/**
 * Liquidation tick (trade.futures residual).
 *
 * JOB SHAPE (not a wall-clock cron): one callable tick that:
 *  1. loads open positions
 *  2. asks an external MarkSource for each mark (never invents)
 *  3. plans via planLiquidation
 *  4. posts ledger recipes + marks position liquidated (via PositionCloser)
 *
 * Out of scope: mark oracle product, matching engine, funding.
 *
 * THE LADDER IS NO LONGER OUT OF SCOPE. This header used to list "partial
 * ladder" among the things this tick does not do, and it was accurate: every
 * trigger produced a FULL close, which `DIRECTION` §1 calls "a failure mode, not
 * a policy". Supply `deps.ladder` and the tick plans through
 * `maintenance-ladder.ts` instead — a depth-referenced maintenance requirement,
 * the smallest close that restores it, and a partial rung that REDUCES the
 * position rather than closing it. Leave `deps.ladder` off and the old
 * full-close planner runs unchanged, so nothing that already works moves.
 */
import { formatAmount, parseAmount, type Amount, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { planLiquidation, summarizeLiquidation, type LiquidationPosition, type LiquidationDecision } from './liquidation-planner.js';
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
  reduce(positionId: string, input: { liquidationId: string; sizeClosed: Amount; marginRemaining: Amount; reason: string }): Promise<void>;
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
   * Present → plan through the partial-liquidation ladder. Absent → the legacy
   * full-close planner, unchanged. See the file header.
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
    | 'invalid';
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

  for (const row of open) {
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
    const mark = formatAmount(quoted.price);

    if (deps.ladder) {
      const outcomeItem = await runLadderRung(deps, deps.ladder, row, quoted.price, liquidationId);
      items.push(outcomeItem);
      if (outcomeItem.outcome === 'liquidated') liquidated += 1;
      else if (outcomeItem.outcome === 'partially_liquidated') partial += 1;
      else if (outcomeItem.outcome === 'margin_call') marginCalls += 1;
      continue;
    }

    const decision: LiquidationDecision = planLiquidation({
      liquidationId,
      position: row,
      markPrice: mark,
      maintenanceBps: deps.maintenanceBps,
    });

    if (!decision.liquidate) {
      const outcome =
        decision.reason === 'invalid_mark' || decision.reason === 'invalid_maintenance_bps' || decision.reason === 'empty_position'
          ? 'invalid'
          : decision.reason === 'maintenance_bps_unset'
            ? 'skipped_d3_unset'
            : 'skipped_healthy';
      items.push({
        positionId: row.positionId,
        outcome,
        reason: decision.reason,
        summary: summarizeLiquidation(decision),
      });
      continue;
    }

    /**
     * INSURANCE SHORTFALL BOUND. Planner may attribute loss beyond margin to
     * insurance; that is arithmetic, not permission to invent cover. Check the
     * named fund BEFORE any post. Underfunded → park (position stays open,
     * attempt NOT marked done) so a later top-up can re-drive the rung.
     */
    const insurance = await checkInsuranceBound({
      assetId: row.marginAsset,
      fromInsurance: decision.fromInsurance,
      balance: (ref) => deps.ledger.balance(ref),
    });
    if (!insurance.ok) {
      items.push(
        await parkUnderfundedWithAdl({
          adl: deps.adl,
          row,
          fromInsurance: decision.fromInsurance,
          insuranceReason: insurance.reason ?? INSURANCE_UNDERFUNDED,
          at,
        }),
      );
      continue;
    }

    /**
     * CLAIM BEFORE POST. After every skip gate that leaves the position open for
     * a later re-drive (no mark, healthy, underfunded insurance), reserve the
     * attempt id so a second worker cannot post under the same lifecycle key.
     * false → another worker already owns it (or finished).
     */
    if (!(await deps.attempts.tryClaim(liquidationId))) {
      items.push({ positionId: row.positionId, outcome: 'skipped_already', reason: 'already_done' });
      continue;
    }

    for (const recipe of decision.recipes) {
      await deps.ledger.post(recipe as PostRequest);
    }
    await deps.closer.markLiquidated(row.positionId, { liquidationId, reason: decision.reason });
    await deps.attempts.markDone(liquidationId);
    liquidated += 1;
    items.push({
      positionId: row.positionId,
      outcome: 'liquidated',
      reason: decision.reason,
      summary: summarizeLiquidation(decision),
    });
  }

  return { scanned: open.length, liquidated, partial, marginCalls, items };
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
 *   3. Post the recipes. The ledger dedupes on `liquidationId`.
 *   4. THEN move the row — reduce on a partial rung, close on a closing one.
 *
 * Step 4 last, and the attempt only marked done after it, so a crash between 3
 * and 4 re-runs the whole rung: the ledger moves nothing twice on the replay, and
 * the row catches up. The reverse order would shrink a position whose loss never
 * posted.
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

  for (const recipe of decision.recipes) {
    await deps.ledger.post(recipe as PostRequest);
  }

  if (decision.closesPosition) {
    await deps.closer.markLiquidated(row.positionId, { liquidationId, reason: decision.reason });
    await deps.attempts.markDone(liquidationId);
  } else {
    await ladder.reducer.reduce(row.positionId, {
      liquidationId,
      sizeClosed: decision.sizeClosed,
      marginRemaining: decision.marginRemaining,
      reason: decision.reason,
    });
  }

  return {
    positionId: row.positionId,
    outcome: decision.closesPosition ? 'liquidated' : 'partially_liquidated',
    reason: decision.reason,
    summary: summarizeLadder(decision),
  };
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
