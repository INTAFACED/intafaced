/**
 * Refuse to start a parent when pre-trade credit is blank.
 * Owner credit is a ledger amount. Missing/blank/invalid refuses — this
 * never invents a limit. Start itself is startApprovedAlgoParent.
 * Does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { startApprovedAlgoParent, type OmsStartResult } from './oms-start.js';

export type OmsStartCreditRefuse =
  | { readonly ok: false; readonly reason: 'credit_blank'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'credit_invalid'; readonly detail: string };

export type OmsStartWithPreTradeCreditResult = OmsStartResult | OmsStartCreditRefuse;

function refuseCredit(reason: OmsStartCreditRefuse['reason'], detail: string): OmsStartCreditRefuse {
  return { ok: false, reason, detail };
}

function parsePreTradeCredit(raw: string | null | undefined): { ok: true } | OmsStartCreditRefuse {
  if (raw === null || raw === undefined) {
    return refuseCredit('credit_blank', 'pre-trade credit is blank — refuse rather than invent a limit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuseCredit('credit_blank', 'pre-trade credit is blank — refuse rather than invent a limit');
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuseCredit('credit_invalid', 'pre-trade credit must be a non-negative ledger amount — not invented');
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuseCredit('credit_invalid', `pre-trade credit is not a ledger amount: ${message}`);
  }
}

/**
 * Start one already-approved parent only when owner pre-trade credit is present.
 * Blank credit refuses before start — parent stays approved.
 */
export function startApprovedAlgoParentWithPreTradeCredit(
  input: Parameters<typeof startApprovedAlgoParent>[0] & {
    readonly credit: string | null | undefined;
  },
): OmsStartWithPreTradeCreditResult {
  const credit = parsePreTradeCredit(input.credit);
  if (!credit.ok) return credit;
  const { credit: _ignored, ...startInput } = input;
  return startApprovedAlgoParent(startInput);
}
