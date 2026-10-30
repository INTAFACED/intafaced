import { z } from 'zod';

/**
 * AGENTS TEAM MEMBERSHIP: the S2S read svc-agents uses to learn a business's team (J-agents-11).
 *
 * The team is svc-bank's business account members. svc-agents never reads svc-bank's tables; it asks this route,
 * signed as `svc-agents`, and refuses closed when the read fails. The asking person names the business; the answer
 * is that business's team only when the person is a member of it. A closed business answers `business_closed`,
 * never its team.
 */

export const AGENTS_TEAM_MEMBERSHIP_PATH = '/internal/agents/team-membership' as const;

/** The roles a business member holds in svc-bank (`business-policy.ts`, `BUSINESS_ROLES`). */
export const AGENTS_TEAM_BUSINESS_ROLES = [
  'admin',
  'maker',
  'checker',
  'signer',
  'editor',
  'viewer',
  'security_auditor',
  'non_signing_admin',
] as const;
export type AgentsTeamBusinessRole = (typeof AGENTS_TEAM_BUSINESS_ROLES)[number];

export const agentsTeamMembershipRequestSchema = z.object({ userId: z.string().uuid(), businessId: z.string().uuid() }).strict();
export type AgentsTeamMembershipRequest = z.infer<typeof agentsTeamMembershipRequestSchema>;

export const agentsTeamMemberSchema = z
  .object({ userId: z.string().trim().min(1).max(128), role: z.enum(AGENTS_TEAM_BUSINESS_ROLES) })
  .strict();
export type AgentsTeamMember = z.infer<typeof agentsTeamMemberSchema>;

export const agentsTeamMembershipResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      businessId: z.string().uuid(),
      /** The asking person's own role on the business. */
      role: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
      /** Every member, by when they joined (then by account id). svc-bank refuses a team over 200, never cuts it. */
      members: z.array(agentsTeamMemberSchema).min(1).max(200),
    })
    .strict(),
  /** `not_member`: no such business, or the person is not on it (one answer, so membership of others never leaks). */
  z.object({ ok: z.literal(false), reason: z.enum(['not_member', 'business_closed']) }).strict(),
]);
export type AgentsTeamMembershipResponse = z.infer<typeof agentsTeamMembershipResponseSchema>;
