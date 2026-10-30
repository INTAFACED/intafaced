import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import {
  agentsTeamGrantResultSchema,
  agentsTeamHeldActionResultSchema,
  agentsTeamHeldActionSchema,
  agentsTeamPoolResultSchema,
  agentsTeamProjectResultSchema,
  agentsTeamRunClosedSchema,
  agentsTeamRunResultSchema,
  agentsTeamRunSessionSchema,
  agentsTeamUsageSchema,
  agentsTeamViewSchema,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { AgentError } from '../errors.js';
import { OwnAgentRefusal } from '../own/catalog.js';
import { executeProcedure } from '../procedures.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { TeamError, type TeamErrorCode } from './errors.js';
import type { TeamMembershipPort } from './membership.js';
import { TeamRuns } from './runs.js';
import { TeamStore } from './store.js';

const STATUS: Partial<Record<TeamErrorCode, TRPCError['code']>> = {
  'agents.role_admin_only': 'FORBIDDEN',
  'agents.role_not_member': 'FORBIDDEN',
  'agents.team_not_member': 'FORBIDDEN',
  'agents.business_closed': 'FORBIDDEN',
  'agents.team_role_required': 'FORBIDDEN',
  'agents.team_four_eyes': 'FORBIDDEN',
  'agents.team_change_stale': 'CONFLICT',
  'agents.team_action_closed': 'CONFLICT',
  'agents.team_agent_not_found': 'NOT_FOUND',
  'agents.team_action_not_found': 'NOT_FOUND',
  'agents.team_session_not_found': 'NOT_FOUND',
  'agents.membership_unavailable': 'SERVICE_UNAVAILABLE',
  'agents.capability_unavailable': 'SERVICE_UNAVAILABLE',
  'agents.fee_asset_unset': 'SERVICE_UNAVAILABLE',
};

/**
 * A refusal reaches the client as its code (`message`, and `data.cause.code` for a TeamError); anything else is the
 * router's own failure. A run's guardrail or hold refusal is FORBIDDEN with its code, as on the own-agent routes.
 */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TeamError) throw new TRPCError({ code: STATUS[err.code] ?? 'BAD_REQUEST', message: err.code, cause: err });
    if (err instanceof OwnAgentRefusal) throw new TRPCError({ code: 'BAD_REQUEST', message: err.code, cause: err });
    if (err instanceof RefusedError) throw new TRPCError({ code: 'FORBIDDEN', message: err.refusal.code, cause: err });
    if (err instanceof AgentError) {
      const code =
        err.code === 'agents.session_not_found'
          ? 'NOT_FOUND'
          : err.code === 'agents.provider_unavailable'
            ? 'SERVICE_UNAVAILABLE'
            : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.code, cause: err });
    }
    throw err;
  }
}

/** A team change is the person's own: a delegated token (`kid` or `sub_account`) never changes a business's roles. */
function assertPerson(principal: Principal): void {
  if (principal.kid || principal.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A signed-in user session is required' });
  }
}

const businessId = z.string().uuid();
const memberId = z.string().trim().min(1).max(128);
const amount = z.string().max(64).nullable().optional();
const revision = z.number().int().positive().max(1_000_000);

export interface TeamRouterDeps {
  readonly sql: Sql | undefined;
  /** svc-bank's team read. Absent (BANK_URL unset) → every team call refuses `agents.membership_unavailable`. */
  readonly membership: TeamMembershipPort | undefined;
  readonly feeAssetId: string | undefined;
  /** The runtime team runs go through. Absent → runs refuse `agents.capability_unavailable`. */
  readonly runtime?: AgentRuntime;
}

function storeOf(deps: TeamRouterDeps): TeamStore {
  if (!deps.sql) throw new TeamError('Agents database is unset', 'agents.capability_unavailable');
  if (!deps.membership) throw new TeamError('svc-bank team read is unset', 'agents.membership_unavailable');
  return new TeamStore(deps.sql, deps.membership, deps.feeAssetId);
}

function runsOf(deps: TeamRouterDeps): TeamRuns {
  if (!deps.sql || !deps.runtime) throw new TeamError('Agents runtime is unset', 'agents.capability_unavailable');
  if (!deps.membership) throw new TeamError('svc-bank team read is unset', 'agents.membership_unavailable');
  if (!deps.feeAssetId?.trim()) throw new TeamError('Agents fee asset is unset', 'agents.fee_asset_unset');
  return new TeamRuns(deps.sql, deps.membership, deps.runtime, deps.feeAssetId.trim());
}

/**
 * A business's team: agent roles per member, the business pool, project limits, runs on the pool, held actions and
 * usage (AG-governance-01, AG-usage-03). The caller is the principal; the business is the one they name, and every
 * call reads from svc-bank that they are on it.
 */
export function teamRouter(deps: TeamRouterDeps) {
  const person = scopedProcedure('agents:read', { module: 'agents', person: true });
  return router({
    view: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ businessId }).strict())
      .output(agentsTeamViewSchema)
      .query(({ ctx, input }) => guard(() => storeOf(deps).view(ctx.principal.userId, input.businessId))),

    grants: router({
      set: person
        .input(
          z
            .object({ businessId, memberUserId: memberId, role: z.string().max(32), allow: z.boolean(), deny: z.boolean(), revision })
            .strict(),
        )
        .output(agentsTeamGrantResultSchema)
        .mutation(({ ctx, input }) => {
          assertPerson(ctx.principal);
          return guard(() => storeOf(deps).setGrant({ actorUserId: ctx.principal.userId, ...input }));
        }),
    }),

    pool: router({
      set: person
        .input(
          z
            .object({
              businessId,
              limit: amount,
              allocations: z.array(z.object({ memberUserId: memberId, amount }).strict()).max(200),
              revision,
            })
            .strict(),
        )
        .output(agentsTeamPoolResultSchema)
        .mutation(({ ctx, input }) => {
          assertPerson(ctx.principal);
          return guard(() => storeOf(deps).setPool({ actorUserId: ctx.principal.userId, ...input }));
        }),
    }),

    projects: router({
      create: person
        .input(
          z
            .object({
              businessId,
              name: z.string().max(80).nullable().optional(),
              limit: amount,
              memberUserIds: z.array(memberId).max(200),
              seq: revision,
            })
            .strict(),
        )
        .output(agentsTeamProjectResultSchema)
        .mutation(({ ctx, input }) => {
          assertPerson(ctx.principal);
          return guard(() => storeOf(deps).createProject({ actorUserId: ctx.principal.userId, ...input }));
        }),
    }),

    /** Runs of a member's own agent on the business pool: `agents:execute`, on the person's own session only. */
    runs: router({
      open: executeProcedure()
        .input(z.object({ businessId, agentId: z.string().min(1).max(64) }).strict())
        .output(agentsTeamRunSessionSchema)
        .mutation(({ ctx, input }) => guard(() => runsOf(deps).open({ userId: ctx.principal.userId, ...input }))),

      run: executeProcedure()
        .input(
          z
            .object({
              businessId,
              sessionId: z.string().uuid(),
              requestId: z.string().min(8).max(190),
              ask: z.string().min(1).max(4000),
            })
            .strict(),
        )
        .output(agentsTeamRunResultSchema)
        .mutation(({ ctx, input }) => guard(() => runsOf(deps).run({ userId: ctx.principal.userId, ...input }))),

      close: executeProcedure()
        .input(z.object({ businessId, sessionId: z.string().uuid() }).strict())
        .output(agentsTeamRunClosedSchema)
        .mutation(({ ctx, input }) => guard(() => runsOf(deps).close({ userId: ctx.principal.userId, sessionId: input.sessionId }))),
    }),

    /** Actions a team agent's guardrail held for approval, and their approval by someone other than the creator. */
    actions: router({
      list: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ businessId, limit: z.number().int().min(1).max(200) }).strict())
        .output(z.array(agentsTeamHeldActionSchema))
        .query(({ ctx, input }) => guard(() => runsOf(deps).actions({ userId: ctx.principal.userId, ...input }))),

      hold: person
        .input(z.object({ businessId, agentId: z.string().min(1).max(64), tool: z.string().min(1).max(120), seq: revision }).strict())
        .output(agentsTeamHeldActionResultSchema)
        .mutation(({ ctx, input }) => {
          assertPerson(ctx.principal);
          return guard(() => runsOf(deps).hold({ userId: ctx.principal.userId, ...input }));
        }),

      approve: person
        .input(z.object({ businessId, actionId: z.string().uuid() }).strict())
        .output(agentsTeamHeldActionResultSchema)
        .mutation(({ ctx, input }) => {
          assertPerson(ctx.principal);
          return guard(() => runsOf(deps).approve({ userId: ctx.principal.userId, ...input }));
        }),
    }),

    usage: scopedProcedure('agents:read', { module: 'agents' })
      .input(z.object({ businessId }).strict())
      .output(agentsTeamUsageSchema)
      .query(({ ctx, input }) => guard(() => runsOf(deps).usage({ userId: ctx.principal.userId, businessId: input.businessId }))),
  });
}
