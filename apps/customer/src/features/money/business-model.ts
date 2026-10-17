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

/**
 * What this person may try on an approval. Approving and rejecting are for administrators and checkers; cancelling
 * someone else's proposal is for administrators. The app cannot read members yet, so with the role unknown every
 * action is offered and the service decides. A known role removes the buttons it can never use.
 */
export function approvalActions(
  approval: Pick<ApprovalLike, 'status' | 'makerUserId'>,
  me: string | null,
  role: Role | null = null,
): ApprovalAction[] {
  if (approval.status !== 'pending' || !me) return [];
  if (approval.makerUserId === me) return ['cancel'];
  if (role === 'admin' || role === null) return ['approve', 'reject', 'cancel'];
  if (role === 'checker') return ['approve', 'reject'];
  return [];
}

/** A short reference for someone the app cannot name yet (the first block of their id). */
export const shortRef = (id: string): string => id.split('-')[0]!.slice(0, 8);

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

/**
 * The reply to a payment proposal must be the one that was asked for. Pending: the approval carries the request id,
 * the same account, accounts and amount to the digit. Posted: a ledger transaction exists.
 */
export function proposalMatches(data: unknown, input: Record<string, unknown>): boolean {
  if (!data || typeof data !== 'object') return false;
  const reply = data as Record<string, unknown>;
  if (reply.kind === 'posted') return typeof reply.ledgerTxId === 'string' && reply.ledgerTxId.trim().length > 0;
  if (reply.kind !== 'pending' || !reply.approval || typeof reply.approval !== 'object') return false;
  const approval = reply.approval as Record<string, unknown>;
  return (
    typeof approval.id === 'string' &&
    typeof input.clientId === 'string' &&
    approval.id.toLowerCase() === input.clientId.toLowerCase() &&
    approval.accountId === input.accountId &&
    approval.fromSpaceId === input.fromSpaceId &&
    approval.toSpaceId === input.toSpaceId &&
    typeof approval.amount === 'string' &&
    typeof input.amount === 'string' &&
    decimalSchema.safeParse(approval.amount).success &&
    parseAmount(approval.amount) === parseAmount(input.amount)
  );
}

/** Which of the two outcomes a proposal reply was, in words the screen can pick copy for. */
export function proposalOutcome(data: unknown): 'pending' | 'posted' | null {
  const kind = data && typeof data === 'object' ? (data as Record<string, unknown>).kind : null;
  return kind === 'pending' || kind === 'posted' ? kind : null;
}
