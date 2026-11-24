/**
 * The partner programme's depth (RC-campaigns-07, J-campaigns-07 #4): how many levels of a partner's sub-tree the
 * programme reaches, 1 for direct invitees only. An owner setting with NO DEFAULT (`IDENTITY_PARTNER_PROGRAMME_DEPTH`).
 *
 * Blank refuses every commission accrual, durable or dry-run, every payout, and the partner's own sub-tree read, with
 * `affiliate.programme_depth_unset`: nothing is owed or paid beyond a depth nobody set. Set, accrual walks at most this
 * many ancestors and payout refuses any row deeper than it. Never above the referral tree's own cap.
 */

import { DEFAULT_MAX_REFERRAL_DEPTH } from './referral-tree.js';

export const AFFILIATE_PROGRAMME_DEPTH_UNSET = 'affiliate.programme_depth_unset' as const;

export class AffiliateProgrammeDepthUnsetError extends Error {
  readonly code = AFFILIATE_PROGRAMME_DEPTH_UNSET;
  constructor(message = 'The partner programme depth is not set; no commission is accrued or paid and no sub-tree is shown') {
    super(message);
    this.name = 'AffiliateProgrammeDepthUnsetError';
  }
}

/** Parsed at start. Blank (or the stack's `off`) → undefined; anything but a whole number 1..cap stops the service. */
export function parseProgrammeDepth(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > DEFAULT_MAX_REFERRAL_DEPTH) {
    throw new Error(`IDENTITY_PARTNER_PROGRAMME_DEPTH must be a whole number from 1 to ${DEFAULT_MAX_REFERRAL_DEPTH}`);
  }
  return Number(value);
}

/** The published depth, or the typed refusal. */
export function requireProgrammeDepth(depth: number | undefined): number {
  if (depth === undefined) throw new AffiliateProgrammeDepthUnsetError();
  return depth;
}
