import { z } from 'zod';
import {
  router,
  scopedProcedure,
  businessBillSchema,
  businessBillLimitsSchema,
  businessBillSettingsSchema,
  businessBillVendorSchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  MAX_BILL_BYTES,
  MAX_SPLIT_LINES,
  type Bill,
  type BillLimits,
  type BillSettings,
  type BillVendor,
} from '../business/business-bills.js';
import { billPayBinding } from '../step-up/money-out-fields.js';
import { amountString, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

const f = (v: bigint | null) => (v === null ? null : formatAmount(v));
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const billView = (b: Bill) => ({
  ...b,
  amount: f(b.amount),
  createdAt: b.createdAt.toISOString(),
  rule: b.rule ? { ...b.rule, overAmount: formatAmount(b.rule.overAmount), createdAt: b.rule.createdAt.toISOString() } : null,
  approvals: b.approvals.map((a) => ({ ...a, approvedAt: a.approvedAt.toISOString() })),
  duplicateOf: b.duplicateOf
    ? { ...b.duplicateOf, amount: f(b.duplicateOf.amount), createdAt: b.duplicateOf.createdAt.toISOString() }
    : null,
  payments: b.payments.map((p) => ({
    ...p,
    amount: formatAmount(p.amount),
    splits: p.splits.map((s) => ({ category: s.category, amount: formatAmount(s.amount) })),
    createdAt: p.createdAt.toISOString(),
    sentAt: iso(p.sentAt),
    cancelledAt: iso(p.cancelledAt),
    answeredAt: iso(p.answeredAt),
  })),
});
const limitsView = (l: BillLimits) => ({ perPayment: f(l.perPayment), daily: f(l.daily), monthly: f(l.monthly) });
const vendorView = (v: BillVendor) => ({ name: v.name, cap: formatAmount(v.cap), createdAt: v.createdAt.toISOString() });
const settingsView = (s: BillSettings) => ({ ...s, vendors: s.vendors.map(vendorView), limits: limitsView(s.limits) });

/** At most 1 MiB once decoded: base64 of 1 MiB is 1398104 characters. */
const fileBase64 = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_BILL_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

/**
 * J-bank-20: a business pays its suppliers' bills (BK-bill-01 to BK-bill-03). Every door is the signed-in member's; what
 * each may do is their permissions on that business, checked by the service. A bill payment is one partner instruction,
 * sent once; a split is our record beside it; the ledger posts nothing.
 */
export function createBusinessBillsRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  const bills = bank.businessBills;
  const accountInput = z.object({ accountId: z.string().guid() }).strict();
  const billInput = z.object({ billId: z.string().guid() }).strict();
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessBillSchema))
      .query(({ ctx, input }) => guard(async () => (await bills.bills(input.accountId, ctx.principal.userId)).map(billView))),
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(billInput)
      .output(businessBillSchema)
      .query(({ ctx, input }) => guard(async () => billView(await bills.bill(input.billId, ctx.principal.userId)))),
    settings: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessBillSettingsSchema)
      .query(({ ctx, input }) => guard(async () => settingsView(await bills.settings(input.accountId, ctx.principal.userId)))),

    upload: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            billId: z.string().guid(),
            fileName: z.string().min(1).max(128),
            contentType: z.string().min(1).max(128),
            contentBase64: fileBase64,
          })
          .strict(),
      )
      .output(businessBillSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const file = Buffer.from(input.contentBase64, 'base64');
          if (file.byteLength === 0 || file.byteLength > MAX_BILL_BYTES) {
            throw new BankError('A bill file is 1 byte to 1 MiB.', 'bank.bill_file_invalid');
          }
          return billView(
            await bills.upload({
              accountId: input.accountId,
              billId: input.billId,
              userId: ctx.principal.userId,
              fileName: input.fileName,
              contentType: input.contentType,
              file,
            }),
          );
        }),
      ),
    review: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            billId: z.string().guid(),
            vendor: z.string().max(128).nullable(),
            reference: z.string().max(64).nullable(),
            amount: amountString.nullable(),
            dueDate: day.nullable(),
          })
          .strict(),
      )
      .output(businessBillSchema)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          billView(
            await bills.review({
              ...input,
              amount: input.amount === null ? null : parseAmount(input.amount),
              userId: ctx.principal.userId,
            }),
          ),
        ),
      ),
    clearDuplicate: scopedProcedure('bank:write', { module: 'bank' })
      .input(billInput)
      .output(businessBillSchema)
      .mutation(({ ctx, input }) => guard(async () => billView(await bills.clearDuplicate({ ...input, userId: ctx.principal.userId })))),
    setVendor: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), name: z.string().min(1).max(128), cap: amountString }).strict())
      .output(businessBillVendorSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => vendorView(await bills.setVendor({ ...input, cap: parseAmount(input.cap), userId: ctx.principal.userId }))),
      ),
    setLimits: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            perPayment: amountString.nullable(),
            daily: amountString.nullable(),
            monthly: amountString.nullable(),
          })
          .strict(),
      )
      .output(businessBillLimitsSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const p = (v: string | null) => (v === null ? null : parseAmount(v));
          return limitsView(
            await bills.setLimits({
              accountId: input.accountId,
              userId: ctx.principal.userId,
              limits: { perPayment: p(input.perPayment), daily: p(input.daily), monthly: p(input.monthly) },
            }),
          );
        }),
      ),
    submit: scopedProcedure('bank:write', { module: 'bank' })
      .input(billInput)
      .output(businessBillSchema)
      .mutation(({ ctx, input }) => guard(async () => billView(await bills.submit({ ...input, userId: ctx.principal.userId })))),
    approve: scopedProcedure('bank:write', { module: 'bank' })
      .input(billInput)
      .output(businessBillSchema)
      .mutation(({ ctx, input }) => guard(async () => billView(await bills.approve({ ...input, userId: ctx.principal.userId })))),
    /** Pays an approved bill now, or schedules it: one partner instruction under its own key, sent once. */
    pay: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            billId: z.string().guid(),
            paymentId: z.string().guid(),
            scheduledFor: day.nullable(),
            splits: z.array(z.object({ category: z.string().min(1).max(64), amount: amountString }).strict()).max(MAX_SPLIT_LINES),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(businessBillSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const { stepUpApprovalId, ...rest } = input;
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              billPayBinding({
                actor: ctx.principal.userId,
                billId: rest.billId,
                paymentId: rest.paymentId,
                scheduledFor: rest.scheduledFor,
              }),
              stepUpApprovalId,
            );
          }
          return billView(
            await bills.pay({
              ...rest,
              splits: rest.splits.map((s) => ({ category: s.category, amount: parseAmount(s.amount) })),
              userId: ctx.principal.userId,
            }),
          );
        }),
      ),
    /** A payment whose partner answer was not definite, sent again under the same key: made at most once. */
    resend: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(businessBillSchema)
      .mutation(({ ctx, input }) => guard(async () => billView(await bills.resend({ ...input, userId: ctx.principal.userId })))),
    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(businessBillSchema)
      .mutation(({ ctx, input }) => guard(async () => billView(await bills.cancel({ ...input, userId: ctx.principal.userId })))),
  });
}
