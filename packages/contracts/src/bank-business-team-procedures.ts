import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
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
} from './bank-business-team.js';
import { accountInput, amountString, stepUpApprovalField } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessTeam.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_BUSINESS_TEAM_OVERVIEW = defineProcedure({
  ...base,
  name: 'bank.businessTeam.overview',
  kind: 'query',
  path: 'businessTeam.overview',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessTeamOverviewSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_MEMBERS = defineProcedure({
  ...base,
  name: 'bank.businessTeam.members',
  kind: 'query',
  path: 'businessTeam.members',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamMemberSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ROLES = defineProcedure({
  ...base,
  name: 'bank.businessTeam.roles',
  kind: 'query',
  path: 'businessTeam.roles',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamRoleSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ADVISORS = defineProcedure({
  ...base,
  name: 'bank.businessTeam.advisors',
  kind: 'query',
  path: 'businessTeam.advisors',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamAdvisorSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_INVITES = defineProcedure({
  ...base,
  name: 'bank.businessTeam.invites',
  kind: 'query',
  path: 'businessTeam.invites',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamInviteSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_RULES = defineProcedure({
  ...base,
  name: 'bank.businessTeam.rules',
  kind: 'query',
  path: 'businessTeam.rules',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamRuleSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_PAYMENTS = defineProcedure({
  ...base,
  name: 'bank.businessTeam.payments',
  kind: 'query',
  path: 'businessTeam.payments',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessTeamPaymentSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_SPEND = defineProcedure({
  ...base,
  name: 'bank.businessTeam.spend',
  kind: 'query',
  path: 'businessTeam.spend',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessTeamSpendSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_PAYMENT = defineProcedure({
  ...base,
  name: 'bank.businessTeam.payment',
  kind: 'query',
  path: 'businessTeam.payment',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: businessTeamPaymentSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_CREATE_ROLE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.createRole',
  kind: 'mutation',
  path: 'businessTeam.createRole',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      roleId: z.string().guid(),
      name: z.string().min(1).max(64),
      permissions: z.array(z.enum(BUSINESS_TEAM_PERMISSIONS)).min(1).max(BUSINESS_TEAM_PERMISSIONS.length),
    })
    .strict(),
  output: businessTeamRoleSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        roleId: '22222222-2222-4222-8222-222222222222',
        name: 'placeholder',
        permissions: ['view'],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ASSIGN_ROLE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.assignRole',
  kind: 'mutation',
  path: 'businessTeam.assignRole',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      userId: z.string().min(1).max(128),
      roleId: z.string().guid().nullable(),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessTeamMemberSchema,
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '22222222-2222-4222-8222-222222222222', userId: 'placeholder', roleId: '22222222-2222-4222-8222-222222222222' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_APPROVE_ADVISOR = defineProcedure({
  ...base,
  name: 'bank.businessTeam.approveAdvisor',
  kind: 'mutation',
  path: 'businessTeam.approveAdvisor',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), userId: z.string().min(1).max(128) }).strict(),
  output: businessTeamAdvisorSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', userId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ADD_ADVISOR = defineProcedure({
  ...base,
  name: 'bank.businessTeam.addAdvisor',
  kind: 'mutation',
  path: 'businessTeam.addAdvisor',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), handle: z.string().min(1).max(64) }).strict(),
  output: businessTeamAdvisorSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', handle: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_INVITE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.invite',
  kind: 'mutation',
  path: 'businessTeam.invite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      inviteId: z.string().guid(),
      email: z.string().max(320).nullable(),
      role: z.enum(BUSINESS_TEAM_ROLES).nullable(),
      roleId: z.string().guid().nullable(),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessTeamInviteMadeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        inviteId: '22222222-2222-4222-8222-222222222222',
        email: 'placeholder',
        role: 'admin',
        roleId: '22222222-2222-4222-8222-222222222222',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_RESEND_INVITE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.resendInvite',
  kind: 'mutation',
  path: 'businessTeam.resendInvite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), inviteId: z.string().guid(), newInviteId: z.string().guid() }).strict(),
  output: businessTeamInviteMadeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        inviteId: '22222222-2222-4222-8222-222222222222',
        newInviteId: '22222222-2222-4222-8222-222222222222',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_REVOKE_INVITE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.revokeInvite',
  kind: 'mutation',
  path: 'businessTeam.revokeInvite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), inviteId: z.string().guid() }).strict(),
  output: businessTeamInviteSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', inviteId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ADD_RULE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.addRule',
  kind: 'mutation',
  path: 'businessTeam.addRule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      ruleId: z.string().guid(),
      overAmount: amountString,
      payee: z.string().max(128).nullable(),
      paymentType: z.enum(BUSINESS_PAYMENT_TYPES).nullable(),
      approvals: z.number().int().min(1).max(5),
    })
    .strict(),
  output: businessTeamRuleSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        ruleId: '22222222-2222-4222-8222-222222222222',
        overAmount: '1.50',
        payee: 'placeholder',
        paymentType: 'domestic',
        approvals: 1,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_PROPOSE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.propose',
  kind: 'mutation',
  path: 'businessTeam.propose',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      paymentId: z.string().guid(),
      payee: z.string().min(1).max(128),
      paymentType: z.enum(BUSINESS_PAYMENT_TYPES),
      amount: amountString,
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessTeamPaymentSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        paymentId: '22222222-2222-4222-8222-222222222222',
        payee: 'placeholder',
        paymentType: 'domestic',
        amount: '1.50',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ADD_DEPARTMENT = defineProcedure({
  ...base,
  name: 'bank.businessTeam.addDepartment',
  kind: 'mutation',
  path: 'businessTeam.addDepartment',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      departmentId: z.string().guid(),
      name: z.string().min(1).max(64),
      budget: amountString.nullable(),
    })
    .strict(),
  output: businessTeamDepartmentSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        departmentId: '22222222-2222-4222-8222-222222222222',
        name: 'placeholder',
        budget: '1.50',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_SET_DEPARTMENT = defineProcedure({
  ...base,
  name: 'bank.businessTeam.setDepartment',
  kind: 'mutation',
  path: 'businessTeam.setDepartment',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({ accountId: z.string().guid(), userId: z.string().min(1).max(128), departmentId: z.string().guid().nullable() })
    .strict(),
  output: businessTeamMemberSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        userId: 'placeholder',
        departmentId: '22222222-2222-4222-8222-222222222222',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One approval. The one that completes the rule's count sends the partner instruction, once. */
export const BANK_BUSINESS_TEAM_APPROVE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.approve',
  kind: 'mutation',
  path: 'businessTeam.approve',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict(),
  output: businessTeamPaymentSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_REJECT = defineProcedure({
  ...base,
  name: 'bank.businessTeam.reject',
  kind: 'mutation',
  path: 'businessTeam.reject',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: businessTeamPaymentSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A payment whose partner answer was not definite, sent again under the same key: made at most once. */
export const BANK_BUSINESS_TEAM_RESEND = defineProcedure({
  ...base,
  name: 'bank.businessTeam.resend',
  kind: 'mutation',
  path: 'businessTeam.resend',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: businessTeamPaymentSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_TEAM_ACCEPT_INVITE = defineProcedure({
  ...base,
  name: 'bank.businessTeam.acceptInvite',
  kind: 'mutation',
  path: 'businessTeam.acceptInvite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ token: z.string().min(1).max(128), stepUpApprovalId: stepUpApprovalField }).strict(),
  output: businessTeamJoinedSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
