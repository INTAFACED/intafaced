import { decimalSchema, parseAmount } from '../../shared/money';

export type Role = 'admin' | 'maker' | 'checker';
export const ROLES: readonly Role[] = ['admin', 'maker', 'checker'] as const;

export interface ApprovalLike {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  makerUserId: string;
  fromSpaceId: string;
  toSpaceId: string;
}
export type ApprovalAction = 'approve' | 'reject' | 'cancel';

/** What this person may try on an approval. The service still has the last word; this only avoids pointless buttons. */
export function approvalActions(approval: Pick<ApprovalLike, 'status' | 'makerUserId'>, me: string | null): ApprovalAction[] {
  if (approval.status !== 'pending' || !me) return [];
  return approval.makerUserId === me ? ['cancel'] : ['approve', 'reject'];
}

export type Party = 'you' | 'teammate';
export function whoMade(approval: Pick<ApprovalLike, 'makerUserId'>, me: string | null): Party {
  return me && approval.makerUserId === me ? 'you' : 'teammate';
}

/** Name of one of the customer's own accounts, or null when the account belongs to someone else. */
export function ownSpaceName(spaces: readonly { id: string; name: string }[], id: string): string | null {
  return spaces.find((space) => space.id === id)?.name ?? null;
}

/** The customer's accounts in the company's asset, the only places a company payment can start from or be sent to. */
export function companySpaces<T extends { assetId: string; id: string }>(spaces: readonly T[], assetId: string): T[] {
  return spaces.filter((space) => space.assetId === assetId);
}

/** A company spend threshold must be an exact positive amount; the service refuses zero. */
export function thresholdProblem(value: string): 'invalid' | 'zero' | null {
  if (!decimalSchema.safeParse(value).success) return 'invalid';
  return parseAmount(value) > 0n ? null : 'zero';
}

/** Does this payment need a second person? At or above the threshold, in exact units; below it posts straight away. */
export function needsSecondPerson(amount: string, threshold: string): boolean | null {
  if (!decimalSchema.safeParse(amount).success || !decimalSchema.safeParse(threshold).success) return null;
  return parseAmount(amount) >= parseAmount(threshold);
}
