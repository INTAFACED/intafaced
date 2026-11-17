import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `loans/` throws, and what a caller is told for each (see `../errors.ts`). */
export const LOANS_BANK_ERRORS = {
  /** Collateral lock or excess release omitted a caller-stable event id. MAX+1 on omit made a retry a second post. */
  'bank.event_id_required': 'BAD_REQUEST',
  'bank.loan_product_not_found': 'NOT_FOUND',
  'bank.loan_product_closed': 'CONFLICT',
  'bank.loan_not_found': 'NOT_FOUND',
  'bank.loan_closed': 'CONFLICT',
  /** Repay refused while a liquidation shortfall is still uncovering insurance. */
  'bank.loan_liquidating': 'CONFLICT',
  /** Loan repay omitted a caller-stable event id. A new sequence made a retry a second loanRepay. */
  'bank.repayment_id_required': 'BAD_REQUEST',
  /** Draw refused because the loan is not in `pending` — the ordering guard. */
  'bank.loan_not_drawable': 'CONFLICT',
  // The last attempt on a pending loan is inside the in-flight bound: wait.
  /**
   * Abandon refused: the last post attempt on this pending loan is inside the
   * in-flight bound, so the ledger could still commit it. Wait, then retry.
   */
  'bank.loan_attempt_too_recent': 'CONFLICT',
  /**
   * A retry reused a loan id but changed the opening collateral amount.
   *
   * Sibling of `bank.loan_principal_mismatch`. Principal alone is not "same
   * terms": after a failed first lock the row still holds the first principal,
   * and a retry that names less collateral can pass LTV on the new figure then
   * lock dust while the draw still pays the original principal. Same id must
   * mean the same pledge.
   */
  'bank.loan_collateral_mismatch': 'CONFLICT',
  // The same class for the borrower half and for earn. All three name only
  // the id the caller already holds — never who the existing record belongs
  // to — so FORBIDDEN would be both wrong and more disclosing.
  /**
   * A retry reused a loan id that belongs to a different borrower, or names a
   * different product.
   *
   * The sibling of `bank.loan_principal_mismatch` and the same reasoning: the
   * guards run on the new input while the row is the first call's. Hold the
   * principal equal and a second caller was answered out of somebody else's
   * loan — told it was open with none of their own value moved, or, on a
   * `pending` row, driving that borrower's loan with this caller's collateral
   * figure.
   */
  'bank.loan_borrower_mismatch': 'CONFLICT',
  /** Borrower short of collateral at open — same class as ltv_exceeded. */
  /**
   * Borrower cannot fund the collateral lock at open. Distinct from
   * `bank.loan_reserve_underfunded` (platform short) and from a raw
   * `ledger.insufficient_funds` (which would leak past open() and mask the
   * principal-mismatch refusal on a retried id).
   */
  'bank.loan_collateral_short': 'BAD_REQUEST',

  // ── Loans: refusals that are NOT the caller's fault ───────────────────
  //
  // Each of these is the platform declining to act, and every one of them
  // would be a lie as a 400. A borrower told "bad request" when the lending
  // reserve is empty, or when the price feed is too stale to seize collateral
  // on, will retry the request forever and learn nothing.
  /**
   * The lending reserve cannot fund this draw. An operator alarm, not a user
   * error, and deliberately distinct from `ledger.insufficient_funds`: one means
   * the borrower is short, the other means the platform is.
   */
  'bank.loan_reserve_underfunded': 'PRECONDITION_FAILED',

  // Ordering refusals. Genuinely the caller's request being wrong for the
  // current state of the loan, so 409 rather than 400: nothing about the
  // input is malformed, and the same request may succeed later.
  /** Collateral release refused while debt is outstanding. The important one. */
  'bank.loan_not_settled': 'CONFLICT',
  /**
   * Liquidation refused because no margin call has been raised or its grace has
   * not expired. §8.1's ordering, as a refusal.
   */
  'bank.margin_call_required': 'CONFLICT',
  /** Product thresholds are not ordered coherently. */
  'bank.policy_incoherent': 'INTERNAL_SERVER_ERROR',
  /** Accrual has not run for so long that compounding the backlog needs a human. */
  'bank.accrual_backlog': 'PRECONDITION_FAILED',
  /** Liquidation needs a funded counterparty and there is none. */
  'bank.no_liquidation_counterparty': 'PRECONDITION_FAILED',
  /**
   * Collateral is marked in the quote asset and the debt is a different asset.
   * Booking mark × quantity as debt would invent a conversion. Seizure refuses
   * before any ledger post. A same-asset quote may still sell at the mark.
   */
  'bank.loan_seizure_cross_asset': 'PRECONDITION_FAILED',

  // The loudest one. Collateral was exhausted and the insurance fund could
  // not make the reserve whole — a platform-side loss, not a client error.
  /**
   * Collateral was exhausted without clearing the debt AND the insurance fund
   * could not cover it. The loudest code in this file.
   */
  'bank.bad_debt_uncovered': 'INTERNAL_SERVER_ERROR',
  /**
   * Module kill for loans (`BANK_LOANS_ENABLED=false` / FLAG_REGISTRY bank.loans).
   * New opens refuse; job kills stay on their own env vars.
   */
  'bank.loans_disabled': 'SERVICE_UNAVAILABLE',
  /** Operator loan product terms are blank, out of range or out of LTV order (BK-loan-02). */
  'bank.loan_params_invalid': 'BAD_REQUEST',
  /** A product id was reused with different terms. */
  'bank.loan_product_conflict': 'CONFLICT',
  /** A non-zero loan payoff fee is published, but repay has no fee entry to collect it, so no payoff quote is given (BK-loan-06). */
  'bank.loan_fee_unsupported': 'PRECONDITION_FAILED',
  /** The product's rate is not the one the borrower was shown: no loan is opened at a rate they did not see. */
  'bank.loan_rate_changed': 'CONFLICT',
  /** A rate change replaces a rate the product no longer charges: read the product again. */
  'bank.loan_rate_moved': 'CONFLICT',
  /** An approval that already made one rate change was offered for another. */
  'bank.loan_rate_approval_reused': 'CONFLICT',
  /** The loan's snapshotted rate cannot be used, so a projection is refused rather than invented (BK-loan-06). */
  'bank.loan_terms_missing': 'PRECONDITION_FAILED',
  /** An interest correction is not in shape: a zero or malformed amount, or a reason under 3 or over 500 characters (LOAN-05). */
  'bank.correction_invalid': 'BAD_REQUEST',
  /** A correction that takes off more interest than the loan owes now; paid interest is never given back by a correction (LOAN-05). */
  'bank.correction_exceeds_interest': 'CONFLICT',
  /** A correction id already used with other terms (loan, amount or reason). The first row stands (LOAN-05). */
  'bank.correction_conflict': 'CONFLICT',
} as const satisfies BankErrorTable;
