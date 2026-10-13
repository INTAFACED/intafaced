/**
 * Worst-case pre-trade risk refuses if buying-power path unset.
 * Live slice stays oms-slice.ts (twap|vwap|pov). This wraps it — do not dual-implement.
 * Scale / IS / sniper / trailing paper stays paper. No invented buying power.
 */
import { parseAmount, formatAmount, ZERO } from '@intafaced/ledger-client';
import { sliceLiveAlgoParent, type OmsSliceResult } from './oms-slice.js';

export type OmsBuyingPowerRefuseReason = 'buying_power_unset';

export type OmsBuyingPowerRefusal = {
  readonly ok: false;
  readonly reason: OmsBuyingPowerRefuseReason;
  readonly detail: string;
};

function refuseUnset(detail: string): OmsBuyingPowerRefusal {
  return { ok: false, reason: 'buying_power_unset', detail };
}

/** Missing/blank/invalid/non-string buying power refuses — never invent a limit. */
export function refuseUnsetBuyingPower(raw: unknown): OmsBuyingPowerRefusal | { readonly ok: true; readonly buyingPower: string } {
  if (typeof raw !== 'string') {
    return refuseUnset('buying-power path is unset — refusing worst-case pre-trade risk rather than inventing buying power');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuseUnset('buying-power path is unset — refusing worst-case pre-trade risk rather than inventing buying power');
  }
  try {
    const value = parseAmount(text);
    if (value <= ZERO) {
      return refuseUnset('buying power must be a positive ledger amount — refusing to invent buying power');
    }
    return { ok: true, buyingPower: formatAmount(value) };
  } catch {
    return refuseUnset('buying power is not a ledger amount — refusing to invent buying power');
  }
}

export type OmsSliceWithBuyingPowerResult = OmsSliceResult | OmsBuyingPowerRefusal;

/** Slice one live TWAP/VWAP/POV child only when buying power is set. Blank refuses before slice. */
export async function sliceLiveAlgoParentWithBuyingPower(
  input: Parameters<typeof sliceLiveAlgoParent>[0] & {
    readonly buyingPower?: string | null;
  },
): Promise<OmsSliceWithBuyingPowerResult> {
  const buyingPower = refuseUnsetBuyingPower(input.buyingPower);
  if (!buyingPower.ok) return buyingPower;
  const { buyingPower: _ignored, ...sliceInput } = input;
  return sliceLiveAlgoParent(sliceInput);
}
