import { checkAccess, type KycTier } from '@intafaced/config';

/**
 * BK-safe-01, J-bank-18 #1: the notice a person in a blocked region sees when they open a transfer. The bank's own doors
 * already refuse there (`scopedProcedure` with `module: 'bank'` answers `denied.region_blocked`); this read says why, in
 * the owner's wording. The wording is the owner's (`BANK_BLOCKED_REGION_NOTICE`), with no default: unpublished, the
 * notice still names the restriction and says the wording is not published. Nothing here decides who is blocked: the
 * verdict is `checkAccess`'s, the same one every bank door applies.
 */
export interface RegionNotice {
  /** The region the edge resolved for this request. */
  readonly region: string;
  /** True when the bank's doors refuse this region (`denied.region_blocked` or `denied.region_unknown`). */
  readonly blocked: boolean;
  /** The refusal's code when blocked, else null. */
  readonly code: string | null;
  /** The restriction the refusal names (the screening list's or the business block's reason), else null. */
  readonly restriction: string | null;
  /** Which authority blocks it (`screening`, `business`), or null when none is named. */
  readonly blockedBy: string | null;
  /** The owner's published notice text, or null while none is published. */
  readonly wording: string | null;
}

const REGION_CODES: ReadonlySet<string> = new Set(['denied.region_blocked', 'denied.region_unknown']);

/** The owner's wording as published: trimmed, or null when blank. */
export function publishedWording(raw: string | undefined): string | null {
  const text = raw?.trim() ?? '';
  return text === '' ? null : text;
}

export function regionNotice(input: { region: string; kycTier: KycTier; wording: string | undefined }): RegionNotice {
  const decision = checkAccess({ module: 'bank', plane: 'fiat', region: input.region, kycTier: input.kycTier });
  const blocked = !decision.allowed && REGION_CODES.has(decision.code);
  return {
    region: input.region,
    blocked,
    code: blocked ? decision.code : null,
    restriction: blocked ? decision.reason : null,
    blockedBy: blocked ? (decision.blockedBy ?? null) : null,
    wording: blocked ? publishedWording(input.wording) : null,
  };
}
