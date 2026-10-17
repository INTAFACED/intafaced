import { z } from 'zod';
import { memberRoleSchema } from '../schemas';

// mirrors feat/pay-portal-be-profile-analytics:packages/contracts/src/merchant-portal.ts; import from @intafaced/contracts after merge
//
// Parsed tolerantly: unknown keys are ignored, and a capability key that is missing reads as false. The service
// is the authority; this only decides what to show and what to disable.
export const membershipSchema = z.object({
  merchantId: z.string(),
  role: memberRoleSchema,
  status: z.enum(['pending', 'active', 'suspended', 'closed']),
  kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  verified: z.boolean(),
  identityChangePending: z.boolean().optional(),
  /** False for an API key or a session without MFA. */
  sessionInteractive: z.boolean(),
  mode: z.enum(['gateway', 'psp', 'payfac']),
  displayName: z.string().nullable(),
  legalName: z.string().nullable(),
  capabilities: z.record(z.string(), z.boolean()),
  pricingVisibility: z.enum(['full', 'fee_only']),
});
export type Membership = z.infer<typeof membershipSchema>;
/** Owner first, as the service orders them. Empty means the person has no business here. */
export const myAccessSchema = z.object({ memberships: z.array(membershipSchema) });
export type MyAccess = z.infer<typeof myAccessSchema>;
