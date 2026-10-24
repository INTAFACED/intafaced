import type { AccountLine } from './ledger-reads.js';

/**
 * WITHDRAWALS (LB-4). Coins the customer sends out of the platform leave the available balance in one transaction
 * (`withdraw.held`, into that withdrawal's own hold) and leave the book when the rail settles. For the lot book they are
 * gone from the moment they are held: the hold is on its way out, so it is not counted as held either. A rail that fails
 * puts the same amount back on available (`withdraw.reversed`, in a later transaction): that withdrawal did not happen, so
 * the two lines cancel and neither reaches the book.
 *
 * The two lines share no transaction, so a return is paired with the latest earlier withdrawal of the same coin and the
 * same amount that is not yet paired (the recipe returns exactly what it held).
 */
export const WITHDRAW_HELD = 'withdraw.held';

/** A hold account purpose for one withdrawal in flight (`withdrawalHoldAccount`). */
export const WITHDRAWAL_HOLD_PREFIX = 'withdraw:';

export function outsideWithdrawals(outflows: readonly AccountLine[], returns: readonly AccountLine[]): AccountLine[] {
  const held = outflows
    .filter((l) => l.reason === WITHDRAW_HELD && l.direction === 'credit')
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.txId.localeCompare(b.txId));
  const cancelled = new Set<AccountLine>();
  const back = [...returns].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime() || a.txId.localeCompare(b.txId));
  for (const ret of back) {
    for (let i = held.length - 1; i >= 0; i--) {
      const out = held[i]!;
      if (cancelled.has(out) || out.assetId !== ret.assetId || out.amount !== ret.amount) continue;
      if (out.postedAt.getTime() > ret.postedAt.getTime()) continue;
      cancelled.add(out);
      break;
    }
  }
  return held.filter((l) => !cancelled.has(l));
}
