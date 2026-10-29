import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import {
  agentsTeamGrantResultSchema,
  agentsTeamPoolResultSchema,
  agentsTeamProjectResultSchema,
  agentsTeamViewSchema,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { TeamError, type TeamErrorCode } from './errors.js';
import type { TeamMembershipPort } from './membership.js';
import { TeamStore } from './store.js';

const STATUS: Partial<Record<TeamErrorCode, TRPCError['code']>> = {
  'agents.role_admin_only': 'FORBIDDEN',
  'agents.role_not_member': 'FORBIDDEN',
  'agents.business_shut': 'FORBIDDEN',
  'agents.team_change_stale': 'CONFLICT',
  'agents.membership_unavailable': 'SERVICE_UNAVAILABLE',
  'agents.capability_unavailable': 'SERVICE_UNAVAILABLE',
  'agents.fee_asset_unset': 'SERVICE_UNAVAILABLE',
};

/** A TeamError reaches the client as its code (`data.cause.code`); anything else is the router's own failure. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof TeamError)) throw err;
    throw new TRPCError({ code: STATUS[err.code] ?? 'BAD_REQUEST', message: err.code, cause: err });
  }
}

/** A team change is the person's own: a delegated token (`kid` or `sub_account`) never changes a business's roles. */
function assertPerson(principal: Principal): void {
  if (principal.kid || principal.sub_account) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A signed-in user session is required' });
  }
}

const memberId = z.string().trim().min(1).max(128);
const amount = z.string().max(64).nullable().optional();
const revision = z.number().int().positive().max(1_000_000);

export interface TeamRouterDeps {
  readonly sql: Sql | undefined;
  /** svc-pay's team read. Absent (PAY_URL unset) → every team call refuses `agents.membership_unavailable`. */
  readonly membership: TeamMembershipPort | undefined;
  readonly feeAssetId: string | undefined;
}

function storeOf(deps: TeamRouterDeps): TeamStore {
  if (!deps.sql) throw new TeamError('Agents database is unset', 'agents.capability_unavailable');
  if (!deps.membership) throw new TeamError('svc-pay team read is unset', 'agents.membership_unavailable');
  return new TeamStore(deps.sql, deps.membership, deps.feeAssetId);
}

/**
 * A business's team: agent roles per member, the business pool and project limits (AG-governance-01, AG-usage-03).
 * The caller is the principal; the business is the one svc-pay says the caller is on, never one named in the body.
 */
export function teamRouter(deps: TeamRouterDeps) {
  const person = scopedProcedure('agents:read', { module: 'agents', person: true });
  return router({
    view: scopedProcedure('agents:read', { module: 'agents' })
      .output(agentsTeamViewSchema)
      .query(({ ctx }) => guard(() => storeOf(deps).view(ctx.principal.userId))),

    grants: router({
      set: person
        .input(z.object({ memberUserId: memberId, role: z.string().max(32), allow: z.boolean(), deny: z.boolean(), revision }).strict())
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
  });
}
