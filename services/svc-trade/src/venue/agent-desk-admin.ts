import { router, TRPCError } from '@intafaced/contracts/trpc';
import { AgentAccountError } from './agent-account.js';
import type { AgentDesk, AgentDeskConnections } from './agent-desk.js';
import { answerKeys } from '../answer-keys.js';
import {
  deskConnectionsAnswer,
  deskAuditAnswer,
  deskConnectionAnswer,
  deskQuarantineAnswer,
} from '@intafaced/contracts/trade-call-schemas';
import {
  TRADE_ADMIN_AGENT_DESK_CONNECTIONS,
  TRADE_ADMIN_AGENT_DESK_AUDIT,
  TRADE_ADMIN_AGENT_DESK_CONNECTION,
  TRADE_ADMIN_AGENT_DESK_QUARANTINE,
} from '@intafaced/contracts/trade-admin-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { tradeRefusal } from '../record-refusal.js';

const TRPC_CODE: Record<number, TRPCError['code']> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT' };

/** A desk refusal keeps its typed code in the message's last bracket, where the console reads it. */
function fail(error: unknown): never {
  if (error instanceof AgentAccountError) {
    throw new TRPCError({ code: TRPC_CODE[error.status] ?? 'BAD_REQUEST', message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

answerKeys<AgentDeskConnections>()(deskConnectionsAnswer);

answerKeys<Awaited<ReturnType<AgentDesk['audit']>>>()(deskAuditAnswer);

answerKeys<Awaited<ReturnType<AgentDesk['connection']>>>()(deskConnectionAnswer);

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
      connections: mountRecord(TRADE_ADMIN_AGENT_DESK_CONNECTIONS, () => ready().connections().catch(fail), tradeRefusal),
      audit: mountRecord(TRADE_ADMIN_AGENT_DESK_AUDIT, () => ready().audit().catch(fail), tradeRefusal),
      connection: mountRecord(TRADE_ADMIN_AGENT_DESK_CONNECTION, ({ input }) => ready().connection(input.keyId).catch(fail), tradeRefusal),
      quarantine: mountRecord(
        TRADE_ADMIN_AGENT_DESK_QUARANTINE,
        ({ ctx, input }) => ready().quarantine(ctx.principal, input).catch(fail),
        tradeRefusal,
      ),
    }),
  });
}
