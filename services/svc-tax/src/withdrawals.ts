import type { AccountLine, WithdrawalHold } from './ledger-reads.js';

/**
 * WITHDRAWALS (LB-4). Coins the customer sends out of the platform leave the available balance into that withdrawal's
 * own hold account (`withdraw.held`, purpose `withdraw:<id>`) and leave the book when the rail settles (`withdraw.settled`).
 * For the lot book they are gone from the moment they are held: the hold is on its way out, so it is not counted as held
 * either. What the rail does not take goes back to available from the same hold (`withdraw.reversed`): all of it when the
 * rail failed, or the rest when it took only part (a card capture smaller than its authorisation). That part did not leave.
 *
 * Every line of one withdrawal sits on its own hold account, so the lines pair by account: never by amount or time, and
 * two withdrawals in flight at once never cancel each other. What left is what was held less what came back, at the
 * moment it was held.
 */
export const WITHDRAW_HELD = 'withdraw.held';
export const WITHDRAW_REVERSED = 'withdraw.reversed';

/** A hold account purpose for one withdrawal in flight (`withdrawalHoldAccount`). */
export const WITHDRAWAL_HOLD_PREFIX = 'withdraw:';

const byTime = (a: AccountLine, b: AccountLine) => a.postedAt.getTime() - b.postedAt.getTime() || a.txId.localeCompare(b.txId);

export function outsideWithdrawals(holds: readonly WithdrawalHold[]): AccountLine[] {
  const out: AccountLine[] = [];
  for (const hold of holds) {
    if (!hold.purpose.startsWith(WITHDRAWAL_HOLD_PREFIX)) continue;
    // On the hold account, value in is a debit (held) and value out a credit (settled or put back).
    const held = hold.lines.filter((l) => l.reason === WITHDRAW_HELD && l.direction === 'debit').sort(byTime);
    let back = hold.lines.filter((l) => l.reason === WITHDRAW_REVERSED && l.direction === 'credit').reduce((sum, l) => sum + l.amount, 0n);
    // What came back is taken off the latest held line first (a recipe holds once per withdrawal; this keeps a second
    // hold on the same account honest too).
    const left = held.map((line) => ({ ...line }));
    for (let i = left.length - 1; i >= 0 && back > 0n; i--) {
      const take = left[i]!.amount < back ? left[i]!.amount : back;
      left[i] = { ...left[i]!, amount: left[i]!.amount - take };
      back -= take;
    }
    out.push(...left.filter((line) => line.amount > 0n));
  }
  return out.sort(byTime);
}
