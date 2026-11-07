import { TRPCError } from '@trpc/server';
import {
  INCIDENT_ALREADY_RESOLVED,
  INCIDENT_ASSIGNEE_NOT_PARTICIPANT,
  INCIDENT_NOT_FOUND,
  INCIDENT_REQUEST_KEY_REUSED,
  INCIDENT_SEVERITY_UNKNOWN,
  INCIDENT_SEVERITIES_UNSET,
  INCIDENT_STORAGE_UNCONFIGURED,
  declaredSeverity,
  incidentDeclareInputSchema,
  incidentDetailSchema,
  incidentGetInputSchema,
  incidentInviteInputSchema,
  incidentListInputSchema,
  incidentListOutputSchema,
  incidentMetricsSchema,
  incidentNoteInputSchema,
  incidentResolveInputSchema,
  incidentTaskInputSchema,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import { OpsError } from '../codes.js';
import type { IncidentChange, IncidentStore } from './store.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

export interface IncidentsDeps {
  readonly store: IncidentStore | undefined;
  /** The owner's severity list (`OPS_INCIDENT_SEVERITIES`), or null while it is blank. */
  readonly severities: readonly string[] | null;
  readonly now: () => string;
}

const TRPC_CODE: Readonly<Record<string, 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED'>> = {
  [INCIDENT_NOT_FOUND]: 'NOT_FOUND',
  [INCIDENT_SEVERITY_UNKNOWN]: 'BAD_REQUEST',
  [INCIDENT_SEVERITIES_UNSET]: 'PRECONDITION_FAILED',
  [INCIDENT_ASSIGNEE_NOT_PARTICIPANT]: 'PRECONDITION_FAILED',
  [INCIDENT_ALREADY_RESOLVED]: 'CONFLICT',
  [INCIDENT_REQUEST_KEY_REUSED]: 'CONFLICT',
  [INCIDENT_STORAGE_UNCONFIGURED]: 'PRECONDITION_FAILED',
};

const refusal = (err: OpsError) =>
  new TRPCError({ code: TRPC_CODE[err.code] ?? 'PRECONDITION_FAILED', message: `${err.code} — ${err.message}`, cause: err });

async function refused<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OpsError) throw refusal(err);
    throw err;
  }
}

function storeOf(deps: IncidentsDeps): IncidentStore {
  if (!deps.store)
    throw refusal(
      new OpsError(INCIDENT_STORAGE_UNCONFIGURED, 'no durable storage is configured for incidents, so none can be read or declared'),
    );
  return deps.store;
}

/**
 * Staff incidents (OPS-oncall-02, J-ops-console-19 #10). Reads need `admin:read`, changes `admin:write`; the actor and viewer
 * is the signed-in person in the token, never a field of the request. A private incident is only its participants': to anyone
 * else it is `ops.incident_not_found`. No money moves.
 */
export function createIncidentsRouter(deps: IncidentsDeps) {
  const change = (viewerId: string, incidentId: string, requestKey: string, what: IncidentChange) =>
    refused(() => storeOf(deps).change(viewerId, incidentId, requestKey, what, deps.now()));
  return router({
    list: scopedProcedure('admin:read', guards)
      .input(incidentListInputSchema)
      .output(incidentListOutputSchema)
      .query(async ({ ctx, input }) => ({
        incidents: await storeOf(deps).list(ctx.principal.userId, input),
        severities: deps.severities === null ? null : [...deps.severities],
        asOf: deps.now(),
      })),
    get: scopedProcedure('admin:read', guards)
      .input(incidentGetInputSchema)
      .output(incidentDetailSchema)
      .query(async ({ ctx, input }) => {
        const detail = await storeOf(deps).get(ctx.principal.userId, input.incidentId, deps.now());
        if (!detail) throw refusal(new OpsError(INCIDENT_NOT_FOUND, `no incident ${input.incidentId} that you can see`));
        return detail;
      }),
    metrics: scopedProcedure('admin:read', guards)
      .output(incidentMetricsSchema)
      .query(async ({ ctx }) => storeOf(deps).metrics(ctx.principal.userId, deps.now())),
    declare: scopedProcedure('admin:write', guards)
      .input(incidentDeclareInputSchema)
      .output(incidentDetailSchema)
      .mutation(async ({ ctx, input }) => {
        const checked = declaredSeverity(input.severity, deps.severities);
        if (!checked.ok)
          throw refusal(
            checked.code === INCIDENT_SEVERITIES_UNSET
              ? new OpsError(checked.code, 'no severities are set (OPS_INCIDENT_SEVERITIES is blank): declare it without one, as pending')
              : new OpsError(
                  checked.code,
                  `${input.severity} is not a severity; use one of ${deps.severities!.join(', ')}, or none for pending`,
                ),
          );
        const severity = checked.severity;
        const values = {
          requestKey: input.requestKey,
          title: input.title,
          module: input.module ?? null,
          severity,
          private: input.private === true,
        };
        return refused(() => storeOf(deps).declare(values, ctx.principal.userId, deps.now()));
      }),
    note: scopedProcedure('admin:write', guards)
      .input(incidentNoteInputSchema)
      .output(incidentDetailSchema)
      .mutation(({ ctx, input }) => change(ctx.principal.userId, input.incidentId, input.requestKey, { kind: 'note', body: input.body })),
    invite: scopedProcedure('admin:write', guards)
      .input(incidentInviteInputSchema)
      .output(incidentDetailSchema)
      .mutation(({ ctx, input }) =>
        change(ctx.principal.userId, input.incidentId, input.requestKey, { kind: 'participant', userId: input.userId }),
      ),
    task: scopedProcedure('admin:write', guards)
      .input(incidentTaskInputSchema)
      .output(incidentDetailSchema)
      .mutation(({ ctx, input }) =>
        change(ctx.principal.userId, input.incidentId, input.requestKey, {
          kind: 'task',
          title: input.title,
          assigneeId: input.assigneeId,
        }),
      ),
    resolve: scopedProcedure('admin:write', guards)
      .input(incidentResolveInputSchema)
      .output(incidentDetailSchema)
      .mutation(({ ctx, input }) => change(ctx.principal.userId, input.incidentId, input.requestKey, { kind: 'resolved' })),
  });
}
