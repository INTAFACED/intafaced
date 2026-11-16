/** The business bank: members, roles, approvals and recipient lookup. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';
import { businessListSchema, businessSchema } from './business-schema';

export { businessSchema } from './business-schema';
export const memberRoleSchema = z.enum(['admin', 'maker', 'checker']);
export const approvalSchema = z.object({
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
export const teamSchema = z.object({
  members: z.array(z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema, handle: z.string() })),
});
export const recipientSpaceSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), handle: z.string(), assetId: z.string(), spaceId: z.string().guid().nullable() }),
]);

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const businessReads = {
  'business.list': businessListSchema,
  'business.pending': z.array(pendingApprovalSchema),
  'business.members': teamSchema,
  'business.myRole': z.object({ role: memberRoleSchema }),
  'business.resolveRecipientSpace': recipientSpaceSchema,
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const businessWrites = {
  'business.create': businessSchema,
  'business.addMember': z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema }),
  'business.proposeTransfer': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('posted'), transferId: z.string(), ledgerTxId: z.string() }),
    z.object({ kind: z.literal('pending'), approval: approvalSchema }),
  ]),
  'business.approve': z.object({ transferId: z.string(), ledgerTxId: z.string() }),
  'business.setMemberRole': z.object({ accountId: z.string(), userId: z.string(), role: memberRoleSchema }),
  'business.removeMember': z.object({ accountId: z.string(), userId: z.string(), removed: z.literal(true) }),
  'business.reject': z.object({ ok: z.literal(true) }),
  'business.cancel': z.object({ ok: z.literal(true) }),
  'business.runPayroll': z.object({
    payrollId: z.string(),
    accountId: z.string(),
    fromSpaceId: z.string(),
    assetId: z.string(),
    ledgerTxId: z.string(),
    recipients: z.array(z.object({ toSpaceId: z.string(), amount: money })),
    createdAt: z.string(),
  }),
} as const;
