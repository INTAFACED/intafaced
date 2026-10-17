/**
 * HOLD (money safety): retrying a failed settlement payout can still double-send on main, because the payout call is not
 * yet once-only. Until PAYOUTONCE (the lead's once-only payout change) lands, the portal offers no retry path: the
 * "Try this payout again" button is gone, failed settlements are not in the payout picker, and a failed payout is shown
 * read-only with a pointer to support. Flip this to `true` only after PAYOUTONCE is merged and verified.
 */
export const PAYOUT_RETRY_ENABLED = false;
