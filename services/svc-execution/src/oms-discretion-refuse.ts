/**
 * Care-desk discretion caps are OWNER-SET. Unset refuses rather than
 * inventing a desk limit. Manual fill stays mill (ledger qty/price strings,
 * permissioned confirmer) — never a sidecar balance. router.ts is not recut.
 */
import { parseAmount, formatAmount, ZERO } from '@intafaced/ledger-client';

export type OmsDiscretionRefuseReason = 'discretion_unset';

export type OmsDiscretionRefusal = {
  readonly ok: false;
  readonly reason: OmsDiscretionRefuseReason;
  readonly detail: string;
};

function refuseUnset(detail: string): OmsDiscretionRefusal {
  return { ok: false, reason: 'discretion_unset', detail };
}

/** Missing/blank/invalid discretion cap refuses — never invent a desk limit. */
export function refuseUnsetDiscretionCap(
  raw: string | null | undefined,
): OmsDiscretionRefusal | { readonly ok: true; readonly discretionCap: string } {
  if (raw === undefined || raw === null) {
    return refuseUnset('discretion cap is unset — refusing rather than inventing a care-desk limit');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuseUnset('discretion cap is unset — refusing rather than inventing a care-desk limit');
  }
  try {
    const value = parseAmount(text);
    if (value <= ZERO) {
      return refuseUnset('discretion cap must be a positive ledger amount — refusing to invent a limit');
    }
    return { ok: true, discretionCap: formatAmount(value) };
  } catch {
    return refuseUnset('discretion cap is not a ledger amount — refusing to invent a limit');
  }
}
