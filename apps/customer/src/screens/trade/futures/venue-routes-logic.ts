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

/**
 * The approval state Confirm acts on. The poll's answer may be a read that failed, or older than an
 * approval just signed: unless it already shows the approval held, Confirm reads the venue once more and decides from
 * that read, so a passing network error never asks the person to sign an approval they already hold. A fresh read that
 * fails too still means `needed`: nothing is sent without a known approval.
 */
export async function approvalAtConfirm(
  carries: boolean,
  feeBps: string | null,
  polled: ApprovalState,
  readAgain: () => Promise<{ readonly ok: true; readonly data: { readonly value: string } } | { readonly ok: false }>,
): Promise<ApprovalState> {
  if (polled === 'approved' || polled === 'not_needed') return polled;
  const fresh = carries ? await readAgain() : null;
  return approvalState(carries, feeBps, {
    approved: fresh?.ok ? fresh.data.value : null,
    failed: fresh !== null && !fresh.ok,
  });
}
