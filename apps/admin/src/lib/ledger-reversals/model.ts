/**
 * The console's view of operator reversals (OPS-ledger-desk-02, J-ops-console-05 #1-#3). Pure, so the browser and the
 * server read them the same way.
 *
 * One founder asks svc-ops to reverse a posted transaction with a reason and a case reference: svc-ops writes the intent row
 * and nothing posts. A different founder approves exactly that request at identity; the founder who asked runs it, and the
 * ledger books one linked compensating transaction built from the stored original.
 */
import type { OpsLedgerReversal, OpsReversalState } from '@intafaced/contracts/ops-ledger-reversals';
import { CASE_REF, REASON_MAX, REASON_MIN } from '@/lib/approval-fields';

export type { OpsLedgerReversal };

/** The reversal of an original that stands: one that posted here, or the one the ledger named refusing one of ours. */
export interface FirstReversal {
  readonly requestNo: string;
  readonly reversingTxId: string;
}

export function firstReversalOf(reversals: readonly OpsLedgerReversal[]): FirstReversal | null {
  const posted = reversals.find((r) => r.state === 'posted' && r.reversingTxId !== null);
  if (posted) return { requestNo: posted.requestNo, reversingTxId: posted.reversingTxId! };
  const named = reversals.find((r) => r.state === 'refused' && r.reversedBy !== null);
  return named ? { requestNo: named.requestNo, reversingTxId: named.reversedBy! } : null;
}

/** What a founder typed to ask for a reversal, checked as svc-ops and the approval packet check it; or why not. */
export function reversalAsk(reason: string, caseRef: string): { ok: true; reason: string; caseRef: string } | { ok: false; why: string } {
  const r = reason.trim();
  const c = caseRef.trim();
  if (r.length < REASON_MIN) return { ok: false, why: `Write the reason first (at least ${REASON_MIN} characters).` };
  if (r.length > REASON_MAX) return { ok: false, why: `The reason is too long (at most ${REASON_MAX} characters).` };
  if (!CASE_REF.test(c)) return { ok: false, why: 'Give the case reference: 1 to 128 printable characters.' };
  return { ok: true, reason: r, caseRef: c };
}

const STATE_WORDS: Readonly<Record<OpsReversalState, string>> = {
  intent: 'intent: waiting for a different founder to approve; nothing has posted',
  posting: 'posting: approved and sent to the ledger',
  pending_retry: 'pending retry: the ledger has not answered; the same request is sent again',
  posted: 'posted',
  refused: 'refused by the ledger',
};

export function reversalStateWords(state: OpsReversalState): string {
  return STATE_WORDS[state];
}
