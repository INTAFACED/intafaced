/**
 * Live OMS display-qty that is not matching iceberg refuses.
 * Matching `book.ts` already installs iceberg — do not dual-implement.
 * C03: iceberg is not a sold OMS product. Paper iceberg stays paper.
 */
import { parseAmount } from '@intafaced/ledger-client';

export type OmsIcebergDisplayRefuseReason = 'not_matching_iceberg';

export type OmsIcebergDisplayRefusal = {
  readonly ok: false;
  readonly reason: OmsIcebergDisplayRefuseReason;
  readonly detail: string;
};

function wantsLiveOmsIceberg(input: {
  readonly iceberg?: boolean;
  readonly displayQty?: string | null;
  readonly kind?: string | null;
}): boolean {
  if (input.iceberg === true) return true;
  if (input.kind === 'iceberg') return true;
  if (input.displayQty === undefined || input.displayQty === null) return false;
  return input.displayQty.trim().length > 0;
}

/**
 * Live OMS iceberg/display-qty is not matching iceberg.
 * Refuse rather than silently full-display the hidden qty.
 */
export function refuseLiveOmsIcebergDisplay(input: {
  readonly iceberg?: boolean;
  readonly displayQty?: string | null;
  readonly kind?: string | null;
}): OmsIcebergDisplayRefusal | null {
  if (!wantsLiveOmsIceberg(input)) return null;
  const raw = input.displayQty;
  if (raw !== undefined && raw !== null && raw.trim().length > 0) {
    try {
      parseAmount(raw);
    } catch {
      return {
        ok: false,
        reason: 'not_matching_iceberg',
        detail: 'OMS display qty is not a ledger amount — refusing rather than silently full-display',
      };
    }
  }
  return {
    ok: false,
    reason: 'not_matching_iceberg',
    detail: 'live OMS iceberg/display-qty is not matching iceberg — refusing rather than silently full-display',
  };
}
