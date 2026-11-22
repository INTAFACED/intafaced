import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts/trpc';
import { AgentAccountError } from './agent-account.js';
import type { AgentDesk, AgentDeskConnections } from './agent-desk.js';
import { answerKeys } from '../answer-keys.js';

const TRPC_CODE: Record<number, TRPCError['code']> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' };

/** A desk refusal keeps its typed code in the message's last bracket, where the console reads it. */
function fail(error: unknown): never {
  if (error instanceof AgentAccountError) {
    throw new TRPCError({ code: TRPC_CODE[error.status] ?? 'BAD_REQUEST', message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

/** The desk's answer schemas: each names every key its handler answers with (`answerKeys`), and checks no more. */
const deskQuarantine = z.object({ operatorId: z.string(), reason: z.string(), at: z.string(), requestId: z.string() });
/** An audit row, keys in the order the desk writes them: its own fields, then the quarantine's. */
const deskAuditRow = z.object({
  id: z.string(),
  action: z.literal('quarantine'),
  keyId: z.string(),
  userId: z.string(),
  accountId: z.string(),
  ...deskQuarantine.shape,
});

/** A value the desk could not read reads `known: false`; the two branches differ on the literal, so either order is safe. */
const deskConnectionsAnswer = z.object({
  rows: z
    .array(
      z.object({
        keyId: z.string(),
        userId: z.string(),
        accountId: z.string(),
        connectedAt: z.string(),
        endedAt: z.string().nullable(),
        asset: z.string().nullable(),
        cap: z.string().nullable(),
        accountStatus: z.string().nullable(),
        balance: z.union([z.object({ known: z.literal(true), value: z.string() }), z.object({ known: z.literal(false) })]),
        keyState: z.enum(['live', 'revoked', 'missing', 'unknown']),
        lastAction: z.union([
          z.object({
            known: z.literal(true),
            value: z.object({ at: z.string(), method: z.string(), path: z.string(), status: z.number() }).nullable(),
          }),
          z.object({ known: z.literal(false) }),
        ]),
        quarantine: deskQuarantine.nullable(),
      }),
    )
    .readonly(),
  limit: z.number(),
  more: z.boolean(),
  test: z.boolean().nullable(),
});
answerKeys<AgentDeskConnections>()(deskConnectionsAnswer);

const deskAuditAnswer = z.object({ rows: z.array(deskAuditRow).readonly(), limit: z.number() });
answerKeys<Awaited<ReturnType<AgentDesk['audit']>>>()(deskAuditAnswer);

const deskConnectionAnswer = z.object({ keyId: z.string(), userId: z.string(), accountId: z.string() });
answerKeys<Awaited<ReturnType<AgentDesk['connection']>>>()(deskConnectionAnswer);

const deskQuarantineAnswer = z.object({ quarantine: deskAuditRow, endedAt: z.string(), replayed: z.boolean() });
answerKeys<Awaited<ReturnType<AgentDesk['quarantine']>>>()(deskQuarantineAnswer);

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
      connections: scopedProcedure('admin:read')
        .output(deskConnectionsAnswer)
        .query(() => ready().connections().catch(fail)),
      audit: scopedProcedure('admin:read')
        .output(deskAuditAnswer)
        .query(() => ready().audit().catch(fail)),
      connection: scopedProcedure('admin:read')
        .input(z.object({ keyId: z.string().max(64) }).strict())
        .output(deskConnectionAnswer)
        .query(({ input }) => ready().connection(input.keyId).catch(fail)),
      quarantine: scopedProcedure('admin:write')
        .input(z.object({ keyId: z.string().max(64), reason: z.string().max(600), requestId: z.string().max(256) }).strict())
        .output(deskQuarantineAnswer)
        .mutation(({ ctx, input }) => ready().quarantine(ctx.principal, input).catch(fail)),
    }),
  });
}
