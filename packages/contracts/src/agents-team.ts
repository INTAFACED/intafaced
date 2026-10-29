import { z } from 'zod';
import { AGENTS_TEAM_BUSINESS_ROLES } from './agents-team-membership.js';

/**
 * AGENTS TEAM: a business team's agent roles, pool and project limits, as svc-agents answers them on `team.*`
 * (AG-governance-01, AG-usage-03). Membership is svc-pay's (see `agents-team-membership.ts`); these are the roles and
 * limits svc-agents keeps per member. Amounts are decimal strings in the agents fee asset. A pool is a limit, never a
 * balance.
 */

export const AGENTS_TEAM_ROLES = ['creator', 'runner', 'approver', 'log_reader', 'spend_reader'] as const;
export type AgentsTeamRole = (typeof AGENTS_TEAM_ROLES)[number];

/** One member's allow and deny for one role; deny wins. `version` counts its changes, and the next change is `version + 1`. */
export const agentsTeamGrantSchema = z.object({
  role: z.enum(AGENTS_TEAM_ROLES),
  allow: z.boolean(),
  deny: z.boolean(),
  version: z.number().int().nonnegative(),
});

export const agentsTeamPoolSchema = z.object({
  assetId: z.string(),
  limit: z.string(),
  allocated: z.string(),
  version: z.number().int().positive(),
});

export const agentsTeamProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  assetId: z.string(),
  limit: z.string(),
  /** Current members the limit applies to; a person who left the business is not listed. */
  memberUserIds: z.array(z.string()),
});

export const agentsTeamViewSchema = z.object({
  businessId: z.string(),
  myRole: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
  canManage: z.boolean(),
  members: z.array(
    z.object({
      userId: z.string(),
      label: z.string().nullable(),
      businessRole: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
      grants: z.array(agentsTeamGrantSchema),
      /** Roles allowed and not denied. */
      effective: z.array(z.enum(AGENTS_TEAM_ROLES)),
      allocation: z.string().nullable(),
    }),
  ),
  pool: agentsTeamPoolSchema.nullable(),
  projects: z.array(agentsTeamProjectSchema),
  /** The number the next new project takes in its business key. */
  nextProjectSeq: z.number().int().positive(),
});
export type AgentsTeamView = z.infer<typeof agentsTeamViewSchema>;

export const agentsTeamGrantResultSchema = z.object({ grant: agentsTeamGrantSchema, replayed: z.boolean() });

/** A blank allocation is refused naming each member left blank; nothing is saved. */
export const agentsTeamPoolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pool: agentsTeamPoolSchema, replayed: z.boolean() }),
  z.object({ ok: z.literal(false), code: z.literal('agents.pool_allocation_unset'), memberUserIds: z.array(z.string()) }),
]);

export const agentsTeamProjectResultSchema = z.object({ project: agentsTeamProjectSchema, replayed: z.boolean() });
