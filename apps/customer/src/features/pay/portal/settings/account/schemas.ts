import { z } from 'zod';

// Everything here is parsed tolerantly: unknown keys are ignored, so a newer service never breaks a page.
// mirrors feat/pay-portal-be-profile-analytics:packages/contracts/src/merchant-portal.ts (business profile, onboarding progress)
// and feat/pay-portal-be-profile-analytics:services/svc-pay/src/submerchant-router.ts (summary); import from
// @intafaced/contracts after merge.
// mirrors origin/main:services/svc-pay/src/merchant-ops/{activity,router}.ts (activity feed, team filters).

const timestamp = z.string().datetime({ offset: true });
const status = z.enum(['pending', 'active', 'suspended', 'closed']);
const kyb = z.enum(['none', 'pending', 'approved', 'rejected']);

// ---- business profile ----------------------------------------------------------------------------------
export const addressSchema = z.object({
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postalCode: z.string(),
  country: z.string(),
});
export type Address = z.infer<typeof addressSchema>;

const profileFields = {
  displayName: z.string().nullable(),
  legalName: z.string().nullable(),
  address: addressSchema.nullable(),
  website: z.string().nullable(),
  supportEmail: z.string().nullable(),
  supportPhone: z.string().nullable(),
  statementDescriptor: z.string().nullable(),
  industry: z.string().nullable(),
};
export const profileSchema = z.object({
  merchantId: z.string(),
  version: z.string(),
  ...profileFields,
  /** Whether a legal-detail change also needs a second teammate. Optional so an older service still parses. */
  secondApprovalEnabled: z.boolean().optional(),
});
export type BusinessProfile = z.infer<typeof profileSchema>;
export type ProfileFields = Omit<BusinessProfile, 'merchantId' | 'version' | 'secondApprovalEnabled'>;

export const SENSITIVE_KEYS = ['legalName', 'address', 'statementDescriptor', 'industry'] as const;
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];

export const profileChangeStatuses = ['applied', 'applied_pre_kyb', 'pending', 'pending_review', 'rejected', 'conflict'] as const;
export const profileChangeSchema = z.object({
  requestId: z.string(),
  seq: z.string(),
  status: z.string(),
  before: z.object(profileFields).partial(),
  after: z.object(profileFields).partial(),
  sensitiveKeys: z.array(z.string()),
  changeHash: z.string(),
  makerId: z.string(),
  checkerId: z.string().nullable(),
  secondApproverId: z.string().nullable(),
  reason: z.string(),
  checkerReason: z.string().nullable(),
  createdAt: timestamp,
  decidedAt: timestamp.nullable(),
});
export type ProfileChange = z.infer<typeof profileChangeSchema>;

export const profileSubmitResultSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(['applied', 'pending_review', 'pending_second_approval']),
  version: z.string(),
  changeHash: z.string().nullable(),
  profile: profileSchema,
});
export const profileDecideResultSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(['applied', 'rejected', 'pending_review']),
  version: z.string(),
  profile: profileSchema,
});
export const secondApprovalResultSchema = z.object({ merchantId: z.string(), enabled: z.boolean() });

// ---- onboarding progress ---------------------------------------------------------------------------------
export const progressSchema = z.object({
  merchantId: z.string(),
  business: z.object({ done: z.boolean(), missing: z.array(z.string()) }),
  documents: z.object({ state: z.string() }),
  /** `merchant.terms.accept` takes the version shown here. Nothing to accept while the owner has published none. */
  terms: z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_configured') }),
    z.object({ state: z.literal('not_accepted'), version: z.string(), url: z.string().url() }),
    z.object({ state: z.literal('accepted'), version: z.string(), url: z.string().url(), acceptedAt: z.string() }),
  ]),
  destination: z.object({
    present: z.boolean(),
    destinations: z.array(z.object({ railId: z.string(), kind: z.string(), destinationMasked: z.string() })),
  }),
  kybStatus: kyb,
  merchantStatus: status,
  blocking: z.array(z.string()),
});
export type Progress = z.infer<typeof progressSchema>;
export type TermsState = Progress['terms'];
export const termsAcceptedSchema = z.object({ merchantId: z.string(), version: z.string(), acceptedAt: z.string() });

// ---- activity ----------------------------------------------------------------------------------------------
export const ACTIVITY_TYPES = ['payment', 'team', 'kyb', 'dispute', 'export', 'approval', 'webhook'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const activityItemSchema = z.object({
  id: z.string(),
  occurredAt: timestamp,
  actorId: z.string(),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  detail: z.record(z.string(), z.string()).default({}),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

// ---- network (sub-merchants) -------------------------------------------------------------------------------
export const subMerchantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  parentMerchantId: z.string().nullable(),
  mode: z.enum(['gateway', 'psp', 'payfac']),
  status,
  kybStatus: kyb,
  settlingParty: z.string(),
  feeBps: z.number().nullable(),
  depth: z.number(),
  createdAt: timestamp,
});
export type SubMerchant = z.infer<typeof subMerchantSchema>;

export const subSummarySchema = subMerchantSchema.extend({
  displayName: z.string().nullable(),
  legalName: z.string().nullable(),
  volume: z
    .object({
      window: z.object({ preset: z.string() }).partial(),
      items: z.array(z.object({ assetCode: z.string(), volume: z.string(), count: z.number() })),
    })
    .nullable(),
  recentPayments: z
    .object({
      items: z.array(z.object({ id: z.string(), status: z.string(), amount: z.string(), assetId: z.string(), createdAt: timestamp })),
      nextCursor: z.string().nullable(),
    })
    .nullable(),
  grants: z.object({ items: z.array(z.object({ area: z.string(), granteeMerchantId: z.string() })) }).nullable(),
});
export type SubSummary = z.infer<typeof subSummarySchema>;

export const grantSchema = z.object({
  granteeMerchantId: z.string(),
  subjectMerchantId: z.string(),
  area: z.string(),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string(),
  grantedAt: timestamp,
});
export type Grant = z.infer<typeof grantSchema>;
export const permissionEventSchema = z.object({
  id: z.string(),
  seq: z.string(),
  granteeMerchantId: z.string(),
  subjectMerchantId: z.string(),
  area: z.string(),
  action: z.enum(['grant', 'revoke']),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string(),
  createdAt: timestamp,
});
export type PermissionEvent = z.infer<typeof permissionEventSchema>;
