/**
 * Refuse a child slice when session credit is blank.
 * Residual stays on the parent. No invented limit. Slice itself is
 * sliceLiveAlgoParent. Does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { sliceLiveAlgoParent, type OmsSliceResult } from './oms-slice.js';

export type OmsSliceCreditRefuse =
  | { readonly ok: false; readonly reason: 'credit_blank'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'credit_invalid'; readonly detail: string };

export type OmsSliceWithSessionCreditResult = OmsSliceResult | OmsSliceCreditRefuse;

function refuseCredit(reason: OmsSliceCreditRefuse['reason'], detail: string): OmsSliceCreditRefuse {
  return { ok: false, reason, detail };
}

function parseSessionCredit(raw: string | null | undefined): { ok: true } | OmsSliceCreditRefuse {
  if (raw === null || raw === undefined) {
    return refuseCredit('credit_blank', 'session credit is blank — refuse rather than invent a limit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuseCredit('credit_blank', 'session credit is blank — refuse rather than invent a limit');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuseCredit('credit_invalid', 'session credit must be a non-negative ledger amount — not invented');
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuseCredit('credit_invalid', `session credit is not a ledger amount: ${message}`);
  }
}

/**
 * Submit one child slice only when session credit is present.
 * Blank credit refuses before slice — residual stays on the parent.
 */
export async function sliceLiveAlgoParentWithSessionCredit(
  input: Parameters<typeof sliceLiveAlgoParent>[0] & {
    readonly credit: string | null | undefined;
  },
): Promise<OmsSliceWithSessionCreditResult> {
  const credit = parseSessionCredit(input.credit);
  if (!credit.ok) return credit;
  const { credit: _ignored, ...sliceInput } = input;
  return sliceLiveAlgoParent(sliceInput);
}
