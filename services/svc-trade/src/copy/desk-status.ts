/**
 * Customer copy desk read. Codes only. Sentences stay on copy.opsStatus.
 * Mounted and unmounted desks share this shape.
 */
import { z } from 'zod';
import { autoMirrorPlaceStatus, COPY_AUTO_MIRROR_PLACE_SOCKET, COPY_PLACE_DISABLED_RESIDUAL } from './auto-mirror-place.js';
import {
  COPY_DESK_BLOCKER_CODES,
  COPY_FEE_SHARE_RESIDUAL,
  COPY_JURISDICTION_RESIDUAL,
  type CopyDeskBlocker,
  type CopyDeskBlockerCode,
} from './errors.js';
import {
  copyLawResidual,
  copyLawStatusLine,
  UNPUBLISHED_COPY_FEE_SHARE_LAW,
  UNPUBLISHED_COPY_JURISDICTION_LAW,
  type CopyFeeShareLaw,
  type CopyJurisdictionLaw,
} from './fee-share-law.js';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { logCopyResidual } from './residual-log.js';

const SOVEREIGN = {
  shape: 'sovereign',
  custody: false,
  feeModel: 'protocol_fee_share',
  pnlFeeForbidden: true,
  rankingForbidden: true,
  killUnfollowReal: true,
} as const;

export type CopyDeskFacts = {
  readonly mounted: boolean;
  readonly fee: CopyFeeShareLaw;
  readonly jurisdiction: CopyJurisdictionLaw;
  readonly placeEnabled: boolean;
};

export function unmountedCopyDeskFacts(): CopyDeskFacts {
  return {
    mounted: false,
    fee: UNPUBLISHED_COPY_FEE_SHARE_LAW,
    jurisdiction: UNPUBLISHED_COPY_JURISDICTION_LAW,
    placeEnabled: false,
  };
}

function deskBlockers(feeSharePublished: boolean, jurisdictionPublished: boolean, placeEnabled: boolean): CopyDeskBlocker[] {
  const blockers: CopyDeskBlocker[] = [];
  if (!feeSharePublished) {
    logRefusalSpec('trade.copy_fee_share_blank');
    logCopyResidual('trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
    blockers.push({ code: 'trade.copy_fee_share_blank' });
  }
  if (!jurisdictionPublished) {
    logRefusalSpec('trade.copy_jurisdiction_blank');
    logCopyResidual('trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
    blockers.push({ code: 'trade.copy_jurisdiction_blank' });
  }
  if (!placeEnabled) blockers.push({ code: 'trade.copy_place_disabled' });
  return blockers;
}

/** Customer read. No status line, residual, or residuals object. */
export function presentCustomerCopyDesk(facts: CopyDeskFacts) {
  const feeSharePublished = facts.mounted && facts.fee.published === true;
  const jurisdictionPublished = facts.mounted && facts.jurisdiction.published === true;
  const placeEnabled = facts.mounted && facts.placeEnabled;
  const blockers = facts.mounted
    ? deskBlockers(feeSharePublished, jurisdictionPublished, placeEnabled)
    : [{ code: 'trade.copy_unavailable' as const }];
  return {
    sovereign: SOVEREIGN,
    feeSharePublished,
    leaderShareBps: feeSharePublished && facts.fee.published === true ? String(facts.fee.leaderShareBps) : null,
    jurisdictionPublished,
    blockers,
    autoMirrorPlace: { published: placeEnabled, socket: COPY_AUTO_MIRROR_PLACE_SOCKET },
  };
}

/** Operator read. Same customer fields, plus the sentences a customer must not print. */
export function presentCopyOpsStatus(facts: CopyDeskFacts) {
  const fee = facts.mounted ? facts.fee : UNPUBLISHED_COPY_FEE_SHARE_LAW;
  const jurisdiction = facts.mounted ? facts.jurisdiction : UNPUBLISHED_COPY_JURISDICTION_LAW;
  const placeEnabled = facts.mounted && facts.placeEnabled;
  const customer = presentCustomerCopyDesk(facts);
  if (fee.published !== true) logCopyResidual('trade.copy_fee_share_blank', COPY_FEE_SHARE_RESIDUAL);
  if (jurisdiction.published !== true) logCopyResidual('trade.copy_jurisdiction_blank', COPY_JURISDICTION_RESIDUAL);
  if (!placeEnabled) logCopyResidual('trade.copy_place_disabled', COPY_PLACE_DISABLED_RESIDUAL);
  return {
    ...customer,
    autoMirrorPlace: autoMirrorPlaceStatus(placeEnabled),
    statusLine: copyLawStatusLine(fee, jurisdiction),
    residual: copyLawResidual(fee, jurisdiction),
    residuals: {
      rates: fee.published === true ? null : COPY_FEE_SHARE_RESIDUAL,
      jurisdiction: jurisdiction.published === true ? null : COPY_JURISDICTION_RESIDUAL,
      autoMirrorPlace: placeEnabled ? null : COPY_PLACE_DISABLED_RESIDUAL,
    },
  };
}

const blockerCode = z.enum(COPY_DESK_BLOCKER_CODES as unknown as [CopyDeskBlockerCode, ...CopyDeskBlockerCode[]]);

export const copyDeskStatusOutput = z.object({
  sovereign: z.object({
    shape: z.literal('sovereign'),
    custody: z.literal(false),
    feeModel: z.literal('protocol_fee_share'),
    pnlFeeForbidden: z.literal(true),
    rankingForbidden: z.literal(true),
    killUnfollowReal: z.literal(true),
  }),
  feeSharePublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  jurisdictionPublished: z.boolean(),
  blockers: z.array(z.object({ code: blockerCode })),
  autoMirrorPlace: z.object({
    published: z.boolean(),
    socket: z.string(),
  }),
});

export const copyOpsStatusOutput = copyDeskStatusOutput.extend({
  autoMirrorPlace: z.object({
    published: z.boolean(),
    socket: z.string(),
    residual: z.string().nullable(),
  }),
  statusLine: z.string(),
  residual: z.string().nullable(),
  residuals: z.object({
    rates: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    autoMirrorPlace: z.string().nullable(),
  }),
});
