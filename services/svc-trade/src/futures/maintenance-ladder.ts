/**
 * THE PARTIAL-LIQUIDATION LADDER FOR ISOLATED PERPS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING, AND WHY IT MATTERED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The tracker row `trade.futures` reads "Perps: isolated margin, funding,
 * partial-liquidation ladder". Two of those three were built. The third was not:
 * `liquidation-planner.ts` closes the WHOLE position on every trigger, and
 * `liquidation-tick.ts` said so out loud in its own header — "Out of scope: mark
 * oracle product, matching engine, partial ladder, funding."
 *
 * `DIRECTION-2026-07-31.md` §1 does not treat that as a smaller version of the
 * same thing:
 *
 *   · "**Partial liquidation before full close.** Close the minimum that
 *     restores maintenance margin. Full close is a failure mode, not a policy."
 *   · "**Maintenance margin laddered by position size.** A position large
 *     relative to book depth is riskier at the same notional; the ladder must
 *     reference actual depth, not a constant."
 *
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md` then says futures adopts
 * the shape already argued in `services/svc-bank/src/loans/risk.ts` — closed-form
 * tranche sizing, `maxTrancheBps`, and a target that a liquidation restores TO
 * rather than stopping AT. This file is that adoption, in perp terms.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE PIECE OF PERP ALGEBRA THAT IS NOT OBVIOUS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On a loan, selling collateral RAISES the borrower's health because it retires
 * debt. On an isolated perp it does not, and a design that assumes it does will
 * loop forever closing tranches that change nothing.
 *
 * Write margin `m`, size `S`, unrealised PnL `u` (negative in trouble). Equity is
 * `m + u`. Close a fraction `f` at the mark: the tranche realises `f·u`, which
 * leaves the margin pot, so `m' = m + f·u`; the remainder still carries
 * `u' = (1−f)·u`. Then
 *
 *     equity' = m' + u' = (m + f·u) + (1−f)·u = m + u = equity.
 *
 * **Equity is invariant under a close at the mark.** Closing does not make a
 * trader richer or poorer — that is what "at the mark" means. What it changes is
 * the REQUIREMENT, because maintenance margin is a fraction of notional and
 * notional is what just shrank:
 *
 *     required' = mmBps · (1−f)·S·M / 10 000.
 *
 * So a partial liquidation restores the ratio by lowering the denominator, never
 * by raising the numerator. Two consequences are load-bearing below:
 *
 *   1. **A partial rung releases NO margin to the trader.** The margin left in
 *      the pot after the realised loss is what backs the remainder. Releasing it
 *      pro-rata would hold `equity` constant while cutting `m`, which is exactly
 *      the un-collateralised remainder this whole file exists to prevent. Only a
 *      rung that closes the position releases residual margin.
 *   2. **If equity is already ≤ 0, no `f` helps.** `required' ≥ 0` for every `f`,
 *      and a non-positive equity meets no requirement at any size. That is
 *      bankruptcy, it is a full close, and the shortfall is the insurance fund's
 *      — the arithmetic says so rather than a special case asserting it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH WAY EACH FIGURE ROUNDS, AND WHO PAYS FOR IT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Lifted deliberately from `loans/risk.ts`, because the argument is the same one
 * and a second, differently-rounded copy of it would be a defect:
 *
 *   · RISK figures round AGAINST the platform's optimism. Notional rounds UP,
 *     the maintenance requirement rounds UP, the unrealised loss used to DECIDE
 *     rounds AWAY from zero, the health ratio rounds DOWN. A book that
 *     under-reports risk by one unit learns about a bad position one tick late,
 *     and one tick late is the whole cost of the event.
 *
 *   · CHARGES to the trader round DOWN. The realised loss actually POSTED on a
 *     tranche rounds toward zero, in the trader's favour. The platform forgoing a
 *     sub-attounit is not a business risk; systematically taking one from a
 *     leveraged trader is the kind of thing only the trader ever discovers.
 *
 * The same `u` is therefore computed twice with opposite rounding, and that is
 * not an oversight — `riskPnl` decides whether to act, `chargedPnl` decides what
 * is debited. They differ by at most one attounit and they differ on purpose.
 *
 * NO FLOATS ANYWHERE. Every ratio is integer basis points, every value is a
 * scaled bigint, and every division states its rounding. A maintenance ratio in
 * floating point is a wrong liquidation, not an imprecise one, because the
 * comparison that flips is at the boundary and the boundary is where every
 * liquidation happens.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE STILL DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * · It does not deliver a margin call, and therefore it does not run a grace
 *   clock. The ADR is explicit that "a margin call that cannot be delivered is
 *   not a margin call" and that grace must not start without a transport. There
 *   is no production margin-call transport in `svc-trade` today, so this file
 *   reports the `margin-call` rung and stops there rather than shipping a grace
 *   timer that would silently authorise seizures off an undelivered notice.
 *   Delivery is a SEPARATE port (`notifyMarginCall` on the liquidation tick);
 *   the pure seals below (`mayStartMarginCallGrace` /
 *   `mayLiquidateFromExpiredMarginCallGrace`) are the only lawful way a future
 *   grace field may start or expire into seizure. Grace *duration* numbers are
 *   DIRECTION §8 / D3 owner-reserved — never invent them here.
 * · It does not choose the numbers. Owner D3 / DIRECTION §8 item 8 names the
 *   tier table. The MECHANISM is agent-implementable per the ADR; this module
 *   takes `FuturesLadderPolicy` as an argument. Live jobs omit the policy
 *   (`skipped_d3_unset`) until that ruling exists. A numeric placeholder table
 *   must not ship from this file — test harnesses may hold one.
 * · It adds no ledger recipe. Partial rungs post through `futuresRealizeLoss` and
 *   `futuresMarginRelease`, which already exist. Adding a recipe is a
 *   `DIRECTION` §3 carve-out reserved to the owner.
 */
import { formatAmount, mul, mulBps, recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';
import type { LiquidationPosition } from './liquidation-planner.js';

const SCALE = 10n ** 18n;
const BPS = 10_000;
const BPS_BIG = 10_000n;

/** Refusals from the ladder. Same shape as `mark-policy.ts` / `risk.ts` codes. */
export class FuturesLadderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'FuturesLadderError';
  }
}

export const LADDER_POLICY_INCOHERENT = 'trade.ladder_policy_incoherent';
export const DEPTH_UNKNOWN = 'trade.depth_unknown';

// ── C15: margin-call delivery before grace / seizure ─────────────────────────

/**
 * C15 / ADR done bar 6: "A margin call with no transport does not start a grace
 * clock." `bankMarginCalled` was published into a void for weeks; futures must
 * not repeat that by starting grace (or seizing "from grace") off an undelivered
 * notice.
 *
 * These helpers are pure law. They take no grace-duration number — inventing one
 * would be D3 (owner-reserved ladder parameters). When a real grace clock is
 * added, write `graceExpiresAt` only after `mayStartMarginCallGrace` returns
 * true, and only escalate seizure through
 * `mayLiquidateFromExpiredMarginCallGrace`.
 */

/** Fact returned by the `notifyMarginCall` port on the liquidation tick. */
export interface MarginCallDelivery {
  readonly delivered: boolean;
}

/**
 * May a grace clock start after this margin-call attempt?
 *
 * Only when transport accepted delivery. Undelivered → never. Does not invent a
 * grace length — that stays owner-reserved (D3).
 */
export function mayStartMarginCallGrace(delivery: MarginCallDelivery): boolean {
  return delivery.delivered === true;
}

/**
 * May the liquidation path seize because "margin-call grace has expired"?
 *
 * Today futures has no grace field. A missing `graceExpiresAt` means grace never
 * started, so this always returns false on the live path — which is the honest
 * product state, not a silent seizure.
 *
 * Seal for future work: even if someone passes a past `graceExpiresAt`, an
 * undelivered call STILL cannot liquidate "from grace". That is the regression
 * the unit-9 test pins.
 */
export function mayLiquidateFromExpiredMarginCallGrace(input: {
  readonly delivered: boolean;
  /** Instant grace ends. Null/undefined = grace never started (current product). */
  readonly graceExpiresAt?: Date | null;
  readonly now: Date;
}): boolean {
  if (!mayStartMarginCallGrace({ delivered: input.delivered })) return false;
  if (input.graceExpiresAt == null) return false;
  return input.now.getTime() >= input.graceExpiresAt.getTime();
}

// ── The depth-referenced tier table ──────────────────────────────────────────

/**
 * One rung of the maintenance table.
 *
 * `uptoDepthBps` is the position's notional expressed as basis points OF THE
 * BOOK DEPTH IT WOULD HAVE TO BE SOLD INTO — not of some fixed notional ladder.
 * That is the whole point of §1's sentence: 50 000 USDT is a small position in a
 * deep book and an unclosable one in a book holding 20 000, and a table keyed on
 * notional alone cannot tell those apart.
 *
 * `maintenanceBps` is the maintenance requirement as basis points of the
 * position's notional. It rises with the tier because a position that is large
 * relative to depth cannot be exited at the mark, and the mark is what every
 * figure above is computed from.
 */
export interface DepthTier {
  readonly uptoDepthBps: number;
  readonly maintenanceBps: number;
}

export interface FuturesLadderPolicy {
  /**
   * Ascending by `uptoDepthBps`, non-decreasing in `maintenanceBps`, and the last
   * entry must be the catch-all (`Number.MAX_SAFE_INTEGER`).
   *
   * The catch-all is REQUIRED rather than defaulted, and `assertLadderPolicyCoherent`
   * refuses a table without one. The alternative — refusing to rate a position
   * bigger than every tier — sounds conservative and is the opposite: the largest
   * and least closable positions on the venue would be the ones no rung ever
   * fires on.
   */
  readonly tiers: readonly DepthTier[];
  /**
   * Health ratio (equity ÷ maintenance requirement, in bps) below which the
   * trader is warned. Must be above 10 000 — a warning that arrives at the
   * liquidation threshold is a receipt, not a warning.
   */
  readonly marginCallBps: number;
  /**
   * Health ratio a liquidation restores TO. Must be above `marginCallBps`.
   *
   * Stopping at 10 000 exactly is the failure `assertPolicyCoherent` names in
   * `loans/risk.ts`: "a liquidation that leaves the loan still in margin call has
   * bought the borrower nothing and will fire again on the next mark." On a perp
   * it is worse than pointless, because each rung is a real fill into the book.
   */
  readonly targetBps: number;
  /** Ceiling on ONE rung, as bps of the position's remaining size. */
  readonly maxTrancheBps: number;
}

export function assertLadderPolicyCoherent(policy: FuturesLadderPolicy): void {
  if (policy.tiers.length === 0) {
    throw new FuturesLadderError('Ladder policy has no tiers — there is no maintenance requirement to enforce', LADDER_POLICY_INCOHERENT);
  }

  let previousUpto = -1;
  let previousMaintenance = -1;
  for (const tier of policy.tiers) {
    if (!Number.isInteger(tier.uptoDepthBps) || tier.uptoDepthBps <= 0) {
      throw new FuturesLadderError(`Tier bound must be a positive integer in bps, got ${tier.uptoDepthBps}`, LADDER_POLICY_INCOHERENT);
    }
    if (!Number.isInteger(tier.maintenanceBps) || tier.maintenanceBps < 0 || tier.maintenanceBps > BPS) {
      throw new FuturesLadderError(
        `Maintenance must be an integer in [0, ${BPS}] bps, got ${tier.maintenanceBps}`,
        LADDER_POLICY_INCOHERENT,
      );
    }
    if (tier.uptoDepthBps <= previousUpto) {
      throw new FuturesLadderError(
        `Tier bounds must strictly ascend; ${tier.uptoDepthBps} follows ${previousUpto}`,
        LADDER_POLICY_INCOHERENT,
      );
    }
    if (tier.maintenanceBps < previousMaintenance) {
      // A bigger position relative to depth that requires LESS margin inverts the
      // whole reason the table is keyed on depth.
      throw new FuturesLadderError(
        `Maintenance must not fall as a position grows relative to depth; ${tier.maintenanceBps} follows ${previousMaintenance}`,
        LADDER_POLICY_INCOHERENT,
      );
    }
    previousUpto = tier.uptoDepthBps;
    previousMaintenance = tier.maintenanceBps;
  }

  const last = policy.tiers[policy.tiers.length - 1]!;
  if (last.uptoDepthBps !== Number.MAX_SAFE_INTEGER) {
    throw new FuturesLadderError(
      `The last tier must be the catch-all (uptoDepthBps = ${Number.MAX_SAFE_INTEGER}), got ${last.uptoDepthBps} — ` +
        'otherwise the largest positions on the venue are the ones no rung ever fires on',
      LADDER_POLICY_INCOHERENT,
    );
  }

  if (!Number.isInteger(policy.marginCallBps) || policy.marginCallBps <= BPS) {
    throw new FuturesLadderError(
      `marginCallBps must be an integer above ${BPS}, got ${policy.marginCallBps} — a warning at the liquidation threshold is a receipt`,
      LADDER_POLICY_INCOHERENT,
    );
  }
  if (!Number.isInteger(policy.targetBps) || policy.targetBps <= policy.marginCallBps) {
    throw new FuturesLadderError(
      `targetBps (${policy.targetBps}) must be above marginCallBps (${policy.marginCallBps}), ` +
        'or a liquidation leaves the position still in margin call and fires again on the next mark',
      LADDER_POLICY_INCOHERENT,
    );
  }
  if (!Number.isInteger(policy.maxTrancheBps) || policy.maxTrancheBps <= 0 || policy.maxTrancheBps > BPS) {
    throw new FuturesLadderError(`maxTrancheBps must be an integer in (0, ${BPS}], got ${policy.maxTrancheBps}`, LADDER_POLICY_INCOHERENT);
  }
}

/**
 * Position notional as basis points of the depth it would be sold into.
 *
 * Rounds UP: a position sitting exactly on a tier boundary is rated into the
 * HIGHER tier. Rounding a marginal position down is the one direction that is
 * never recoverable, because marginal positions are the only ones this number is
 * ever consulted about.
 *
 * A non-positive depth is NOT "very deep" and is NOT "zero risk" — it is a book
 * this service could not read, and it refuses. `mark-from-depth.ts` already
 * refuses to mint a mid from a book too thin to support one; rating a position
 * against a depth of zero would walk straight past that with a division.
 */
export function depthRatioBps(notional: Amount, depthNotional: Amount): number {
  if (notional < 0n) throw new FuturesLadderError('Notional cannot be negative', LADDER_POLICY_INCOHERENT);
  if (depthNotional <= 0n) {
    throw new FuturesLadderError(
      'No readable book depth — refusing to rate a position against a depth this service could not observe',
      DEPTH_UNKNOWN,
    );
  }
  if (notional === 0n) return 0;
  const bps = (notional * BPS_BIG + depthNotional - 1n) / depthNotional;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
}

/** The maintenance requirement, in bps of notional, for a position of this size relative to this book. */
export function maintenanceBpsFor(notional: Amount, depthNotional: Amount, policy: FuturesLadderPolicy): number {
  assertLadderPolicyCoherent(policy);
  const ratio = depthRatioBps(notional, depthNotional);
  for (const tier of policy.tiers) {
    if (ratio <= tier.uptoDepthBps) return tier.maintenanceBps;
  }
  // Unreachable while the policy is coherent — the last tier is the catch-all.
  /* c8 ignore next */
  return policy.tiers[policy.tiers.length - 1]!.maintenanceBps;
}

// ── The rung ─────────────────────────────────────────────────────────────────

export interface LadderInput {
  readonly position: LiquidationPosition;
  /** External mark, already gated by `mark-policy.ts`. Scaled. Never invented here. */
  readonly markPrice: Amount;
  /**
   * Quote-asset depth on the side this position must be closed INTO — bids for a
   * long, asks for a short. `sideDepthNotional()` in `mark-from-depth.ts` reads it
   * from the same book the mark came from.
   */
  readonly depthNotional: Amount;
  readonly policy: FuturesLadderPolicy;
}

interface RungCommon {
  readonly notional: Amount;
  readonly maintenanceBps: number;
  readonly maintenanceRequired: Amount;
  /** Risk-side unrealised PnL — rounded away from zero. Decides; does not debit. */
  readonly riskPnl: Amount;
  readonly equity: Amount;
  /** equity ÷ maintenanceRequired in bps, floored. `0` when equity ≤ 0. */
  readonly healthBps: number;
}

export type LadderRung =
  | (RungCommon & { readonly action: 'none' })
  | (RungCommon & { readonly action: 'margin-call' })
  | (RungCommon & {
      readonly action: 'liquidate';
      /** Size to close on THIS rung. Never more than the position holds. */
      readonly sizeToClose: Amount;
      /** True when this rung exhausts the position. */
      readonly closesPosition: boolean;
      /** Equity was already ≤ 0 — no partial close restores anything. */
      readonly bankrupt: boolean;
      /** The tranche ceiling bit, rather than the restoring size. Auditable. */
      readonly trancheCapped: boolean;
    })
  | (RungCommon & { readonly action: 'refuse'; readonly reason: string });

/**
 * WHAT TO DO ABOUT ONE ISOLATED PERP POSITION, RIGHT NOW.
 *
 * Pure. No clock, no I/O, no ledger. Throws only on a policy or depth problem —
 * a market condition is always a returned rung, never an exception, because a
 * tick that scans a thousand positions must not abort on the state of one.
 */
export function planLadderRung(input: LadderInput): LadderRung {
  assertLadderPolicyCoherent(input.policy);

  const { position, markPrice: mark, policy } = input;

  const empty: RungCommon = {
    notional: 0n,
    maintenanceBps: 0,
    maintenanceRequired: 0n,
    riskPnl: 0n,
    equity: 0n,
    healthBps: 0,
  };

  if (mark <= 0n) {
    return { ...empty, action: 'refuse', reason: 'invalid_mark' };
  }
  if (position.size <= 0n || position.entryPrice <= 0n) {
    return { ...empty, action: 'refuse', reason: 'empty_position' };
  }
  if (position.margin < 0n) {
    return { ...empty, action: 'refuse', reason: 'invalid_margin' };
  }

  // Notional rounds UP: the requirement it feeds must not be understated.
  const notional = mul(position.size, mark, 'ceil');
  const maintenanceBps = maintenanceBpsFor(notional, input.depthNotional, policy);
  const maintenanceRequired = mulBps(notional, maintenanceBps, 'ceil');

  // The DECIDING PnL. `diff` is negative when the position is losing, and
  // `'floor'` on a negative product moves AWAY from zero — the larger loss.
  const diff = position.side === 'long' ? mark - position.entryPrice : position.entryPrice - mark;
  const riskPnl = mul(position.size, diff, 'floor');
  const equity = position.margin + riskPnl;

  const healthBps = healthRatioBps(equity, maintenanceRequired);
  const common: RungCommon = { notional, maintenanceBps, maintenanceRequired, riskPnl, equity, healthBps };

  if (healthBps >= policy.marginCallBps) return { ...common, action: 'none' };
  if (healthBps >= BPS) return { ...common, action: 'margin-call' };

  /**
   * A LIQUIDATION IN PROFIT IS A DATA BUG, NOT A LIQUIDATION.
   *
   * Same refusal `liquidation-planner.ts` already carries, and for the same
   * reason: everything below realises losses only, so reaching it with a positive
   * PnL hands the trader their margin back and silently keeps the gain. It is
   * reachable here in a way it is not there — a maintenance requirement set above
   * a position's initial margin fraction can put a PROFITABLE position under its
   * own requirement — and that is a policy incoherence an operator must see, not
   * a market event to trade on the trader's behalf.
   */
  if (riskPnl > 0n) {
    return { ...common, action: 'refuse', reason: 'refused_profitable_liquidation' };
  }

  const bankrupt = equity <= 0n;

  let sizeToClose: Amount;
  if (bankrupt) {
    sizeToClose = position.size;
  } else {
    const keep = largestRestoringKeep(position.size, mark, input.depthNotional, equity, policy);
    sizeToClose = keep >= position.size ? 0n : position.size - keep;
  }

  if (sizeToClose <= 0n) {
    /**
     * A rung that closes nothing is not a rung. Reachable only through integer
     * flooring on a dust position; reported as a margin call so it stays visible
     * instead of looping on a liquidation that never moves the position.
     */
    return { ...common, action: 'margin-call' };
  }

  /**
   * THE TRANCHE CEILING — AND THE ONE CASE IT MUST NOT APPLY TO.
   *
   * `loans/risk.ts`: "Never sell more than `maxTrancheBps` of the remaining
   * collateral on one rung, whatever the arithmetic asks for. The next mark
   * decides whether another rung is needed, and by then the book has had time to
   * refill." That is right for a position that is still solvent.
   *
   * It is wrong for one that is not. Capping a bankrupt position leaves the
   * platform holding leveraged risk that is ALREADY past its margin, on the
   * explicit hope that the next tick finds a better price — which is the trade
   * the insurance fund exists to stop anyone making. So bankruptcy closes in
   * full, and the flag records which of the two happened.
   */
  let trancheCapped = false;
  if (!bankrupt) {
    const cap = mulBps(position.size, policy.maxTrancheBps, 'floor');
    if (cap > 0n && sizeToClose > cap) {
      sizeToClose = cap;
      trancheCapped = true;
    }
  }
  if (sizeToClose > position.size) sizeToClose = position.size;

  return {
    ...common,
    action: 'liquidate',
    sizeToClose,
    closesPosition: sizeToClose >= position.size,
    bankrupt,
    trancheCapped,
  };
}

/**
 * THE LARGEST SIZE THE TRADER MAY KEEP AND STILL MEET THE TARGET.
 *
 * `DIRECTION` §1 says "close the MINIMUM that restores maintenance margin", and
 * this is where that word is earned. Getting it wrong in the safe-looking
 * direction still costs the trader real money: an over-sized rung sells a
 * position that did not need selling, and there is no posting that gives it back.
 *
 * ── WHY THIS IS NOT ONE DIVISION ────────────────────────────────────────────
 *
 * Within a single maintenance tier the condition is linear. Keep `k`, and since
 * equity does not move (see the header) the whole constraint is on the
 * requirement:
 *
 *     equity ≥ targetBps/10⁴ · mmBps/10⁴ · k·M/SCALE
 *  ⇔  k ≤ equity · 10⁸ · SCALE / (targetBps · mmBps · M)
 *
 * The FIRST version of this function stopped there, solving once against the
 * position's CURRENT tier and calling the extra closure conservative. A property
 * test caught it: `mmBps` is a function of `k`, because the tier is keyed on the
 * position's notional relative to depth and closing shrinks that notional. Solve
 * against the pre-close tier and a rung that drops the position into a CHEAPER
 * tier over-closes — on the counterexample the property found, by about 0.2% of
 * the position, silently and every time.
 *
 * ── THE SEARCH, AND WHY IT IS EXACT ─────────────────────────────────────────
 *
 * The requirement is NON-DECREASING in `k`, all the way across the tier table:
 * notional rises with `k`, `maintenanceBpsFor` never falls as notional rises
 * (`assertLadderPolicyCoherent` refuses a table where it could), and `mulBps`
 * rises with both. So feasibility is monotone, the feasible set is a prefix
 * `[0, k*]`, and one bisection finds `k*` exactly.
 *
 * BISECTING RATHER THAN SOLVING, even though the algebra is right there, and the
 * reason is the two `ceil`s. `mul(k, M, 'ceil')` and `mulBps(notional, mm, 'ceil')`
 * each round the requirement up by up to one attounit, so the algebraic answer
 * sits one or two units above the largest `k` that actually passes the integer
 * check. Reaching for the equation and then fudging the last two units is how a
 * rounding bug gets written. `feasible` below is the SAME arithmetic
 * `planLadderRung` uses to decide the position is in trouble in the first place,
 * so the sizing and the trigger can never disagree about what the requirement is.
 *
 * About sixty iterations, once per liquidatable position per tick. Not on any hot
 * path, and nowhere near the cost of the ledger post it precedes.
 */
function largestRestoringKeep(size: Amount, mark: Amount, depthNotional: Amount, equity: Amount, policy: FuturesLadderPolicy): Amount {
  const target = BigInt(policy.targetBps);

  /** Does keeping `keep` actually meet the target, at whatever tier it lands in? */
  const feasible = (keep: Amount): boolean => {
    if (keep <= 0n) return true;
    const notional = mul(keep, mark, 'ceil');
    const required = mulBps(notional, maintenanceBpsFor(notional, depthNotional, policy), 'ceil');
    return equity * BPS_BIG >= target * required;
  };

  if (feasible(size)) return size;

  // `feasible(0)` is true unconditionally, so the invariant `feasible(lo)` holds
  // from the start and the loop only ever narrows onto a `k` that passed.
  let lo = 0n;
  let hi = size;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (feasible(mid)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Equity as basis points of the maintenance requirement, floored.
 *
 * A non-positive equity is `0` rather than a negative ratio: every threshold
 * comparison downstream stays a plain integer comparison, and there is no reading
 * of "minus 400% healthy" that is more informative than "no equity".
 *
 * A zero requirement with positive equity is `MAX_SAFE_INTEGER`, matching
 * `ltvBps`'s treatment of the mirror case.
 */
export function healthRatioBps(equity: Amount, maintenanceRequired: Amount): number {
  if (equity <= 0n) return 0;
  if (maintenanceRequired <= 0n) return Number.MAX_SAFE_INTEGER;
  const bps = (equity * BPS_BIG) / maintenanceRequired;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
}

// ── Rung → ledger recipes ────────────────────────────────────────────────────

export interface LadderPlan {
  readonly liquidate: true;
  readonly rung: Extract<LadderRung, { action: 'liquidate' }>;
  readonly sizeClosed: Amount;
  readonly closesPosition: boolean;
  /** Loss actually charged on this tranche — rounded in the trader's favour. */
  readonly loss: Amount;
  readonly fromMargin: Amount;
  readonly fromInsurance: Amount;
  /** Margin returned to the trader. Non-zero only on a closing rung. */
  readonly residualRelease: Amount;
  /** What `margin_current` becomes for the remainder. Zero on a closing rung. */
  readonly marginRemaining: Amount;
  readonly recipes: readonly PostRequest[];
  readonly reason: string;
}

export type LadderDecision = LadderPlan | { readonly liquidate: false; readonly rung: LadderRung; readonly reason: string };

export interface LadderPlanInput extends LadderInput {
  /** Idempotency root for this attempt. `:loss` and the release sequence hang off it. */
  readonly liquidationId: string;
  /**
   * The rung's own id. When given, EVERY ledger key the plan produces carries it
   * (`futures.loss:{liquidationId}:rung:{rungId}:loss`,
   * `futures.margin.release:{positionId}:rung:{rungId}`), so a position row that
   * regrows to an earlier size at the same mark can never collide with a key an
   * older rung already booked — the ledger would answer with the OLD transaction
   * and the new rung's loss would never be booked. Omitted: the original keys
   * (a rung in flight from before rung ids, and every caller that predates them).
   */
  readonly rungId?: string;
}

/**
 * Plan one rung, all the way to postable recipes.
 *
 * NO NEW RECIPE. A partial rung is `futuresRealizeLoss` on the tranche and
 * nothing else; a closing rung adds `futuresMarginRelease` for whatever margin
 * the loss did not consume. Both already exist, both already key off an id the
 * caller supplies, and adding a third would be a `DIRECTION` §3 carve-out this
 * file is not entitled to make.
 */
export function planLadderLiquidation(input: LadderPlanInput): LadderDecision {
  const rung = planLadderRung(input);
  if (rung.action !== 'liquidate') {
    return { liquidate: false, rung, reason: rung.action === 'refuse' ? rung.reason : rung.action };
  }

  const { position } = input;
  const sizeClosed = rung.sizeToClose;

  /**
   * THE CHARGED PnL, rounded the other way. `'ceil'` on a negative product moves
   * TOWARD zero — the smaller debit — so the tranche's realised loss is charged
   * in the trader's favour even though the decision to charge it was taken on the
   * pessimistic figure. See the header.
   */
  const diff = position.side === 'long' ? input.markPrice - position.entryPrice : position.entryPrice - input.markPrice;
  const chargedPnl = mul(sizeClosed, diff, 'ceil');
  const loss = chargedPnl < 0n ? -chargedPnl : 0n;

  const fromMargin = loss >= position.margin ? position.margin : loss;
  const fromInsurance = loss > position.margin ? loss - position.margin : 0n;
  const marginAfterLoss = position.margin - fromMargin;

  // Only a closing rung hands margin back. On a partial rung the remaining margin
  // is what collateralises the remaining size — see consequence 1 in the header.
  const residualRelease = rung.closesPosition ? marginAfterLoss : 0n;
  const marginRemaining = rung.closesPosition ? 0n : marginAfterLoss;

  const posts: PostRequest[] = [];
  if (fromMargin > 0n || fromInsurance > 0n) {
    /**
     * LOSS ID MUST BE UNIQUE PER RUNG. A stable lifecycle liquidationId
     * (`liq:{positionId}`) is correct for a single full close; partial rungs
     * on the same position re-use that prefix, so the closed size is part of
     * the key — otherwise the second partial is a ledger no-op and margin
     * never leaves the pot while the row shrinks.
     */
    const lossId =
      input.rungId !== undefined
        ? `${input.liquidationId}:rung:${input.rungId}:loss`
        : rung.closesPosition
          ? `${input.liquidationId}:loss`
          : `${input.liquidationId}:loss:partial:${formatAmount(sizeClosed)}:${formatAmount(position.size)}`;
    posts.push(
      recipes.futuresRealizeLoss({
        positionId: position.positionId,
        userId: position.userId,
        assetId: position.marginAsset,
        fromMargin,
        fromInsurance,
        lossId,
      }),
    );
  }
  if (residualRelease > 0n) {
    const release = recipes.futuresMarginRelease({
      positionId: position.positionId,
      userId: position.userId,
      assetId: position.marginAsset,
      amount: residualRelease,
      sequence: 1,
    });
    // The recipe keys a release by (position, sequence). A rung's release is that
    // rung's own fact, so the rung id replaces the sequence in the key.
    posts.push(
      input.rungId === undefined
        ? release
        : { ...release, idempotencyKey: `futures.margin.release:${position.positionId}:rung:${input.rungId}` },
    );
  }

  return {
    liquidate: true,
    rung,
    sizeClosed,
    closesPosition: rung.closesPosition,
    loss,
    fromMargin,
    fromInsurance,
    residualRelease,
    marginRemaining,
    recipes: posts,
    reason: rung.bankrupt ? 'bankrupt_full_close' : rung.closesPosition ? 'ladder_full_close' : 'ladder_partial',
  };
}

export function summarizeLadder(decision: LadderDecision): string {
  if (!decision.liquidate) {
    return `skip health=${decision.rung.healthBps}bps mm=${decision.rung.maintenanceBps}bps (${decision.reason})`;
  }
  return (
    `${decision.reason} close=${formatAmount(decision.sizeClosed)} loss=${formatAmount(decision.loss)} ` +
    `margin=${formatAmount(decision.fromMargin)} insurance=${formatAmount(decision.fromInsurance)} ` +
    `release=${formatAmount(decision.residualRelease)} health=${decision.rung.healthBps}bps`
  );
}
