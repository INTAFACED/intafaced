import { sum, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, insuranceFund, loanCollateralAccount, loanReserve, userAvailable } from '../accounts.js';

/**
 * LOAN RECIPES (§8.1 — "collateralLock recipe … liquidation via internal book,
 * interest accrual daily recipe").
 *
 * ⚠ SHARED-PACKAGE CHANGE — flagged deliberately, and it REPLACES code.
 *
 * `recipes/index.ts` previously carried three lending stubs — `collateralLock`,
 * `collateralRelease` and `liquidate`. Nothing in the monorepo called any of
 * them, and a loan could not have been built on them:
 *
 *   1. They locked into `userCollateral(user, asset)` with NO purpose, so two
 *      loans in one asset shared a collateral pot (now fixed at the account
 *      constructor, and enforced by `assertPurposedLocks`).
 *   2. There was NO WAY TO RELEASE PRINCIPAL. `collateralLock` locked the
 *      borrower's collateral and the sequence stopped there — no draw, no debt,
 *      no repayment. Half of a loan is not a loan.
 *   3. `liquidate` debited the ENTIRE seizure to `houseFees('bank')`. Not to the
 *      lender, not against the debt — the whole of a borrower's seized
 *      collateral was booked as platform profit, because there was no reserve
 *      for it to return to and no debt for it to extinguish.
 *   4. `bank.liquidate:<loanId>` keyed one liquidation per loan for all time,
 *      which forbids the partial ladder outright.
 *
 * The five recipes below are kept in their own file so this diff is reviewable —
 * and revertable — separately from the rest of the shared package, the same way
 * `bank.ts` was.
 *
 * ── THE ORDERING IS THE PRODUCT ─────────────────────────────────────────────
 *
 * A loan is a leveraged position taken with the reserve's money. §8.1's sequence
 * is load-bearing, not descriptive, and each step is a separate transaction on
 * purpose:
 *
 *   loanCollateralLock   borrower available → borrower collateral(loan:<id>)
 *   loanDraw             loan reserve       → borrower available
 *   loanRepay            borrower available → reserve (principal) + house (interest)
 *   loanCollateralRelease borrower collateral(loan:<id>) → borrower available
 *   loanLiquidate        collateral → buyer, buyer's cash → reserve + house + borrower
 *
 * Two things follow from splitting lock and draw rather than fusing them into
 * one atomic post, and both were deliberate:
 *
 *   · A crash between them strands NOTHING. The collateral is in the borrower's
 *     own purposed account and the reserve has not moved, so the loan is simply
 *     un-drawn: re-driving it completes, and abandoning it releases. The reverse
 *     order — draw then lock — has a crash window in which the borrower holds
 *     principal against no collateral, and that window cannot be closed by a
 *     retry because the borrower can spend in it.
 *   · One fused transaction would be atomic but would also make "collateralised
 *     but not yet drawn" unrepresentable, and that is a state an operator needs
 *     when a draw is refused for a reason that is not the borrower's fault.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireNonNegative(name: string, value: Amount): void {
  if (value < 0n) throw new InvalidEntryError(`${name} cannot be negative`);
}

function requireSequence(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new InvalidEntryError(`${name} must be a non-negative integer, got ${value}`);
}

/**
 * Blank, whitespace-only, and missing ids are one failure. Interpolating them
 * builds a shared account and a shared key (`bank.loan.draw:`,
 * `bank.loan.liquidate::0`), so a later post is an idempotent no-op.
 * Refuse before any account ref or idempotency key is built. A present id is
 * used as given — this does not invent or rewrite one.
 */
function requireId(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntryError(`${name} must be a non-blank id`);
  }
}

// ── Collateral ───────────────────────────────────────────────────────────────

export interface LoanCollateralInput {
  loanId: string;
  userId: string;
  /** The asset PLEDGED. Usually not the asset borrowed — that is the whole point. */
  collateralAssetId: string;
  amount: Amount;
  /**
   * Which lock or release of this loan's collateral this is.
   *
   * Not cosmetic. A borrower curing a margin call by ADDING collateral is the
   * cheapest and best outcome available to everyone in the transaction, so it
   * has to be expressible more than once per loan — and each top-up needs its
   * own idempotency key or the second one silently returns the first's
   * transaction and the borrower gets liquidated holding a receipt.
   */
  sequence: number;
}

/**
 * STEP 1 OF EVERY LOAN. Collateral moves out of the borrower's spendable balance
 * and into a pot purposed to this loan.
 *
 * The value never stops being the borrower's — `collateral` is a `user`-owned
 * kind, and `assertPairedLocks` proves in the same transaction that it came from
 * that same borrower's available balance. A platform that took collateral into a
 * house account would look identical to the borrower right up to the day it did
 * not.
 */
export function loanCollateralLock(input: LoanCollateralInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('userId', input.userId);
  requireId('collateralAssetId', input.collateralAssetId);
  requirePositive('collateral amount', input.amount);
  requireSequence('collateral lock sequence', input.sequence);
  return {
    idempotencyKey: `bank.loan.collateral.lock:${input.loanId}:${input.sequence}`,
    module: 'bank',
    reason: 'loan.collateral.locked',
    meta: { loanId: input.loanId, sequence: input.sequence },
    entries: [
      credit(userAvailable(input.userId, input.collateralAssetId), input.amount),
      debit(loanCollateralAccount(input.userId, input.collateralAssetId, input.loanId), input.amount),
    ],
  };
}

/**
 * Collateral returns to the borrower.
 *
 * This recipe asserts nothing about whether the debt is settled, because a
 * recipe cannot: it has no reading of the loan. That check belongs to svc-bank
 * and is the single most important precondition in the module — releasing
 * collateral on a live loan converts a secured position into an unsecured one in
 * one transaction, and there is no posting that undoes it if the borrower has
 * already withdrawn.
 */
export function loanCollateralRelease(input: LoanCollateralInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('userId', input.userId);
  requireId('collateralAssetId', input.collateralAssetId);
  requirePositive('collateral release amount', input.amount);
  requireSequence('collateral release sequence', input.sequence);
  return {
    idempotencyKey: `bank.loan.collateral.release:${input.loanId}:${input.sequence}`,
    module: 'bank',
    reason: 'loan.collateral.released',
    meta: { loanId: input.loanId, sequence: input.sequence },
    entries: [
      credit(loanCollateralAccount(input.userId, input.collateralAssetId, input.loanId), input.amount),
      debit(userAvailable(input.userId, input.collateralAssetId), input.amount),
    ],
  };
}

// ── Principal ────────────────────────────────────────────────────────────────

export interface LoanDrawInput {
  loanId: string;
  userId: string;
  /** The asset BORROWED. */
  debtAssetId: string;
  principal: Amount;
}

/**
 * STEP 2. Principal leaves the lending reserve and becomes the borrower's to
 * spend.
 *
 * `loanReserve` is a `module` account, and §4.2's database CHECK makes every
 * non-treasury account hard non-negative. So a reserve with 100 USDT in it
 * cannot lend 150: the post fails with insufficient funds. That is the correct
 * failure and it is loud. The alternative — drawing against a `treasury`
 * boundary, the one owner type allowed to go negative — would produce a book
 * indistinguishable from one where the platform had printed the principal, and
 * the negative balance would be misfiled as an external obligation.
 *
 * One draw per loan. A borrower who wants more borrows again, against collateral
 * of their own, and gets their own LTV and their own liquidation price. Topping
 * up a live loan's principal would silently re-rate a position the borrower
 * already agreed the terms of.
 */
export function loanDraw(input: LoanDrawInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('userId', input.userId);
  requireId('debtAssetId', input.debtAssetId);
  requirePositive('loan principal', input.principal);
  return {
    idempotencyKey: `bank.loan.draw:${input.loanId}`,
    module: 'bank',
    reason: 'loan.drawn',
    meta: { loanId: input.loanId },
    entries: [
      credit(loanReserve(input.debtAssetId), input.principal),
      debit(userAvailable(input.userId, input.debtAssetId), input.principal),
    ],
  };
}

export interface LoanRepayInput extends LoanDrawInput {
  /** Principal returned to the reserve. May be zero on an interest-only payment. */
  principal: Amount;
  /** Accrued interest, settled to the bank's revenue account. May be zero. */
  interest: Amount;
  /** Which repayment of this loan. Partial repayment is normal, so this is required. */
  sequence: number;
}

/**
 * Repayment. Principal goes back where it came from; interest is revenue.
 *
 * The split is not presentational. Principal returning to `loanReserve` is what
 * makes the reserve lendable again and keeps the reconciliation identity in
 * `accounts.ts` true. Interest going to `houseFees('bank')` is what makes it
 * *revenue* — and, because `sweepFeesToRewards` and `earnPoolFund` already exist,
 * it is the pipe by which borrower interest can one day fund earn-pool yield
 * instead of the treasury subsidising it. That wiring is not in this change; the
 * accounts are lined up for it and nothing else has to move.
 *
 * A repayment of nothing is refused. Both halves being zero is a no-op the
 * ledger would reject anyway (zero-amount entries are not movements), and
 * catching it here says so in the caller's language.
 */
export function loanRepay(input: LoanRepayInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('userId', input.userId);
  requireId('debtAssetId', input.debtAssetId);
  requireNonNegative('repaid principal', input.principal);
  requireNonNegative('repaid interest', input.interest);
  requireSequence('repayment sequence', input.sequence);

  const total = input.principal + input.interest;
  requirePositive('total repayment', total);

  return {
    idempotencyKey: `bank.loan.repay:${input.loanId}:${input.sequence}`,
    module: 'bank',
    reason: 'loan.repaid',
    meta: { loanId: input.loanId, sequence: input.sequence, principal: input.principal.toString(), interest: input.interest.toString() },
    entries: [
      credit(userAvailable(input.userId, input.debtAssetId), total),
      ...(input.principal > 0n ? [debit(loanReserve(input.debtAssetId), input.principal)] : []),
      ...(input.interest > 0n ? [debit(houseFees('bank', input.debtAssetId), input.interest)] : []),
    ],
  };
}

// ── Liquidation ──────────────────────────────────────────────────────────────

export interface LoanLiquidationInput {
  loanId: string;
  userId: string;
  /**
   * WHICH RUNG OF THE LADDER. The single most important field in this file.
   *
   * The recipe this replaces keyed on `bank.liquidate:<loanId>` — one
   * liquidation per loan, for all time. That is not a small inconvenience: it
   * makes a partial-liquidation ladder impossible to express, so the only legal
   * liquidation is the whole position at once, which is precisely the behaviour
   * the derivatives spec forbids because dumping a full position into a thin
   * book moves the price against the borrower and can turn a recoverable
   * position into bad debt the platform eats.
   */
  tranche: number;
  collateralAssetId: string;
  /** Collateral units actually sold on this rung. */
  collateralSold: Amount;
  debtAssetId: string;
  /** Debt-asset value the sale realised. The EXECUTED total, not a quote. */
  proceeds: Amount;
  /** Of the proceeds, what returns to the reserve. */
  principalRepaid: Amount;
  /** Of the proceeds, the accrued interest settled. */
  interestRepaid: Amount;
  /** Of the proceeds, the liquidation penalty — the borrower's cost of the event. */
  penalty: Amount;
  /**
   * Of the proceeds, what goes back to the borrower.
   *
   * A liquidation that clears the debt and has value left over MUST return it.
   * The stub this replaces credited the entire seizure to house fees, which is
   * not a rounding error in the borrower's favour or against it — it is taking
   * the surplus.
   */
  surplusToBorrower: Amount;
  /**
   * WHO BOUGHT THE COLLATERAL — §8.1's "liquidation via internal book".
   *
   * Required, and required as two accounts rather than inferred, because a
   * liquidation is a SALE and a sale has a counterparty who really pays. Passing
   * the internal market maker means the platform's own book absorbed it and the
   * market maker's cash balance really fell; passing a taker's accounts means a
   * user did. Either way the ledger records which, and neither can be funded out
   * of nothing: both accounts are hard non-negative, so a liquidation into a
   * counterparty that cannot pay FAILS rather than half-settling.
   *
   * That is also the honest limit of this change. See svc-bank's
   * `loans/README` note: matching a liquidation against real resting orders
   * needs svc-trade to accept an order funded from a `collateral` pot, which is
   * svc-trade's to build. Until then this is a sale to a named counterparty at a
   * marked price, atomically — not a walk down a real book.
   */
  buyer: {
    /** Where the collateral lands. */
    collateralTo: AccountRef;
    /** Where the debt-asset proceeds come from. */
    proceedsFrom: AccountRef;
  };
  /** The mark the tranche executed at, recorded for the dispute nobody wants to have. */
  markPrice: Amount;
}

/**
 * ONE RUNG of a liquidation: seize, sell, repay — as a single transaction.
 *
 * ── WHY THIS IS ONE TRANSACTION AND NOT THREE ───────────────────────────────
 *
 * The obvious implementation is: release collateral to the borrower's available
 * balance, place a sell order, apply the proceeds. It is wrong, and it is wrong
 * in a way that only shows up under exactly the conditions a liquidation happens
 * in. Between the release and the sale the borrower holds spendable collateral on
 * a defaulting loan, and they are watching. One withdrawal in that window and
 * the platform is unsecured, holding an order that no longer has anything behind
 * it. The window cannot be closed with a lock, because the lock is the thing
 * being released.
 *
 * So the sale and the repayment are the same posting, and the collateral goes
 * from the borrower's purposed pot straight to the buyer. There is no instant at
 * which the borrower can touch it, and no instant at which the buyer holds
 * collateral they have not paid for.
 *
 * ── SUM-TO-ZERO ACROSS TWO ASSETS ───────────────────────────────────────────
 *
 * `assertBalanced` checks per asset, so both halves must close independently:
 * the collateral leg moves `collateralSold` from borrower to buyer, and the debt
 * leg splits exactly `proceeds` four ways. The four-way split is checked here
 * rather than left to the ledger's balance error, so a caller that mis-allocates
 * gets told which figure is wrong instead of "USDT off by 3".
 */
export function loanLiquidate(input: LoanLiquidationInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('userId', input.userId);
  requireId('collateralAssetId', input.collateralAssetId);
  requireId('debtAssetId', input.debtAssetId);
  requireSequence('liquidation tranche', input.tranche);
  requirePositive('collateral sold', input.collateralSold);
  requirePositive('liquidation proceeds', input.proceeds);
  requirePositive('mark price', input.markPrice);
  requireNonNegative('principal repaid', input.principalRepaid);
  requireNonNegative('interest repaid', input.interestRepaid);
  requireNonNegative('liquidation penalty', input.penalty);
  requireNonNegative('surplus to borrower', input.surplusToBorrower);

  if (input.collateralAssetId === input.debtAssetId) {
    // Not a purity check. A same-asset "liquidation" needs no sale and no
    // counterparty, so routing it through here would post a fictional trade —
    // and would let the buyer accounts be anything at all. Repay from the
    // collateral directly instead.
    throw new InvalidEntryError(
      `A liquidation sells collateral for the debt asset; both are ${input.debtAssetId}. ` +
        `Settle a same-asset loan with loanRepay against released collateral instead.`,
    );
  }

  const allocated = sum([input.principalRepaid, input.interestRepaid, input.penalty, input.surplusToBorrower]);
  if (allocated !== input.proceeds) {
    throw new InvalidEntryError(
      `Liquidation proceeds must be fully allocated: principal + interest + penalty + surplus = ${allocated}, ` +
        `proceeds = ${input.proceeds}. Every unit realised belongs to someone — an unallocated remainder is ` +
        `value the borrower paid for that nobody has claimed.`,
    );
  }

  if (input.buyer.collateralTo.assetId !== input.collateralAssetId) {
    throw new InvalidEntryError(
      `Buyer's collateral account is in ${input.buyer.collateralTo.assetId}, expected ${input.collateralAssetId}`,
    );
  }
  if (input.buyer.proceedsFrom.assetId !== input.debtAssetId) {
    throw new InvalidEntryError(`Buyer's payment account is in ${input.buyer.proceedsFrom.assetId}, expected ${input.debtAssetId}`);
  }

  const house = input.interestRepaid + input.penalty;

  return {
    idempotencyKey: `bank.loan.liquidate:${input.loanId}:${input.tranche}`,
    module: 'bank',
    reason: 'loan.liquidated',
    meta: {
      loanId: input.loanId,
      tranche: input.tranche,
      markPrice: input.markPrice.toString(),
      collateralSold: input.collateralSold.toString(),
      proceeds: input.proceeds.toString(),
    },
    entries: [
      // Collateral leg: the borrower's purposed pot → the buyer. No stop in between.
      credit(loanCollateralAccount(input.userId, input.collateralAssetId, input.loanId), input.collateralSold),
      debit(input.buyer.collateralTo, input.collateralSold),

      // Debt leg: the buyer really pays, and the proceeds split four ways.
      credit(input.buyer.proceedsFrom, input.proceeds),
      ...(input.principalRepaid > 0n ? [debit(loanReserve(input.debtAssetId), input.principalRepaid)] : []),
      ...(house > 0n ? [debit(houseFees('bank', input.debtAssetId), house)] : []),
      ...(input.surplusToBorrower > 0n ? [debit(userAvailable(input.userId, input.debtAssetId), input.surplusToBorrower)] : []),
    ],
  };
}

export interface LoanBadDebtInput {
  loanId: string;
  debtAssetId: string;
  /** Principal the collateral could not cover. */
  shortfall: Amount;
}

/**
 * THE LOSS, NAMED.
 *
 * A gap move can take a position through 100% LTV before any ladder can run. The
 * collateral is gone, the reserve is short, and the difference is a real loss
 * that belongs to someone. This recipe says who: the insurance fund, which
 * already exists for exactly this in §5.2's futures design.
 *
 * The reason to have it at all is that the alternative is worse in a specific
 * way. With no bad-debt posting, a fully-liquidated loan whose proceeds did not
 * clear the principal just leaves `loanReserve` permanently lower with no record
 * of why, and the reconciliation identity quietly stops holding. Every other
 * pool in the platform would look the same as a pool that had been drained.
 *
 * And when the insurance fund is empty this FAILS. That is the point. A platform
 * that cannot name where a loss came from should not be able to absorb it
 * silently; an operator seeing this refuse is an operator who has learned
 * something true on the day it became true.
 */
export function loanBadDebt(input: LoanBadDebtInput): PostRequest {
  requireId('loanId', input.loanId);
  requireId('debtAssetId', input.debtAssetId);
  requirePositive('bad debt shortfall', input.shortfall);
  return {
    idempotencyKey: `bank.loan.baddebt:${input.loanId}`,
    module: 'bank',
    reason: 'loan.bad_debt.covered',
    meta: { loanId: input.loanId },
    entries: [credit(insuranceFund(input.debtAssetId), input.shortfall), debit(loanReserve(input.debtAssetId), input.shortfall)],
  };
}

export interface LoanReserveFundInput {
  /** Identifies this funding event — a treasury transfer reference, a window id. */
  fundingId: string;
  debtAssetId: string;
  amount: Amount;
  /** Defaults to the bank's own fee revenue. */
  from?: AccountRef;
}

/**
 * Put lendable value into the reserve. Nothing can be borrowed before this runs.
 *
 * A supplied source must already be the debt asset. Cross-asset funding is
 * rejected outright rather than silently priced — converting between assets is
 * a trade, and a trade has an execution price this function has no business
 * inventing.
 */
export function loanReserveFund(input: LoanReserveFundInput): PostRequest {
  requireId('fundingId', input.fundingId);
  requireId('debtAssetId', input.debtAssetId);
  requirePositive('reserve funding amount', input.amount);
  if (input.from !== undefined && input.from.assetId !== input.debtAssetId) {
    throw new InvalidEntryError(
      `A transfer cannot change asset (${input.from.assetId} → ${input.debtAssetId}); route it through a conversion instead`,
    );
  }
  return {
    idempotencyKey: `bank.loan.reserve.fund:${input.debtAssetId}:${input.fundingId}`,
    module: 'bank',
    reason: 'loan.reserve.funded',
    meta: { fundingId: input.fundingId },
    entries: [
      credit(input.from ?? houseFees('bank', input.debtAssetId), input.amount),
      debit(loanReserve(input.debtAssetId), input.amount),
    ],
  };
}
