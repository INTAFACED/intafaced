/** The business bank: members, roles, approvals and recipient lookup. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

export { businessSchema } from '../session';
const memberRoleSchema = z.enum(['admin', 'maker', 'checker']);
const approvalSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  makerUserId: z.string(),
  checkerUserId: z.string().nullable(),
  fromSpaceId: z.string(),
  toSpaceId: z.string(),
  assetId: z.string(),
  amount: money,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  transferId: z.string().nullable(),
  holdLedgerTxId: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
});
/** A waiting payment as `business.pending` reads it: the people are named by handle where identity can name them. */
export const pendingApprovalSchema = approvalSchema.extend({
  makerHandle: z.string().nullable(),
  makerHandleReason: z.enum(['handle_unresolved']).nullable(),
  receiverOwnerHandle: z.string().nullable(),
  receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
  receiverOwnerName: z.string().nullable(),
});
/** The team as the business room reads it: members only, without the pending controls the record also carries. */
export const teamSchema = z.object({
  members: z.array(z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema, handle: z.string() })),
});

/** The caller's own stricter answers for `business.pending` and `business.myRole`: only the three roles this room knows. */
export const pendingApprovalsSchema = z.array(pendingApprovalSchema);
export const myRoleSchema = z.object({ role: memberRoleSchema });

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
