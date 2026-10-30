import { z } from 'zod';
import { AGENTS_TEAM_BUSINESS_ROLES } from './agents-team-membership.js';

/**
 * AGENTS TEAM: a business team's agent roles, pool and project limits, as svc-agents answers them on `team.*`
 * (AG-governance-01, AG-usage-03). The team is svc-bank's business members (see `agents-team-membership.ts`), read
 * per call for the business the person names; these are the roles and limits svc-agents keeps per member. Amounts are
 * decimal strings in the agents fee asset. A pool is a limit, never a balance: each run is charged to the member's own
 * account, per usage window, on that window's own key.
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
      businessRole: z.enum(AGENTS_TEAM_BUSINESS_ROLES),
      grants: z.array(agentsTeamGrantSchema),
      /** Roles allowed and not denied. */
      effective: z.array(z.enum(AGENTS_TEAM_ROLES)),
      allocation: z.string().nullable(),
      /** What this member's team runs hold or were charged so far, the sum their next run is checked against. */
      used: z.string(),
    }),
  ),
  pool: agentsTeamPoolSchema.nullable(),
  projects: z.array(agentsTeamProjectSchema),
  /** The number the next new project takes in its business key. */
  nextProjectSeq: z.number().int().positive(),
  /** What every team run on the business holds or was charged so far, removed members' included: the pool's own sum. */
  used: z.string(),
});
export type AgentsTeamView = z.infer<typeof agentsTeamViewSchema>;

export const agentsTeamGrantResultSchema = z.object({ grant: agentsTeamGrantSchema, replayed: z.boolean() });

/** A blank allocation is refused naming each member left blank; nothing is saved. */
export const agentsTeamPoolResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pool: agentsTeamPoolSchema, replayed: z.boolean() }),
  z.object({ ok: z.literal(false), code: z.literal('agents.pool_allocation_unset'), memberUserIds: z.array(z.string()) }),
]);

export const agentsTeamProjectResultSchema = z.object({ project: agentsTeamProjectSchema, replayed: z.boolean() });

/** A run session a member opened on the business's pool, with one of their own agents. */
export const agentsTeamRunSessionSchema = z.object({ sessionId: z.string(), agentId: z.string(), businessId: z.string() });

/** One run: what the engine answered and what it cost, charged to the member's own account at the window's seal. */
export const agentsTeamRunResultSchema = z.object({
  text: z.string(),
  cost: z.string(),
  assetId: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const agentsTeamRunClosedSchema = z.object({ sessionId: z.string(), status: z.literal('closed'), closedAt: z.string() });

/** An action a team agent proposed that waits for an approver who is not the agent's creator (four eyes). */
export const agentsTeamHeldActionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  creatorUserId: z.string(),
  tool: z.string(),
  /** The guardrail's refusal that held it. */
  heldBy: z.literal('agents.approval_required'),
  status: z.enum(['held', 'approved']),
  approvedBy: z.string().nullable(),
});
export type AgentsTeamHeldAction = z.infer<typeof agentsTeamHeldActionSchema>;

export const agentsTeamHeldActionResultSchema = z.object({ action: agentsTeamHeldActionSchema, replayed: z.boolean() });

/**
 * Usage by member and task, from sealed usage windows of the business's team sessions only, for current members only.
 * `sealedTotal` is the sum of what those windows charged; a task's `cost` is its tokens priced per window.
 */
export const agentsTeamUsageSchema = z.object({
  businessId: z.string(),
  assetId: z.string(),
  members: z.array(
    z.object({
      userId: z.string(),
      windows: z.number().int().nonnegative(),
      sealedTotal: z.string(),
      tasks: z.array(
        z.object({
          task: z.string(),
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          cost: z.string(),
        }),
      ),
    }),
  ),
  sealedTotal: z.string(),
});
export type AgentsTeamUsage = z.infer<typeof agentsTeamUsageSchema>;
