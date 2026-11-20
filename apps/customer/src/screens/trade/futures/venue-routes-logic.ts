import { parseAmount } from '../../../shared/money';

/**
 * Whether Confirm on a routed order needs our builder-fee approval first (J-derivatives-28 #3, #8). Pure, so each case
 * is tested on its own.
 *
 * - `not_needed`: the order carries no builder fee.
 * - `reading`: the venue's own record of the approval has not answered yet. That is neither approved nor not approved,
 *   so Confirm waits rather than asking for an approval the person may already have signed.
 * - `approved`: the venue holds an approval of at least our published fee.
 * - `needed`: the venue holds less, our fee is not published, or the read failed.
 */
export type ApprovalState = 'not_needed' | 'reading' | 'approved' | 'needed';

export function approvalState(
  carries: boolean,
  feeBps: string | null,
  read: { readonly approved: string | null; readonly failed: boolean },
): ApprovalState {
  if (!carries) return 'not_needed';
  if (read.approved === null) return read.failed ? 'needed' : 'reading';
  return feeBps !== null && parseAmount(read.approved) >= parseAmount(feeBps) ? 'approved' : 'needed';
}
