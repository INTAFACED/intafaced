/**
 * Refuse a TWAP parent when owner duration is blank.
 * Duration is integer milliseconds. Missing/blank/invalid refuses — this
 * never invents a schedule from slicesPlanned. Approve itself is
 * approveAlgoParent. VWAP/POV are not gated. Does not touch matching.
 */
import { approveAlgoParent, type OmsApproveResult } from './oms-approve.js';
import type { AlgoKind } from './oms-start.js';

export type OmsTwapDurationRefuse =
  | { readonly ok: false; readonly reason: 'duration_blank'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'duration_invalid'; readonly detail: string };

export type OmsApproveWithTwapDurationResult = OmsApproveResult | OmsTwapDurationRefuse;

function refuseDuration(reason: OmsTwapDurationRefuse['reason'], detail: string): OmsTwapDurationRefuse {
  return { ok: false, reason, detail };
}

function parseTwapDurationMs(raw: number | null | undefined): { ok: true; value: number } | OmsTwapDurationRefuse {
  if (raw === null || raw === undefined) {
    return refuseDuration('duration_blank', 'TWAP duration is blank — refuse rather than invent a schedule');
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    return refuseDuration('duration_invalid', 'TWAP duration must be a positive integer ms — not invented from slices');
  }
  return { ok: true, value: raw };
}

function resolvedKind(input: Parameters<typeof approveAlgoParent>[0]): AlgoKind | string | undefined {
  const fromInput = input.kind;
  if (fromInput === 'twap' || fromInput === 'vwap' || fromInput === 'pov') return fromInput;
  const id = input.parentClientOrderId?.trim() ?? '';
  if (!id || !input.parentStore) return fromInput;
  return input.parentStore.get(id)?.kind ?? fromInput;
}

/**
 * Approve a TWAP parent only when owner duration is present.
 * Blank duration refuses before approve — no parent row is written,
 * and duration is never invented from slicesPlanned * sliceIntervalMs.
 */
export function approveAlgoParentWithTwapDuration(
  input: Parameters<typeof approveAlgoParent>[0] & {
    readonly durationMs: number | null | undefined;
  },
): OmsApproveWithTwapDurationResult {
  if (resolvedKind(input) === 'twap') {
    const duration = parseTwapDurationMs(input.durationMs);
    if (!duration.ok) return duration;
    const { durationMs: ownerDuration, ...rest } = input;
    const schedule = rest.schedule ? { ...rest.schedule, durationMs: duration.value } : rest.schedule;
    return approveAlgoParent({ ...rest, schedule });
  }
  const { durationMs: _ignored, ...approveInput } = input;
  return approveAlgoParent(approveInput);
}
