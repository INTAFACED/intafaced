import { z } from 'zod';
import {
  router,
  scopedProcedure,
  BUSINESS_PAYMENT_TYPES,
  BUSINESS_TEAM_PERMISSIONS,
  BUSINESS_TEAM_ROLES,
  businessTeamAdvisorSchema,
  businessTeamDepartmentSchema,
  businessTeamInviteMadeSchema,
  businessTeamInviteSchema,
  businessTeamJoinedSchema,
  businessTeamMemberSchema,
  businessTeamOverviewSchema,
  businessTeamPaymentSchema,
  businessTeamRoleSchema,
  businessTeamRuleSchema,
  businessTeamSpendSchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { TeamAdvisor, TeamInvite, TeamPayment, TeamRole, TeamRule, TeamSpend } from '../business/business-team.js';
import { approveBinding } from '../step-up/money-out-fields.js';
import { amountString, stepUpApprovalField } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

const accountInput = z.object({ accountId: z.string().guid() }).strict();

const roleView = (r: TeamRole) => ({ ...r, createdAt: r.createdAt.toISOString() });
const advisorView = (a: TeamAdvisor) => ({ ...a, createdAt: a.createdAt.toISOString() });
const inviteView = (i: TeamInvite) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() });
const ruleView = (r: TeamRule) => ({ ...r, overAmount: formatAmount(r.overAmount), createdAt: r.createdAt.toISOString() });
const paymentView = (p: TeamPayment) => ({
  ...p,
  amount: formatAmount(p.amount),
  rule: p.rule ? ruleView(p.rule) : null,
  approvals: p.approvals.map((a) => ({ ...a, approvedAt: a.approvedAt.toISOString() })),
  createdAt: p.createdAt.toISOString(),
  sentAt: p.sentAt ? p.sentAt.toISOString() : null,
});
const spendView = (s: TeamSpend) => ({
  ...s,
  members: s.members.map((m) => ({ ...m, partnerTotal: formatAmount(m.partnerTotal), recordTotal: formatAmount(m.recordTotal) })),
  departments: s.departments.map((d) => ({
    ...d,
    budget: d.budget === null ? null : formatAmount(d.budget),
    spent: formatAmount(d.spent),
  })),
});

/**
 * J-bank-19: a business bank team and its approval rules (BK-biz-01 to BK-biz-04). Every door is the signed-in member's;
 * what each may do is the member's permissions on that business, checked by the service. A payment is one partner
 * instruction, sent once after its rule's distinct approvals; the ledger posts nothing.
 */
export function createBusinessTeamRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  const team = bank.businessTeam;
  return router({
    overview: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessTeamOverviewSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          const o = await team.overview(input.accountId, ctx.principal.userId);
          return {
            ...o,
            partner: o.partner
              ? {
                  label: o.partner.label,
                  amount: o.partner.amount === null ? null : formatAmount(o.partner.amount),
                  asOf: o.partner.asOf ? o.partner.asOf.toISOString() : null,
                }
              : null,
          };
        }),
      ),
    members: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamMemberSchema))
      .query(({ ctx, input }) => guard(() => team.members(input.accountId, ctx.principal.userId))),
    roles: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamRoleSchema))
      .query(({ ctx, input }) => guard(async () => (await team.roles(input.accountId, ctx.principal.userId)).map(roleView))),
    advisors: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamAdvisorSchema))
      .query(({ ctx, input }) => guard(async () => (await team.advisors(input.accountId, ctx.principal.userId)).map(advisorView))),
    invites: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamInviteSchema))
      .query(({ ctx, input }) => guard(async () => (await team.invites(input.accountId, ctx.principal.userId)).map(inviteView))),
    rules: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamRuleSchema))
      .query(({ ctx, input }) => guard(async () => (await team.rules(input.accountId, ctx.principal.userId)).map(ruleView))),
    payments: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(z.array(businessTeamPaymentSchema))
      .query(({ ctx, input }) => guard(async () => (await team.payments(input.accountId, ctx.principal.userId)).map(paymentView))),
    payment: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(businessTeamPaymentSchema)
      .query(({ ctx, input }) => guard(async () => paymentView(await team.payment(input.paymentId, ctx.principal.userId)))),
    spend: scopedProcedure('bank:read', { module: 'bank' })
      .input(accountInput)
      .output(businessTeamSpendSchema)
      .query(({ ctx, input }) => guard(async () => spendView(await team.spend(input.accountId, ctx.principal.userId)))),

    createRole: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            roleId: z.string().guid(),
            name: z.string().min(1).max(64),
            permissions: z.array(z.enum(BUSINESS_TEAM_PERMISSIONS)).min(1).max(BUSINESS_TEAM_PERMISSIONS.length),
          })
          .strict(),
      )
      .output(businessTeamRoleSchema)
      .mutation(({ ctx, input }) => guard(async () => roleView(await team.createRole({ ...input, actorUserId: ctx.principal.userId })))),
    assignRole: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), userId: z.string().min(1).max(128), roleId: z.string().guid().nullable() }).strict())
      .output(businessTeamMemberSchema)
      .mutation(({ ctx, input }) => guard(() => team.assignRole({ ...input, actorUserId: ctx.principal.userId }))),
    addAdvisor: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), handle: z.string().min(1).max(64) }).strict())
      .output(businessTeamAdvisorSchema)
      .mutation(({ ctx, input }) => guard(async () => advisorView(await team.addAdvisor({ ...input, actorUserId: ctx.principal.userId })))),
    approveAdvisor: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), userId: z.string().min(1).max(128) }).strict())
      .output(businessTeamAdvisorSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => advisorView(await team.approveAdvisor({ ...input, actorUserId: ctx.principal.userId }))),
      ),
    invite: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            inviteId: z.string().guid(),
            email: z.string().max(320).nullable(),
            role: z.enum(BUSINESS_TEAM_ROLES).nullable(),
            roleId: z.string().guid().nullable(),
          })
          .strict(),
      )
      .output(businessTeamInviteMadeSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const made = await team.invite({ ...input, actorUserId: ctx.principal.userId });
          return { invite: inviteView(made.invite), token: made.token };
        }),
      ),
    resendInvite: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), inviteId: z.string().guid(), newInviteId: z.string().guid() }).strict())
      .output(businessTeamInviteMadeSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const made = await team.resendInvite({ ...input, actorUserId: ctx.principal.userId });
          return { invite: inviteView(made.invite), token: made.token };
        }),
      ),
    revokeInvite: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().guid(), inviteId: z.string().guid() }).strict())
      .output(businessTeamInviteSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => inviteView(await team.revokeInvite({ ...input, actorUserId: ctx.principal.userId }))),
      ),
    acceptInvite: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ token: z.string().min(1).max(128) }).strict())
      .output(businessTeamJoinedSchema)
      .mutation(({ ctx, input }) => guard(() => team.acceptInvite({ token: input.token, userId: ctx.principal.userId }))),
    addRule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            ruleId: z.string().guid(),
            overAmount: amountString,
            payee: z.string().max(128).nullable(),
            paymentType: z.enum(BUSINESS_PAYMENT_TYPES).nullable(),
            approvals: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .output(businessTeamRuleSchema)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          ruleView(await team.addRule({ ...input, overAmount: parseAmount(input.overAmount), actorUserId: ctx.principal.userId })),
        ),
      ),
    propose: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            paymentId: z.string().guid(),
            payee: z.string().min(1).max(128),
            paymentType: z.enum(BUSINESS_PAYMENT_TYPES),
            amount: amountString,
          })
          .strict(),
      )
      .output(businessTeamPaymentSchema)
      .mutation(({ ctx, input }) =>
        guard(async () =>
          paymentView(await team.propose({ ...input, amount: parseAmount(input.amount), makerUserId: ctx.principal.userId })),
        ),
      ),
    /** One approval. The one that completes the rule's count sends the partner instruction, once. */
    approve: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict())
      .output(businessTeamPaymentSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              approveBinding({ actor: ctx.principal.userId, approvalId: input.paymentId }),
              input.stepUpApprovalId,
            );
          }
          return paymentView(await team.approve({ paymentId: input.paymentId, approverUserId: ctx.principal.userId }));
        }),
      ),
    reject: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(businessTeamPaymentSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => paymentView(await team.reject({ paymentId: input.paymentId, userId: ctx.principal.userId }))),
      ),
    /** A payment whose partner answer was not definite, sent again under the same key: made at most once. */
    resend: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ paymentId: z.string().guid() }).strict())
      .output(businessTeamPaymentSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => paymentView(await team.resend({ paymentId: input.paymentId, userId: ctx.principal.userId }))),
      ),
    addDepartment: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            accountId: z.string().guid(),
            departmentId: z.string().guid(),
            name: z.string().min(1).max(64),
            budget: amountString.nullable(),
          })
          .strict(),
      )
      .output(businessTeamDepartmentSchema)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const d = await team.addDepartment({
            ...input,
            budget: input.budget === null ? null : parseAmount(input.budget),
            actorUserId: ctx.principal.userId,
          });
          return { ...d, budget: d.budget === null ? null : formatAmount(d.budget) };
        }),
      ),
    setDepartment: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({ accountId: z.string().guid(), userId: z.string().min(1).max(128), departmentId: z.string().guid().nullable() }).strict(),
      )
      .output(businessTeamMemberSchema)
      .mutation(({ ctx, input }) => guard(() => team.setDepartment({ ...input, actorUserId: ctx.principal.userId }))),
  });
}
