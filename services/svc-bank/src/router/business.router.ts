import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  serviceProcedureFor,
  BANK_APPROVER_ELIGIBILITY_CALLERS,
  bankApproverEligibilityInputSchema,
  bankApproverEligibilitySchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BUSINESS_ROLES, describeBusinessPolicy } from '../business/business-policy.js';
import {
  addMemberBinding,
  removeMemberBinding,
  setMemberRoleBinding,
  approveBinding,
  proposeTransferBinding,
  runPayrollBinding,
} from '../step-up/money-out-fields.js';
import { amountString, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createBusinessRouter(c: BankRouterContext) {
  const { bank, approvals, stepUpEnforced, requireStepUp, assetOfSpace } = c;
  const businessAccountOutput = z.object({
    id: z.string(),
    name: z.string(),
    assetId: z.string(),
    spendThreshold: amountString,
    status: z.enum(['active', 'closed']),
    createdAt: z.string(),
  });

  const businessApprovalOutput = z.object({
    id: z.string(),
    accountId: z.string(),
    makerUserId: z.string(),
    checkerUserId: z.string().nullable(),
    fromSpaceId: z.string(),
    toSpaceId: z.string(),
    assetId: z.string(),
    amount: amountString,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    transferId: z.string().nullable(),
    holdLedgerTxId: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  return router({
    policy: publicProcedure.query(() => describeBusinessPolicy()),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.business_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(businessAccountOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.business.accountsOf(ctx.principal.userId, input?.limit);
          return rows.map((a) => ({
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          name: z.string().min(1).max(128),
          assetId: z.string().min(1).max(16),
          spendThreshold: amountString,
        }),
      )
      .output(businessAccountOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const a = await bank.business.createAccount({
            accountId: input.accountId,
            name: input.name,
            assetId: input.assetId,
            spendThreshold: parseAmount(input.spendThreshold),
            creatorUserId: ctx.principal.userId,
          });
          return {
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          };
        }),
      ),

    addMember: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          userId: z.string().min(1),
          role: z.enum(BUSINESS_ROLES),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              addMemberBinding({ actor: ctx.principal.userId, accountId: input.accountId, userId: input.userId, role: input.role }),
              input.stepUpApprovalId,
            );
          }
          const m = await bank.business.addMember({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            role: input.role,
          });
          return { accountId: m.accountId, userId: m.userId, role: m.role };
        }),
      ),

    proposeTransfer: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          fromSpaceId: z.string().guid(),
          toSpaceId: z.string().guid(),
          amount: amountString,
          clientId: z.string().guid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('posted'),
            transferId: z.string(),
            ledgerTxId: z.string(),
          }),
          z.object({
            kind: z.literal('pending'),
            approval: businessApprovalOutput,
          }),
        ]),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              proposeTransferBinding({
                actor: ctx.principal.userId,
                clientId: input.clientId,
                accountId: input.accountId,
                fromSpaceId: input.fromSpaceId,
                toSpaceId: input.toSpaceId,
                assetId: await assetOfSpace(input.fromSpaceId),
                amount: input.amount,
              }),
              input.stepUpApprovalId,
            );
          }
          const result = await bank.business.proposeTransfer({
            accountId: input.accountId,
            makerUserId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toSpaceId: input.toSpaceId,
            amount: parseAmount(input.amount),
            clientId: input.clientId,
          });
          if (result.kind === 'posted') return result;
          const a = result.approval;
          return {
            kind: 'pending' as const,
            approval: {
              id: a.id,
              accountId: a.accountId,
              makerUserId: a.makerUserId,
              checkerUserId: a.checkerUserId,
              fromSpaceId: a.fromSpaceId,
              toSpaceId: a.toSpaceId,
              assetId: a.assetId,
              amount: formatAmount(a.amount),
              status: a.status,
              transferId: a.transferId,
              holdLedgerTxId: a.holdLedgerTxId,
              ledgerTxId: a.ledgerTxId,
              createdAt: a.createdAt.toISOString(),
            },
          };
        }),
      ),

    approve: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ transferId: z.string(), ledgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              approveBinding({ actor: ctx.principal.userId, approvalId: input.approvalId }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.approve({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId });
        }),
      ),

    reject: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().guid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.reject({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().guid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.cancel({ approvalId: input.approvalId, actorUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    pending: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          /**
           * Page size. Optional so omit reaches `bank.business_pending_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            accountId: z.string(),
            makerHandle: z.string().nullable(),
            makerHandleReason: z.enum(['handle_unresolved']).nullable(),
            receiverOwnerHandle: z.string().nullable(),
            receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
            receiverOwnerName: z.string().nullable(),
            fromSpaceId: z.string(),
            toSpaceId: z.string(),
            assetId: z.string(),
            amount: amountString,
            status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
            transferId: z.string().nullable(),
            holdLedgerTxId: z.string().nullable(),
            ledgerTxId: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.business.listPending(input.accountId, ctx.principal.userId, input.limit);
          return rows.map((a) => ({
            id: a.id,
            accountId: a.accountId,
            makerHandle: a.makerHandle,
            makerHandleReason: a.makerHandleReason,
            receiverOwnerHandle: a.receiverOwnerHandle,
            receiverOwnerHandleReason: a.receiverOwnerHandleReason,
            receiverOwnerName: a.receiverOwnerName,
            fromSpaceId: a.fromSpaceId,
            toSpaceId: a.toSpaceId,
            assetId: a.assetId,
            amount: formatAmount(a.amount),
            status: a.status,
            transferId: a.transferId,
            holdLedgerTxId: a.holdLedgerTxId,
            ledgerTxId: a.ledgerTxId,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),

    members: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid() }))
      .output(
        z.object({
          members: z.array(
            z.object({
              accountId: z.string(),
              userId: z.string(),
              role: z.enum(BUSINESS_ROLES),
              handle: z.string(),
            }),
          ),
          pendingControls: z.array(
            z.object({
              requestId: z.string(),
              kind: z.enum(['set_threshold', 'close']),
              spendThreshold: amountString.nullable(),
              proposedByHandle: z.string(),
              createdAt: z.string(),
            }),
          ),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const team = await bank.business.team(input.accountId, ctx.principal.userId);
          return {
            members: team.members,
            pendingControls: team.pendingControls.map((row) => ({
              requestId: row.requestId,
              kind: row.kind,
              spendThreshold: row.spendThreshold === null ? null : formatAmount(row.spendThreshold),
              proposedByHandle: row.proposedByHandle,
              createdAt: row.createdAt.toISOString(),
            })),
          };
        }),
      ),

    removeMember: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          userId: z.string().min(1),
          requestId: z.string().guid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), removed: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              removeMemberBinding({
                actor: ctx.principal.userId,
                accountId: input.accountId,
                userId: input.userId,
                requestId: input.requestId,
              }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.removeMember({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            requestId: input.requestId,
          });
        }),
      ),

    setMemberRole: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          userId: z.string().min(1),
          role: z.enum(BUSINESS_ROLES),
          requestId: z.string().guid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              setMemberRoleBinding({
                actor: ctx.principal.userId,
                accountId: input.accountId,
                userId: input.userId,
                role: input.role,
                requestId: input.requestId,
              }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.setMemberRole({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            role: input.role,
            requestId: input.requestId,
          });
        }),
      ),

    resolveRecipientSpace: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          assetId: z.string().min(1).max(16),
          handle: z.string().max(64).optional(),
          email: z.string().max(320).optional(),
        }),
      )
      .output(
        z.discriminatedUnion('found', [
          z.object({ found: z.literal(false) }),
          z.object({
            found: z.literal(true),
            handle: z.string(),
            assetId: z.string(),
            spaceId: z.string().guid().nullable(),
          }),
        ]),
      )
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.business.resolveRecipientSpace({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            assetId: input.assetId,
            handle: input.handle,
            email: input.email,
          }),
        ),
      ),

    approvals: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
          /**
           * Page size. Optional so omit reaches `bank.business_approvals_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).max(512).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(
            z.object({
              id: z.string(),
              accountId: z.string(),
              makerHandle: z.string().nullable(),
              makerHandleReason: z.enum(['handle_unresolved']).nullable(),
              checkerHandle: z.string().nullable(),
              receiverOwnerHandle: z.string().nullable(),
              receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
              receiverOwnerName: z.string().nullable(),
              fromSpaceId: z.string(),
              toSpaceId: z.string(),
              assetId: z.string(),
              amount: amountString,
              status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
              transferId: z.string().nullable(),
              holdLedgerTxId: z.string().nullable(),
              ledgerTxId: z.string().nullable(),
              createdAt: z.string(),
              decidedAt: z.string().nullable(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const page = await bank.business.listApprovals(input.accountId, ctx.principal.userId, {
            status: input.status,
            limit: input.limit,
            cursor: input.cursor,
          });
          return {
            nextCursor: page.nextCursor,
            items: page.items.map((a) => ({
              id: a.id,
              accountId: a.accountId,
              makerHandle: a.makerHandle,
              makerHandleReason: a.makerHandleReason,
              checkerHandle: a.checkerHandle,
              receiverOwnerHandle: a.receiverOwnerHandle,
              receiverOwnerHandleReason: a.receiverOwnerHandleReason,
              receiverOwnerName: a.receiverOwnerName,
              fromSpaceId: a.fromSpaceId,
              toSpaceId: a.toSpaceId,
              assetId: a.assetId,
              amount: formatAmount(a.amount),
              status: a.status,
              transferId: a.transferId,
              holdLedgerTxId: a.holdLedgerTxId,
              ledgerTxId: a.ledgerTxId,
              createdAt: a.createdAt.toISOString(),
              decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
            })),
          };
        }),
      ),

    setThreshold: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().guid(),
          spendThreshold: amountString,
          requestId: z.string().guid(),
        }),
      )
      .output(
        z.object({
          status: z.enum(['pending', 'applied']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.setThreshold({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            spendThreshold: parseAmount(input.spendThreshold),
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    close: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), requestId: z.string().guid() }))
      .output(
        z.object({
          status: z.enum(['pending', 'applied']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.closeAccount({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    cancelControl: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), requestId: z.string().guid() }))
      .output(
        z.object({
          status: z.enum(['cancelled']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.cancelControl({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    /**
     * Atomic multi-recipient payroll. One ledger post. Cross-asset lines
     * refuse `bank.business_payroll_rate_unset` — rates are owner law, never invented.
     */
    myRole: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid() }))
      .output(z.object({ role: z.enum(BUSINESS_ROLES) }))
      .query(async ({ ctx, input }) => guard(async () => ({ role: await bank.business.myRole(input.accountId, ctx.principal.userId) }))),

    runPayroll: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          payrollId: z.string().guid(),
          accountId: z.string().guid(),
          fromSpaceId: z.string().guid(),
          recipients: z
            .array(z.object({ toSpaceId: z.string().guid(), amount: amountString }))
            .min(1)
            .max(64),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.object({
          payrollId: z.string(),
          accountId: z.string(),
          fromSpaceId: z.string(),
          assetId: z.string(),
          ledgerTxId: z.string(),
          recipients: z.array(z.object({ toSpaceId: z.string(), amount: amountString })),
          createdAt: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              runPayrollBinding({
                actor: ctx.principal.userId,
                payrollId: input.payrollId,
                accountId: input.accountId,
                fromSpaceId: input.fromSpaceId,
                assetId: await assetOfSpace(input.fromSpaceId),
                recipients: input.recipients,
              }),
              input.stepUpApprovalId,
            );
          }
          const run = await bank.business.runPayroll({
            payrollId: input.payrollId,
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            recipients: input.recipients.map((r) => ({ toSpaceId: r.toSpaceId, amount: parseAmount(r.amount) })),
          });
          return {
            payrollId: run.payrollId,
            accountId: run.accountId,
            fromSpaceId: run.fromSpaceId,
            assetId: run.assetId,
            ledgerTxId: run.ledgerTxId,
            recipients: run.recipients.map((r) => ({ toSpaceId: r.toSpaceId, amount: formatAmount(r.amount) })),
            createdAt: run.createdAt.toISOString(),
          };
        }),
      ),

    /**
     * May this person approve for a team? Asked by svc-pay before it counts an approval on a multi-approval withdrawal
     * (W-withdraw-11). Service-only: `serviceProcedureFor` proves the caller is svc-pay before the input is parsed. A read; a
     * POST only because the caller signs the body.
     */
    approverEligibility: serviceProcedureFor(BANK_APPROVER_ELIGIBILITY_CALLERS)
      .input(bankApproverEligibilityInputSchema)
      .output(bankApproverEligibilitySchema)
      .mutation(async ({ input }) => guard(async () => bank.business.approverEligibility(input.accountId, input.userId))),
  });
}
