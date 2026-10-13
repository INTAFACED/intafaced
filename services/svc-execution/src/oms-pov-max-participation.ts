/**
 * Refuse a POV parent when owner max participation is blank.
 * Max participation is integer bps. Missing/blank/invalid refuses — this
 * never invents a rate. Approve itself is approveAlgoParent.
 * TWAP/VWAP are not gated. Does not touch matching.
 */
import { approveAlgoParent, type OmsApproveResult } from './oms-approve.js';
import type { AlgoKind } from './oms-start.js';

export type OmsPovMaxParticipationRefuse =
  | { readonly ok: false; readonly reason: 'max_participation_blank'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'max_participation_invalid'; readonly detail: string };

export type OmsApproveWithMaxParticipationResult = OmsApproveResult | OmsPovMaxParticipationRefuse;

function refuseMax(reason: OmsPovMaxParticipationRefuse['reason'], detail: string): OmsPovMaxParticipationRefuse {
  return { ok: false, reason, detail };
}

function parseMaxParticipationBps(raw: number | null | undefined): { ok: true } | OmsPovMaxParticipationRefuse {
  if (raw === null || raw === undefined) {
    return refuseMax('max_participation_blank', 'max participation is blank — refuse rather than invent a POV rate');
  }
  if (!Number.isInteger(raw) || raw < 0) {
    return refuseMax('max_participation_invalid', 'max participation must be a non-negative integer bps — not invented');
  }
  return { ok: true };
}

function resolvedKind(input: Parameters<typeof approveAlgoParent>[0]): AlgoKind | string | undefined {
  const fromInput = input.kind;
  if (fromInput === 'twap' || fromInput === 'vwap' || fromInput === 'pov') return fromInput;
  const id = input.parentClientOrderId?.trim() ?? '';
  if (!id || !input.parentStore) return fromInput;
  return input.parentStore.get(id)?.kind ?? fromInput;
}

/**
 * Approve a POV parent only when owner max participation is present.
 * Blank max refuses before approve — no parent row is written.
 */
export function approveAlgoParentWithMaxParticipation(
  input: Parameters<typeof approveAlgoParent>[0] & {
    readonly maxParticipationBps: number | null | undefined;
  },
): OmsApproveWithMaxParticipationResult {
  if (resolvedKind(input) === 'pov') {
    const max = parseMaxParticipationBps(input.maxParticipationBps);
    if (!max.ok) return max;
  }
  const { maxParticipationBps: _ignored, ...approveInput } = input;
  return approveAlgoParent(approveInput);
}
