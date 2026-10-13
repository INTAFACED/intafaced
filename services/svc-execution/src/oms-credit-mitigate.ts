/**
 * In-flight mitigation: cancel remaining children of one parent when
 * owner credit is breached. Residual stays on the parent. Refuse if
 * credit is blank. No invented limit. Does not submit to matching.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { VenueKind } from '@intafaced/venue-adapter';
import { cancelRemainingParentChildren, type OmsCancelRemainingInput } from './oms-cancel-remaining.js';
import type { OmsDrainChild, OmsDrainResidual } from './oms-drain.js';
import type { OmsCancelFn } from './oms-cancel.js';
import type { EmsOrderStore } from './oms-ems-store.js';
import type { ApprovedAlgoParentStore } from './oms-start.js';

export type OmsCreditMitigateInput = {
  readonly parentClientOrderId?: string;
  readonly executionGroupId?: string;
  /** Owner credit limit as a ledger decimal string. Blank refuses. */
  readonly credit: string | null | undefined;
  /** Caller-supplied used credit as a ledger decimal string. Blank refuses. */
  readonly usedCredit: string | null | undefined;
  readonly cancelByVenue?: Readonly<Record<string, OmsCancelFn>>;
  readonly emsStore?: EmsOrderStore;
  readonly kindsByVenue?: Readonly<Record<string, VenueKind>>;
  /** Optional. When present, residual must remain on the parent after cancel. */
  readonly parentStore?: ApprovedAlgoParentStore;
};

export type OmsCreditMitigateRefuseReason =
  'credit_blank' | 'credit_invalid' | 'used_credit_blank' | 'used_credit_invalid' | 'missing_parent' | 'parent_only' | 'ems_store_unwired';

export type OmsCreditMitigateRefusal = {
  readonly ok: false;
  readonly reason: OmsCreditMitigateRefuseReason;
  readonly detail: string;
};

export type OmsCreditMitigateClear = {
  readonly ok: true;
  readonly breached: false;
  readonly parent: { readonly parentClientOrderId: string };
  readonly credit: string;
  readonly usedCredit: string;
  readonly children: readonly [];
  readonly residual: { readonly remaining: string | null };
};

export type OmsCreditMitigateCancelled = {
  readonly ok: true;
  readonly breached: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly credit: string;
  readonly usedCredit: string;
  readonly children: readonly OmsDrainChild[];
  readonly residual: OmsDrainResidual;
};

export type OmsCreditMitigateResult = OmsCreditMitigateClear | OmsCreditMitigateCancelled | OmsCreditMitigateRefusal;

function refuse(reason: OmsCreditMitigateRefuseReason, detail: string): OmsCreditMitigateRefusal {
  return { ok: false, reason, detail };
}

function parseLedger(
  raw: string | null | undefined,
  blank: 'credit_blank' | 'used_credit_blank',
  invalid: 'credit_invalid' | 'used_credit_invalid',
  label: string,
): { ok: true; value: Amount; text: string } | OmsCreditMitigateRefusal {
  if (raw === null || raw === undefined) {
    return refuse(blank, `${label} is blank — refuse rather than invent a limit`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse(blank, `${label} is blank — refuse rather than invent a limit`);
  }
  try {
    const value = parseAmount(text);
    if (value < 0n) {
      return refuse(invalid, `${label} must be a non-negative ledger amount — not invented`);
    }
    return { ok: true, value, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse(invalid, `${label} is not a ledger amount: ${message}`);
  }
}

function parentResidualRemaining(parentStore: ApprovedAlgoParentStore | undefined, parentClientOrderId: string): string | null {
  if (!parentStore) return null;
  const row = parentStore.get(parentClientOrderId);
  const remaining = row?.residual?.remaining?.trim() ?? '';
  return remaining || null;
}

/**
 * Cancel remaining children of one parent when used credit exceeds owner credit.
 * Equality is not a breach. Residual stays on the parent — never released here.
 */
export async function cancelRemainingOnCreditBreach(input: OmsCreditMitigateInput): Promise<OmsCreditMitigateResult> {
  const executionGroupId = input.executionGroupId?.trim() ?? '';
  if (executionGroupId) {
    return refuse('parent_only', 'mitigate exactly one parentClientOrderId');
  }
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }

  const credit = parseLedger(input.credit, 'credit_blank', 'credit_invalid', 'credit');
  if (!credit.ok) return credit;
  const used = parseLedger(input.usedCredit, 'used_credit_blank', 'used_credit_invalid', 'usedCredit');
  if (!used.ok) return used;

  if (used.value <= credit.value) {
    return {
      ok: true,
      breached: false,
      parent: { parentClientOrderId },
      credit: credit.text,
      usedCredit: used.text,
      children: [],
      residual: { remaining: parentResidualRemaining(input.parentStore, parentClientOrderId) },
    };
  }

  const cancelled = await cancelRemainingParentChildren({
    parentClientOrderId,
    cancelByVenue: input.cancelByVenue,
    emsStore: input.emsStore,
    kindsByVenue: input.kindsByVenue,
  } satisfies OmsCancelRemainingInput);

  if (!cancelled.ok) {
    return { ok: false, reason: cancelled.reason, detail: cancelled.detail };
  }

  return {
    ok: true,
    breached: true,
    parent: cancelled.parent,
    credit: credit.text,
    usedCredit: used.text,
    children: cancelled.children,
    residual: cancelled.residual,
  };
}
