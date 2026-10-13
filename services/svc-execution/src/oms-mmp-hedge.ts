/**
 * Hedge remaining inventory after an MMP fill.
 * Caller hedge size is required. Residual stays on the parent — never
 * consumed or released here. Refuse if hedge size is blank. Never invent
 * size from the fill or a book. Does not submit to matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import type { ApprovedAlgoParentStore } from './oms-start.js';

export type OmsMmpHedgeRefuseReason = 'missing_parent' | 'hedge_size_blank' | 'hedge_size_invalid';

export type OmsMmpHedgeRefusal = {
  readonly ok: false;
  readonly reason: OmsMmpHedgeRefuseReason;
  readonly detail: string;
};

export type OmsMmpHedgeAccepted = {
  readonly ok: true;
  readonly hedged: true;
  readonly parent: { readonly parentClientOrderId: string };
  readonly hedgeSize: string;
  readonly residual: { readonly remaining: string | null };
};

export type OmsMmpHedgeResult = OmsMmpHedgeAccepted | OmsMmpHedgeRefusal;

function refuse(reason: OmsMmpHedgeRefuseReason, detail: string): OmsMmpHedgeRefusal {
  return { ok: false, reason, detail };
}

function parseHedgeSize(raw: string | null | undefined): { ok: true; text: string } | OmsMmpHedgeRefusal {
  if (raw === null || raw === undefined) {
    return refuse('hedge_size_blank', 'hedge size is blank — refuse rather than invent size from the fill');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuse('hedge_size_blank', 'hedge size is blank — refuse rather than invent size from the fill');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuse('hedge_size_invalid', 'hedge size must be a positive ledger amount — not invented');
    }
    return { ok: true, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse('hedge_size_invalid', `hedge size is not a ledger amount: ${message}`);
  }
}

function parentRemaining(parentStore: ApprovedAlgoParentStore | undefined, parentClientOrderId: string): string | null {
  if (!parentStore) return null;
  const remaining = parentStore.get(parentClientOrderId)?.residual?.remaining?.trim() ?? '';
  return remaining || null;
}

/**
 * Plan a hedge of remaining inventory after an MMP fill using caller size.
 * Does not consume parent leftover and does not flatten.
 */
export function hedgeRemainingAfterMmpFill(input: {
  parentClientOrderId?: string;
  hedgeSize?: string | null;
  parentStore?: ApprovedAlgoParentStore;
}): OmsMmpHedgeResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  const size = parseHedgeSize(input.hedgeSize);
  if (!size.ok) return size;

  const remainingBefore = parentRemaining(input.parentStore, parentClientOrderId);
  return {
    ok: true,
    hedged: true,
    parent: { parentClientOrderId },
    hedgeSize: size.text,
    residual: { remaining: remainingBefore },
  };
}
