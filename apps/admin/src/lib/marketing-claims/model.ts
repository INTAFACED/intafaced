import { claimsListOutputSchema, type ClaimBlock, type ClaimsList } from '@intafaced/contracts/ops-marketing-claims';
import type { OpsRead } from '@/lib/console-announcements/model';

/**
 * The marketing claims evidence register as this console last read it from svc-ops (RC-more-catalogue-24). Pure, so the
 * server loader and the register read it the same way.
 */
export type ClaimsView = OpsRead<ClaimsList>;

export function readClaimsList(raw: unknown): ClaimsList | null {
  const parsed = claimsListOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A claim's block in words. */
export const BLOCK_TEXT: Readonly<Record<ClaimBlock, string>> = {
  evidence_missing: 'Blocked: no evidence recorded',
  awaiting_approval: 'Blocked: waiting for a second founder to publish it',
};
