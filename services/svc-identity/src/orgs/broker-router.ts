/** `broker.*` (RC-identity-09): client links, commission schedules, allocation records and client evidence. identity:write / read. */
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { BrokerError, type BrokerClientService } from './broker-clients.js';
import { DmaHierarchyRefuseError } from './dma-hierarchy.js';
import { OrgError } from './org-service.js';

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof BrokerError) {
    const code =
      err.code === 'identity.broker_admin_required' || err.code === 'identity.broker_client_self'
        ? 'FORBIDDEN'
        : err.code === 'identity.broker_client_not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.broker_client_revoked' || err.code === 'identity.broker_client_not_active'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  if (err instanceof DmaHierarchyRefuseError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof OrgError) {
    // Not a member of the organisation, or no such organisation: hidden either way.
    const code = err.code === 'org.membership_denied' || err.code === 'org.not_found' ? 'NOT_FOUND' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
  }
  throw err;
}

const statusSchema = z.enum(['invited', 'active', 'revoked']);
const scheduleRow = z.object({ product: z.string().max(256), rate: z.string().max(64) }).strict();
const link = z.object({ orgId: z.string().uuid(), clientUserId: z.string().uuid() }).strict();

export function createBrokerRouter(service: BrokerClientService) {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      toTrpc(err);
    }
  };
  return router({
    broker: router({
      client: router({
        invite: scopedProcedure('identity:write')
          .input(link.extend({ clientTag: z.string().max(256) }).strict())
          .output(z.object({ status: statusSchema, changed: z.boolean() }))
          .mutation(({ ctx, input }) => run(() => service.invite({ actorId: ctx.principal.userId, ...input }))),
        accept: scopedProcedure('identity:write')
          .input(z.object({ orgId: z.string().uuid() }).strict())
          .output(z.object({ status: z.literal('active'), changed: z.boolean() }))
          .mutation(({ ctx, input }) => run(() => service.accept({ clientUserId: ctx.principal.userId, orgId: input.orgId }))),
        revoke: scopedProcedure('identity:write')
          .input(link)
          .output(z.object({ status: z.literal('revoked'), changed: z.boolean() }))
          .mutation(({ ctx, input }) => run(() => service.revoke({ actorId: ctx.principal.userId, ...input }))),
      }),
      schedule: router({
        publish: scopedProcedure('identity:write')
          .input(z.object({ orgId: z.string().uuid(), rows: z.array(scheduleRow).max(200) }).strict())
          .output(z.object({ version: z.number().int() }))
          .mutation(({ ctx, input }) => run(() => service.publishSchedule({ actorId: ctx.principal.userId, ...input }))),
      }),
      allocate: scopedProcedure('identity:write')
        .input(link.extend({ instruction: z.record(z.unknown()) }).strict())
        .output(z.object({ allocationId: z.string().uuid(), instructionHash: z.string(), changed: z.boolean() }))
        .mutation(({ ctx, input }) => run(() => service.allocate({ actorId: ctx.principal.userId, ...input }))),
      evidence: router({
        mine: scopedProcedure('identity:read')
          .input(z.object({ orgId: z.string().uuid() }).strict())
          .output(
            z.object({
              orgId: z.string().uuid(),
              clientTag: z.string(),
              status: statusSchema,
              schedule: z.object({ version: z.number().int(), rows: z.array(scheduleRow), publishedAt: z.string() }).nullable(),
              allocations: z.array(
                z.object({
                  id: z.string().uuid(),
                  instructionHash: z.string(),
                  instruction: z.record(z.unknown()),
                  allocatedAt: z.string(),
                }),
              ),
              history: z.array(z.object({ event: z.enum(['invited', 'accepted', 'revoked']), at: z.string() })),
            }),
          )
          .query(({ ctx, input }) => run(() => service.evidenceMine({ clientUserId: ctx.principal.userId, orgId: input.orgId }))),
      }),
    }),
  });
}
