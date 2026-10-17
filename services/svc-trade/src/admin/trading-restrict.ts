/**
 * Trade-side of trading.restrict. Identity owns the approval row (APPROVALBE).
 * This gate runs only when IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL is on.
 * Off: the apply path is unchanged and an approval id is not required.
 */
import { z } from 'zod';
import {
  accountControlInputSchema,
  accountControlResultSchema,
  type AccountControlResult,
  type AccountControlState,
} from '@intafaced/contracts';
import { consumeApproval, payloadHash, type ApprovalBook } from './common.js';

let bound: ApprovalBook | null = null;

export function bindTradingRestrictApprovals(book: ApprovalBook | null): void {
  bound = book;
}

export function currentTradingRestrictApprovals(): ApprovalBook | null {
  return bound;
}

/** Same allow-list identity uses. Anything else, including unset, stays off. */
export function tradingRestrictRequiresApproval(): boolean {
  const raw = process.env.IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL;
  if (typeof raw !== 'string') return false;
  const text = raw.trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'on';
}

/** Flag off: the shared strict schema, so a caller-supplied approvalId is still rejected. */
export function tradeRestrictInputSchema() {
  if (!tradingRestrictRequiresApproval()) return accountControlInputSchema;
  return accountControlInputSchema.extend({ approvalId: z.string().trim().min(1).max(128) }).strict();
}

export async function tradingRestrictGate(input: {
  readonly approvalId: string | undefined;
  readonly actorId: string;
  readonly userId: string;
  readonly action: 'restrict' | 'restore';
  readonly reason: string;
  readonly expectedVersion: string;
  readonly before: AccountControlState;
  readonly base: {
    readonly auditId: string;
    readonly requestId: string;
    readonly target: AccountControlState['target'];
    readonly action: 'restrict' | 'restore';
    readonly reason: string;
    readonly occurredAt: string;
    readonly actorUserId: string;
    readonly changed: false;
  };
  readonly book: ApprovalBook | null;
}): Promise<AccountControlResult | null> {
  if (!tradingRestrictRequiresApproval()) return null;
  const refuse = (code: 'restriction_no_four_eyes' | 'restriction_approval_mismatch' | 'restriction_approval_consumed') =>
    accountControlResultSchema.parse({
      ...input.base,
      outcome: 'refused',
      changed: false,
      code,
      current: input.before,
    });
  if (!input.approvalId) return refuse('restriction_no_four_eyes');
  if (!input.book) return refuse('restriction_approval_mismatch');
  const hash = payloadHash({
    actionType: 'trading.restrict',
    userId: input.userId,
    action: input.action,
    reason: input.reason,
    expectedVersion: input.expectedVersion,
  });
  try {
    await consumeApproval(input.book, {
      approvalId: input.approvalId,
      actionType: 'trading.restrict',
      targetId: input.userId,
      expectedVersion: input.expectedVersion,
      payloadHash: hash,
      operationId: input.base.requestId,
    });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : '';
    if (code === 'approval_reused') return refuse('restriction_approval_consumed');
    return refuse('restriction_approval_mismatch');
  }
  return null;
}
