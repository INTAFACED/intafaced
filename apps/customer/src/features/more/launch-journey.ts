import { z } from 'zod';
import { parseAmount } from '../../shared/money';

/** Read-only pre-listing pattern check (svc-agents `launch.assess`). It is an
 * annotation, never a badge and never a block decision. */
export const assessResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('refuse'),
    reason: z.enum(['deployer_missing', 'reputation_unread', 'history_absent', 'badge_forbidden', 'block_decision_forbidden']),
    isBadge: z.literal(false),
    isBlockDecision: z.literal(false),
    inventedCleanBadge: z.literal(false),
  }),
  z.object({
    status: z.literal('annotation'),
    isBadge: z.literal(false),
    isBlockDecision: z.literal(false),
    deployer: z.string(),
    lpLocks: z.number().int().nonnegative(),
    vestings: z.number().int().nonnegative(),
    patternFlags: z.array(z.object({ code: z.enum(['no_lp_locks', 'no_vestings', 'sparse_lp_locks', 'sparse_vestings']) })),
    inventedCleanBadge: z.literal(false),
  }),
]);
export type AssessResult = z.infer<typeof assessResult>;

export type LaunchStepId = 'check' | 'details' | 'issuance' | 'compliance' | 'listing' | 'sale' | 'vesting';
/** `ready` runs in this room today; `draft` is prepared here and sent nowhere;
 * `blocked` names the capability that is missing. */
export type LaunchStep = { id: LaunchStepId; mode: 'ready' | 'draft' | 'blocked' };
export const LAUNCH_STEPS: readonly LaunchStep[] = [
  { id: 'check', mode: 'ready' },
  { id: 'details', mode: 'draft' },
  { id: 'issuance', mode: 'blocked' },
  { id: 'compliance', mode: 'blocked' },
  { id: 'listing', mode: 'blocked' },
  { id: 'sale', mode: 'blocked' },
  { id: 'vesting', mode: 'blocked' },
];

export type LaunchDraft = { name: string; symbol: string; supply: string; decimals: string; saleShare: string };
export type DraftIssue = 'name' | 'symbol' | 'supply' | 'decimals' | 'saleShare';
export const EMPTY_DRAFT: LaunchDraft = { name: '', symbol: '', supply: '', decimals: '18', saleShare: '' };

/** Local validation of the issuer's asset terms. Returns the fields to fix. */
export function draftIssues(draft: LaunchDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (name.length < 2 || name.length > 64) issues.push('name');
  if (!/^[A-Z0-9]{2,10}$/.test(draft.symbol)) issues.push('symbol');
  let supplyOk = false;
  try {
    supplyOk = /^\d+(\.\d+)?$/.test(draft.supply) && parseAmount(draft.supply) > 0n;
  } catch {
    supplyOk = false;
  }
  if (!supplyOk) issues.push('supply');
  if (!/^\d{1,2}$/.test(draft.decimals) || Number(draft.decimals) > 18) issues.push('decimals');
  // Whole percent of supply offered in a sale: 1 to 100.
  if (!/^\d{1,3}$/.test(draft.saleShare) || Number(draft.saleShare) < 1 || Number(draft.saleShare) > 100) issues.push('saleShare');
  return issues;
}

/** Hold the draft's symbol in upper case so a typed "abc" reads as "ABC". */
export function normaliseSymbol(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
}
