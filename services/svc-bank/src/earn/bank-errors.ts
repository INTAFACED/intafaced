import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `earn/` throws, and what a caller is told for each (see `../errors.ts`). */
export const EARN_BANK_ERRORS = {
  'bank.pool_not_found': 'NOT_FOUND',
  /** An ops pool create reused a pool id with different terms: a new pool needs a new id. */
  'bank.pool_conflict': 'CONFLICT',
  /** A pool status change that names the status already in force records nothing, and spends no approval (BK-earn-04). */
  'bank.pool_status_unchanged': 'CONFLICT',
  /** A pool status change whose revision is not the pool's next one: another change landed first (BK-earn-04). */
  'bank.pool_status_stale': 'CONFLICT',
  /** A take back from a staking-style pool that did not confirm the unbonding it starts (BK-earn-04). */
  'bank.unbond_not_confirmed': 'BAD_REQUEST',
  /** A plain take back of a saving that is still unbonding; it is released when the unbonding ends (BK-earn-04). */
  'bank.position_unbonding': 'CONFLICT',
  /** A release of an ended unbonding failed for a reason without its own code; the next run tries again. */
  'bank.earn_release_failed': 'INTERNAL_SERVER_ERROR',
  /**
   * No open pool carries an operator-configured APR for the requested earn
   * surface. Empty does not mean zero yield: the product refuses rather than
   * inventing a plausible default rate.
   */
  'bank.earn_rate_unset': 'PRECONDITION_FAILED',
  'bank.native_asset_not_earnable': 'BAD_REQUEST',
  'bank.position_not_found': 'NOT_FOUND',
  'bank.position_closed': 'CONFLICT',
  'bank.position_locked': 'CONFLICT',
  /**
   * A deposit reused a position id that is already taken by a different one —
   * another user, another pool, or another amount.
   *
   * `bank.loan_principal_mismatch`, for earn. The insert is `ON CONFLICT (id)
   * DO NOTHING`, so without this the second deposit runs against the first
   * one's row: the ledger moves the second caller's value into a stake pot
   * keyed by their own id, the row that gets activated is the first caller's,
   * and `principalOf()` and `stakedOf()` — the two answers this service gives
   * to "how much is staked" — stop agreeing. Same id must mean same deposit.
   */
  'bank.position_conflict': 'CONFLICT',
  /** Earn deposit omitted a caller-stable position id. Minting a UUID made a retry a second stake. */
  'bank.position_id_required': 'BAD_REQUEST',
  /**
   * Withdraw (or other active-only action) refused while the deposit claim is
   * still `pending` — ledger may have posted, activate may not have. Resume the
   * claim first; do not close a half-open position under the operator's feet.
   */
  'bank.position_pending': 'CONFLICT',
  /** Auto-renew asked of a flexible saving, or a pool with no term to renew for: only a fixed-term saving renews. */
  'bank.auto_renew_fixed_only': 'BAD_REQUEST',
  /** Auto-renew turned on after the saving's term ended: a term that is over does not renew; take it back or save again. */
  'bank.position_matured': 'CONFLICT',
  /** Identity answers the saver's account is frozen, closed or unknown, so the renewal job starts no new term. */
  'bank.account_not_active': 'CONFLICT',
  /** One saving's renewal failed for a reason with no code of its own; the job reports it and carries on. */
  'bank.earn_renew_failed': 'INTERNAL_SERVER_ERROR',
  /**
   * earn_positions.principal disagrees with the ledger earn stake pot.
   * The table is eligibility (who, which pool, `active`); the money is
   * ledger-client. Accrue, principalOf, and poolSize refuse rather than size
   * from a stale column.
   */
  'bank.earn_principal_mismatch': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
