/**
 * Refuse a VWAP parent when owner target volume is blank.
 * Target volume is a ledger amount. Missing/blank/invalid refuses — this
 * never invents size from duration or slicesPlanned. Approve itself is
 * approveAlgoParent. TWAP/POV are not gated. Does not touch matching.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { approveAlgoParent, type OmsApproveResult } from './oms-approve.js';
import type { AlgoKind } from './oms-start.js';

export type OmsVwapTargetVolumeRefuse =
  | { readonly ok: false; readonly reason: 'target_volume_blank'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'target_volume_invalid'; readonly detail: string };

export type OmsApproveWithVwapTargetVolumeResult = OmsApproveResult | OmsVwapTargetVolumeRefuse;

function refuseVolume(reason: OmsVwapTargetVolumeRefuse['reason'], detail: string): OmsVwapTargetVolumeRefuse {
  return { ok: false, reason, detail };
}

function parseTargetVolume(raw: string | null | undefined): { ok: true } | OmsVwapTargetVolumeRefuse {
  if (raw === null || raw === undefined) {
    return refuseVolume('target_volume_blank', 'VWAP target volume is blank — refuse rather than invent size');
  }
  const text = raw.trim();
  if (text.length === 0) {
    return refuseVolume('target_volume_blank', 'VWAP target volume is blank — refuse rather than invent size');
  }
  try {
    const value = parseAmount(text);
    if (value <= 0n) {
      return refuseVolume('target_volume_invalid', 'VWAP target volume must be a positive ledger amount — not invented');
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuseVolume('target_volume_invalid', `VWAP target volume is not a ledger amount: ${message}`);
  }
}

function resolvedKind(input: Parameters<typeof approveAlgoParent>[0]): AlgoKind | string | undefined {
  const fromInput = input.kind;
  if (fromInput === 'twap' || fromInput === 'vwap' || fromInput === 'pov') return fromInput;
  const id = input.parentClientOrderId?.trim() ?? '';
  if (!id || !input.parentStore) return fromInput;
  return input.parentStore.get(id)?.kind ?? fromInput;
}

/**
 * Approve a VWAP parent only when owner target volume is present.
 * Blank volume refuses before approve — no parent row is written,
 * and size is never invented from duration or slicesPlanned.
 */
export function approveAlgoParentWithVwapTargetVolume(
  input: Parameters<typeof approveAlgoParent>[0] & {
    readonly targetVolume: string | null | undefined;
  },
): OmsApproveWithVwapTargetVolumeResult {
  if (resolvedKind(input) === 'vwap') {
    const volume = parseTargetVolume(input.targetVolume);
    if (!volume.ok) return volume;
  }
  const { targetVolume: _ignored, ...approveInput } = input;
  return approveAlgoParent(approveInput);
}
