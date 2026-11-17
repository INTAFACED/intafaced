import { z } from 'zod';
import {
  router,
  scopedProcedure,
  BUSINESS_BOOK_FORMATS,
  businessAccountingConnectionSchema,
  businessBookLineSchema,
  businessBookStatementSchema,
  businessBooksOverviewSchema,
  businessCodingRuleSchema,
} from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import type { AccountingConnection, BookLineView, CodingRule } from '../business/business-books.js';
import { createStepUpGate } from '../step-up/step-up-gate.js';
import { unwiredApprovalConsumer } from '../action-approval-consume.js';
import { bookStatementBinding } from '../step-up/money-out-fields.js';
import { stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

const lineView = (l: BookLineView) => ({ ...l, amount: formatAmount(l.amount), bookedAt: l.bookedAt.toISOString() });
const ruleView = (r: CodingRule) => ({ ...r, createdAt: r.createdAt.toISOString() });
const connectionView = (c: AccountingConnection) => ({ ...c, requestedAt: c.requestedAt.toISOString() });

const accountId = z.string().guid();
const period = { from: z.string().datetime(), to: z.string().datetime() };
const range = (i: { from: string; to: string }) => ({ from: new Date(i.from), to: new Date(i.to) });

/**
 * J-bank-23: a business keeps its books in order (BK-bexp-03, BK-bexp-04, BK-bexp-05). Every door is the signed-in
 * member's; what each may do is their permissions on that business, checked by the service. Nothing here moves money.
 */
export function createBusinessBooksRouter(c: BankRouterContext) {
  const { bank } = c;
  // Always required; a router built without one fails closed.
  const gate = c.options.statementStepUp ?? createStepUpGate({ mode: 'required', approvals: unwiredApprovalConsumer() });
  const books = () => bank.businessBooks;
  return router({
    overview: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId }).strict())
      .output(businessBooksOverviewSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          const o = await books().overview(input.accountId, ctx.principal.userId);
          return { ...o, connection: o.connection ? connectionView(o.connection) : null, rules: o.rules.map(ruleView) };
        }),
      ),
    /** Asks to connect accounting software: `vendor.accounting` is switched off, so the record is kept and nothing connects. */
    connectAccounting: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId }).strict())
      .output(businessAccountingConnectionSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => connectionView(await books().connectAccounting(input.accountId, ctx.principal.userId))),
      ),
    lines: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId, ...period }).strict())
      .output(z.object({ items: z.array(businessBookLineSchema) }))
      .query(({ ctx, input }) =>
        guard(async () => ({ items: (await books().lines(input.accountId, ctx.principal.userId, range(input))).map(lineView) })),
      ),
    /** The lines a rule would code, before it is saved. Changes nothing. */
    testRule: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId, ...period, payeeContains: z.string().min(1).max(80) }).strict())
      .output(z.object({ matches: z.array(businessBookLineSchema) }))
      .query(({ ctx, input }) =>
        guard(async () => ({
          matches: (
            await books().testRule(input.accountId, ctx.principal.userId, { ...range(input), payeeContains: input.payeeContains })
          ).map(lineView),
        })),
      ),
    saveRule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId,
            ruleId: z.string().guid(),
            payeeContains: z.string().min(1).max(80),
            category: z.string().min(1).max(60),
            glCode: z.string().max(32).nullable().optional(),
          })
          .strict(),
      )
      .output(businessCodingRuleSchema)
      .mutation(({ ctx, input }) => guard(async () => ruleView(await books().saveRule(input.accountId, ctx.principal.userId, input)))),
    /** One line or many at once: a category, a GL code or both. */
    codeLines: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId,
            ...period,
            lineIds: z.array(z.string().min(1).max(128)).min(1).max(200),
            category: z.string().max(60).nullable().optional(),
            glCode: z.string().max(32).nullable().optional(),
          })
          .strict(),
      )
      .output(z.object({ items: z.array(businessBookLineSchema) }))
      .mutation(({ ctx, input }) =>
        guard(async () => ({
          items: (
            await books().codeLines(input.accountId, ctx.principal.userId, {
              ...range(input),
              lineIds: input.lineIds,
              category: input.category ?? null,
              glCode: input.glCode ?? null,
            })
          ).map(lineView),
        })),
      ),
    /**
     * One period's statement in one format, checked against the partner's own. A period reaching back past the partner's
     * strong customer authentication age needs a fresh confirmation bound to `exportId` and the exact period.
     */
    exportStatement: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            accountId,
            ...period,
            format: z.enum(BUSINESS_BOOK_FORMATS),
            exportId: z.string().guid(),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(businessBookStatementSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const r = range(input);
          const file = await books().exportStatement(input.accountId, ctx.principal.userId, { ...r, format: input.format }, async () => {
            const binding = bookStatementBinding({
              actor: ctx.principal.userId,
              accountId: input.accountId,
              exportId: input.exportId,
              from: r.from.toISOString(),
              to: r.to.toISOString(),
            });
            await gate.require({
              userId: ctx.principal.userId,
              sessionId: ctx.principal.sid,
              actionType: binding.actionType,
              fields: binding.fields,
              operationKey: binding.operationKey,
              approvalId: input.stepUpApprovalId,
              replay: true,
            });
          });
          return { ...file, partner: { ...file.partner, asOf: file.partner.asOf.toISOString() } };
        }),
      ),
  });
}
