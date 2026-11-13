import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AgentAccountError } from './agent-account.js';
import type { AgentDesk } from './agent-desk.js';

const TRPC_CODE: Record<number, TRPCError['code']> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' };

/** A desk refusal keeps its typed code in the message's last bracket, where the console reads it. */
function fail(error: unknown): never {
  if (error instanceof AgentAccountError) {
    throw new TRPCError({ code: TRPC_CODE[error.status] ?? 'BAD_REQUEST', message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

/**
 * `admin.agentDesk.*` (J-agents-21 #15; agent-desk.ts): the founder's desk over every person's outside assistant
 * connections. Reads are `admin:read`; the quarantine is `admin:write` and writes its own audit row naming the operator.
 * With the user-venue door off, every procedure refuses `agents.desk_unavailable`.
 */
export function agentDeskAdminRouter(desk?: AgentDesk | null) {
  const ready = (): AgentDesk => {
    if (!desk)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'the outside connections desk is off [agents.desk_unavailable]' });
    return desk;
  };
  return router({
    agentDesk: router({
      connections: scopedProcedure('admin:read').query(() => ready().connections().catch(fail)),
      audit: scopedProcedure('admin:read').query(() => ready().audit().catch(fail)),
      quarantine: scopedProcedure('admin:write')
        .input(z.object({ keyId: z.string().max(64), reason: z.string().max(600), requestId: z.string().max(256) }).strict())
        .mutation(({ ctx, input }) => ready().quarantine(ctx.principal, input).catch(fail)),
    }),
  });
}
