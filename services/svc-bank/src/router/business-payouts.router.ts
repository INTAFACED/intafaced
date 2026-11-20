import { z } from 'zod';
import {
  router,
  scopedProcedure,
  businessBulkRunSchema,
  businessContractorBatchSchema,
  businessContractorInviteInfoSchema,
  businessContractorInviteSchema,
  businessContractorJoinedSchema,
  businessContractorSchema,
  businessCryptoPayrollSchema,
  businessPayrollWalletOfferSchema,
  businessPayrollWalletSchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  MAX_BATCH_INVOICES,
  MAX_BULK_FILE_BYTES,
  MAX_PAYROLL_MEMBERS,
  type BulkRun,
  type Contractor,
  type ContractorBatch,
  type CryptoPayroll,
  type PayrollWallet,
} from '../business/business-payouts.js';
import { bulkRunConfirmBinding, contractorBatchBinding } from '../step-up/money-out-fields.js';
import { amountString, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const approvals = (a: Array<{ userId: string; approvedAt: Date }>) =>
  a.map((x) => ({ userId: x.userId, approvedAt: x.approvedAt.toISOString() }));

export const bulkRunView = (r: BulkRun) => ({
  ...r,
  total: formatAmount(r.total),
  lines: r.lines.map((l) => ({ ...l, amount: formatAmount(l.amount) })),
  threshold: r.threshold === null ? null : formatAmount(r.threshold),
  approvals: approvals(r.approvals),
  createdAt: r.createdAt.toISOString(),
  sentAt: iso(r.sentAt),
});
const contractorView = (c: Contractor) => ({
  ...c,
  createdAt: c.createdAt.toISOString(),
  invoices: c.invoices.map((i) => ({ ...i, amount: formatAmount(i.amount), createdAt: i.createdAt.toISOString() })),
});
const batchView = (b: ContractorBatch) => ({
  ...b,
  total: formatAmount(b.total),
  approvals: approvals(b.approvals),
  lines: b.lines.map((l) => ({ ...l, amount: formatAmount(l.amount) })),
  createdAt: b.createdAt.toISOString(),
  sentAt: iso(b.sentAt),
});
const walletView = (w: PayrollWallet) => ({ address: w.address, connectedAt: w.connectedAt.toISOString() });
const payrollView = (p: CryptoPayroll) => ({
  ...p,
  members: p.members.map((m) => ({ ...m, amount: formatAmount(m.amount) })),
  runs: p.runs.map((r) => ({
    ...r,
    total: formatAmount(r.total),
    signedAt: iso(r.signedAt),
    createdAt: r.createdAt.toISOString(),
    payslips: r.payslips.map((s) => ({ ...s, amount: formatAmount(s.amount) })),
  })),
  createdAt: p.createdAt.toISOString(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const contractorFields = {
  name: z.string().min(1).max(140),
  email: z.string().max(254).nullable(),
  iban: z.string().max(42).nullable(),
  walletAddress: address.nullable(),
};

/**
 * J-bank-21: a business pays its team and contractors in bulk (BK-bpay-01, BK-bpay-02, RC-bank-05). Every door is the
 * signed-in member's; what each may do is their permissions on that business, checked by the service. A bulk run and a
 * contractor batch are each one partner instruction, sent once; crypto payroll runs are signed by the business's own
 * wallet. The ledger posts nothing.
 */
export function createBusinessPayoutsRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  const payouts = bank.businessPayouts;
  const accountInput = z.object({ accountId: z.string().guid() }).strict();
  return router({
    runs: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessBulkRunSchema))
      .query(({ ctx, input }) => guard(async () => (await payouts.runs(input.accountId, ctx.principal.userId)).map(bulkRunView))),
    run: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ runId: z.string().guid() }).strict())
      .output(businessBulkRunSchema)
      .query(({ ctx, input }) => guard(async () => bulkRunView(await payouts.run(input.runId, ctx.principal.userId)))),
    /** Imports a CSV as a draft run with its validation report. Nothing is held or sent. */
    importRun: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), runId: z.string().guid(), csv: z.string().min(1).max(MAX_BULK_FILE_BYTES) }).strict())
      .output(businessBulkRunSchema)
      .mutation(({ ctx, input }) => guard(async () => bulkRunView(await payouts.importRun({ ...input, userId: ctx.principal.userId })))),
    /** The funding step and the confirmation: at or above the business's threshold it waits for an approver. */
    confirmRun: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ runId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict())
      .output(businessBulkRunSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              bulkRunConfirmBinding({ actor: ctx.principal.userId, runId: input.runId }),
              input.stepUpApprovalId,
            );
          }
          return bulkRunView(await payouts.confirmRun({ runId: input.runId, userId: ctx.principal.userId }));
        }),
      ),
    approveRun: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ runId: z.string().guid() }).strict())
      .output(businessBulkRunSchema)
      .mutation(({ ctx, input }) => guard(async () => bulkRunView(await payouts.approveRun({ ...input, userId: ctx.principal.userId })))),

    contractors: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessContractorSchema))
      .query(({ ctx, input }) => guard(async () => (await payouts.contractors(input.accountId, ctx.principal.userId)).map(contractorView))),
    addContractor: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), contractorId: z.string().guid(), ...contractorFields }).strict())
      .output(businessContractorSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => contractorView(await payouts.addContractor({ ...input, userId: ctx.principal.userId }))),
      ),
    addInvoice: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            contractorId: z.string().guid(),
            invoiceId: z.string().guid(),
            number: z.string().min(1).max(64),
            amount: amountString,
            dueDate: day.nullable(),
          })
          .strict(),
      )
      .output(businessContractorSchema)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          contractorView(await payouts.addInvoice({ ...input, amount: parseAmount(input.amount), userId: ctx.principal.userId })),
        ),
      ),
    createInvite: scopedProcedure('bank:write', { module: 'bank' })
      .input(accountInput)
      .output(businessContractorInviteSchema)
      .mutation(({ ctx, input }) => guard(() => payouts.createInvite({ ...input, userId: ctx.principal.userId }))),
    inviteInfo: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ token: z.string().min(16).max(128) }).strict())
      .output(businessContractorInviteInfoSchema)
      .query(({ input }) => guard(() => payouts.inviteInfo(input.token))),
    /** The contractor adds themselves through a one-use link, with their own payout IBAN and wallet. */
    joinAsContractor: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ token: z.string().min(16).max(128), ...contractorFields }).strict())
      .output(businessContractorJoinedSchema)
      .mutation(({ ctx, input }) => guard(() => payouts.joinAsContractor({ ...input, userId: ctx.principal.userId }))),
    batches: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessContractorBatchSchema))
      .query(({ ctx, input }) => guard(async () => (await payouts.batches(input.accountId, ctx.principal.userId)).map(batchView))),
    /** Pays a batch of open invoices: the intent row first, then the business's approval rules, then the payout rail. */
    payBatch: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            batchId: z.string().guid(),
            invoiceIds: z.array(z.string().guid()).min(1).max(MAX_BATCH_INVOICES),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(businessContractorBatchSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const { stepUpApprovalId, ...rest } = input;
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              contractorBatchBinding({ actor: ctx.principal.userId, accountId: rest.accountId, batchId: rest.batchId }),
              stepUpApprovalId,
            );
          }
          return batchView(await payouts.payBatch({ ...rest, userId: ctx.principal.userId }));
        }),
      ),
    approveBatch: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ batchId: z.string().guid() }).strict())
      .output(businessContractorBatchSchema)
      .mutation(({ ctx, input }) => guard(async () => batchView(await payouts.approveBatch({ ...input, userId: ctx.principal.userId })))),

    wallet: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessPayrollWalletSchema.nullable())
      .query(({ ctx, input }) =>
        guard(async () => {
          const w = await payouts.wallet(input.accountId, ctx.principal.userId);
          return w ? walletView(w) : null;
        }),
      ),
    walletOffer: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), address }).strict())
      .output(businessPayrollWalletOfferSchema)
      .mutation(({ ctx, input }) => guard(() => payouts.walletOffer({ ...input, userId: ctx.principal.userId }))),
    connectWallet: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ offerId: z.string().guid(), signature }).strict())
      .output(businessPayrollWalletSchema)
      .mutation(({ ctx, input }) => guard(async () => walletView(await payouts.connectWallet({ ...input, userId: ctx.principal.userId })))),
    payrolls: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessCryptoPayrollSchema))
      .query(({ ctx, input }) => guard(async () => (await payouts.payrolls(input.accountId, ctx.principal.userId)).map(payrollView))),
    createPayroll: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            payrollId: z.string().guid(),
            name: z.string().min(1).max(128),
            dayOfMonth: z.number().int().min(1).max(28),
            members: z
              .array(z.object({ contractorId: z.string().guid(), amount: amountString }).strict())
              .min(1)
              .max(MAX_PAYROLL_MEMBERS),
          })
          .strict(),
      )
      .output(businessCryptoPayrollSchema)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          payrollView(
            await payouts.createPayroll({
              ...input,
              members: input.members.map((m) => ({ contractorId: m.contractorId, amount: parseAmount(m.amount) })),
              userId: ctx.principal.userId,
            }),
          ),
        ),
      ),
    /** One month's run and its payslips, under its run key: nothing is sent, held or posted. */
    prepareRun: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ payrollId: z.string().guid(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict())
      .output(businessCryptoPayrollSchema)
      .mutation(({ ctx, input }) => guard(async () => payrollView(await payouts.prepareRun({ ...input, userId: ctx.principal.userId })))),
    /** The business's own wallet's signature over the run's message. */
    signRun: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ runId: z.string().guid(), signature }).strict())
      .output(businessCryptoPayrollSchema)
      .mutation(({ ctx, input }) => guard(async () => payrollView(await payouts.signRun({ ...input, userId: ctx.principal.userId })))),
  });
}
