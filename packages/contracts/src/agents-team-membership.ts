import { z } from 'zod';

/**
 * AGENTS TEAM MEMBERSHIP: the S2S read svc-agents uses to learn who is on a business's team (AG-governance-01).
 *
 * The team lives in svc-pay (the merchant's owner plus its accepted team members). svc-agents never reads svc-pay's
 * tables; it asks this route, signed as `svc-agents`, and refuses closed when the read fails. Only active members
 * count: an invitation is not membership, and a removed member is gone at the next read. A suspended or closed
 * business answers `business_shut`, never its team.
 */

export const AGENTS_TEAM_MEMBERSHIP_PATH = '/internal/agents/team-membership' as const;

/** An account id as svc-pay stores it on a team row. */
const userIdSchema = z.string().trim().min(1).max(128);

/** The person whose business is asked for. The answer is that person's business, never one named by the caller. */
export const agentsTeamMembershipRequestSchema = z.object({ userId: z.string().uuid() }).strict();
export type AgentsTeamMembershipRequest = z.infer<typeof agentsTeamMembershipRequestSchema>;

/** The business roles svc-pay holds. `owner` is the merchant's owner, never a stored team row. */
export const AGENTS_TEAM_BUSINESS_ROLES = ['owner', 'admin', 'finance', 'developer', 'viewer'] as const;
export type AgentsTeamBusinessRole = (typeof AGENTS_TEAM_BUSINESS_ROLES)[number];

export const agentsTeamMemberSchema = z
  .object({
    userId: userIdSchema,
    role: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
    /** The name the team gave the member, or null. Never an email address. */
    label: z.string().nullable(),
  })
  .strict();
export type AgentsTeamMember = z.infer<typeof agentsTeamMemberSchema>;

export const agentsTeamMembershipResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      businessId: z.string().uuid(),
      /** The asking person's own role on the business. */
      role: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
      /** The owner first, then active members by when they joined. */
      members: z.array(agentsTeamMemberSchema).min(1),
    })
    .strict(),
  /** `no_business`: the person owns none and is an active member of none. `business_shut`: theirs is suspended or closed. */
  z.object({ ok: z.literal(false), reason: z.enum(['no_business', 'business_shut']) }).strict(),
]);
export type AgentsTeamMembershipResponse = z.infer<typeof agentsTeamMembershipResponseSchema>;
