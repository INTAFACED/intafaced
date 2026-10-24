/**
 * Operator read of the business approval queue. Read-only: approve, reject
 * and cancel stay with the business's own checker. A missing limit refuses.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const MAX_LIMIT = 200;

export interface OperatorApproval {
  businessId: string;
  amount: string;
  assetId: string;
  ageSeconds: number;
  makerHandle: string | null;
  makerHandleReason: 'handle_unresolved' | null;
  rule: string;
}

export interface OperatorApprovalPage {
  approvals: OperatorApproval[];
  nextCursor: string | null;
}

export function assertOperatorApprovalLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BankError(
      'The operator approval queue needs a limit from 1 to 200 (bank.ops_business_approvals_limit_unset)',
      'bank.ops_business_approvals_limit_unset',
    );
  }
  return limit;
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function businessApprovalsProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      }),
    )
    .output(
      z.object({
        approvals: z.array(
          z.object({
            businessId: z.string().guid(),
            amount: amountString,
            assetId: z.string(),
            ageSeconds: z.number().int().nonnegative(),
            makerHandle: z.string().nullable(),
            makerHandleReason: z.enum(['handle_unresolved']).nullable(),
            rule: amountString,
          }),
        ),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(({ input }) =>
      guard(async () => {
        const limit = assertOperatorApprovalLimit(input.limit);
        return bank.business.operatorApprovals({ status: input.status ?? 'pending', limit, cursor: input.cursor });
      }),
    );
}
