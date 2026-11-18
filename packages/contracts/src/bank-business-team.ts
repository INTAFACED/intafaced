import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';

/**
 * svc-bank `businessTeam.*` (J-bank-19; BK-biz-01 to BK-biz-04): a business bank team and its approval rules.
 *
 * The business's money is the partner bank's: a payment is one instruction to the partner under the business key
 * `bank.business.payment:<payment id>`, sent once after the approvals its rule asks for, and INTAFACED's ledger posts
 * nothing. Amounts are decimal strings; times are ISO strings. A figure the partner has not given is null ("not known").
 *
 * Refusals the app names: `bank.business_role_forbidden` (the caller's role lacks the permission),
 * `bank.business_role_grant_exceeds` (granting a permission the actor lacks), `bank.business_owner_only` (an advisor
 * waits for the owner), `bank.business_invite_expired`, `bank.business_invite_revoked`, `bank.business_invite_replaced`,
 * `bank.business_invite_lifetime_unset`, `bank.business_self_approve` (the maker never approves their own payment),
 * `bank.business_already_approved` (approvers are distinct), `bank.business_approvers_short`.
 */
export const BUSINESS_TEAM_PERMISSIONS = ['view', 'export', 'propose', 'approve', 'manage_team', 'team_spend'] as const;
export type BusinessTeamPermission = (typeof BUSINESS_TEAM_PERMISSIONS)[number];

export const BUSINESS_TEAM_ROLES = [
  'admin',
  'maker',
  'checker',
  'signer',
  'editor',
  'viewer',
  'security_auditor',
  'non_signing_admin',
] as const;

export const BUSINESS_PAYMENT_TYPES = ['domestic', 'international', 'payroll'] as const;
export type BusinessPaymentType = (typeof BUSINESS_PAYMENT_TYPES)[number];

const amount = z.string().regex(/^-?\d+(\.\d+)?$/);
const iso = z.string().datetime();

export const businessTeamMemberSchema = z
  .object({
    userId: z.string(),
    handle: z.string(),
    role: z.enum(BUSINESS_TEAM_ROLES),
    customRole: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    advisor: z.boolean(),
    departmentId: z.string().nullable(),
    permissions: z.array(z.enum(BUSINESS_TEAM_PERMISSIONS)),
  })
  .strict();

export const businessTeamOverviewSchema = z
  .object({
    account: z.object({ id: z.string(), name: z.string(), assetId: assetIdSchema, status: z.enum(['active', 'closed']) }).strict(),
    owner: z.boolean(),
    me: businessTeamMemberSchema,
    /** The owner-set invite lifetime; null while it is not set (every invite refuses). */
    inviteMinutes: z.number().int().nullable(),
    /** The business's account at the partner, as the partner reports it; null when it is not held at a partner. */
    partner: z.object({ label: z.string(), amount: amount.nullable(), asOf: iso.nullable() }).strict().nullable(),
  })
  .strict();

export const businessTeamRoleSchema = z
  .object({ id: z.string(), name: z.string(), permissions: z.array(z.enum(BUSINESS_TEAM_PERMISSIONS)), createdAt: iso })
  .strict();

export const businessTeamAdvisorSchema = z
  .object({ userId: z.string(), handle: z.string(), addedByHandle: z.string(), status: z.enum(['pending', 'approved']), createdAt: iso })
  .strict();

export const businessTeamInviteSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['email', 'link']),
    email: z.string().nullable(),
    role: z.enum(BUSINESS_TEAM_ROLES).nullable(),
    customRole: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    status: z.enum(['open', 'expired', 'accepted', 'revoked', 'replaced']),
    expiresAt: iso,
    createdAt: iso,
  })
  .strict();

/** An invite just made or sent again, with its link's secret once (null on a retry: it is not kept). */
export const businessTeamInviteMadeSchema = z.object({ invite: businessTeamInviteSchema, token: z.string().nullable() }).strict();

export const businessTeamRuleSchema = z
  .object({
    id: z.string(),
    overAmount: amount,
    payee: z.string().nullable(),
    paymentType: z.enum(BUSINESS_PAYMENT_TYPES).nullable(),
    approvals: z.number().int(),
    createdAt: iso,
  })
  .strict();

export const businessTeamPaymentSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    makerUserId: z.string(),
    makerHandle: z.string(),
    payee: z.string(),
    paymentType: z.enum(BUSINESS_PAYMENT_TYPES),
    assetId: assetIdSchema,
    amount,
    /** The rule that applied when it was proposed; null when none did and it was sent at once. */
    rule: businessTeamRuleSchema.nullable(),
    approvalsNeeded: z.number().int(),
    approvals: z.array(z.object({ userId: z.string(), handle: z.string(), approvedAt: iso }).strict()),
    status: z.enum(['pending', 'sending', 'sent', 'refused', 'rejected']),
    /** The business key of the one partner instruction. */
    partnerKey: z.string(),
    /** The partner's reference for the move, once it made it. */
    partnerMoveId: z.string().nullable(),
    refusalCode: z.string().nullable(),
    createdAt: iso,
    sentAt: iso.nullable(),
  })
  .strict();

export const businessTeamSpendSchema = z
  .object({
    scope: z.enum(['team', 'self']),
    assetId: assetIdSchema,
    partnerLabel: z.string(),
    members: z.array(
      z
        .object({
          userId: z.string(),
          handle: z.string(),
          departmentId: z.string().nullable(),
          partnerTotal: amount,
          partnerLines: z.number().int(),
          recordTotal: amount,
        })
        .strict(),
    ),
    departments: z.array(
      z.object({ id: z.string(), name: z.string(), budget: amount.nullable(), spent: amount, members: z.array(z.string()) }).strict(),
    ),
  })
  .strict();

export const businessTeamDepartmentSchema = z.object({ id: z.string(), name: z.string(), budget: amount.nullable() }).strict();

export const businessTeamJoinedSchema = z.object({ accountId: z.string(), name: z.string(), member: businessTeamMemberSchema }).strict();

export type BusinessTeamOverview = z.infer<typeof businessTeamOverviewSchema>;
export type BusinessTeamMember = z.infer<typeof businessTeamMemberSchema>;
export type BusinessTeamRole = z.infer<typeof businessTeamRoleSchema>;
export type BusinessTeamAdvisor = z.infer<typeof businessTeamAdvisorSchema>;
export type BusinessTeamInvite = z.infer<typeof businessTeamInviteSchema>;
export type BusinessTeamRule = z.infer<typeof businessTeamRuleSchema>;
export type BusinessTeamPayment = z.infer<typeof businessTeamPaymentSchema>;
export type BusinessTeamSpend = z.infer<typeof businessTeamSpendSchema>;
