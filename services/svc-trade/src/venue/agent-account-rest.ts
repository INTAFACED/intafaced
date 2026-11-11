/**
 * The agent account's REST routes (J-agents-21; src/venue/agent-account.ts), for the signed-in person:
 *
 *   GET  /api/v1/venue/agent-accounts/terms                 the owner's ceiling, funding asset and drain bounds (null = blank)
 *   GET  /api/v1/venue/agent-accounts                       the person's agent accounts, each with the venue's balances
 *   POST /api/v1/venue/agent-accounts                       { accountId, owner, asset, cap, fund, stepUpApprovalId }
 *   GET  /api/v1/venue/agent-accounts/:id                   the account, read back from the venue, and what is next to sign
 *   POST /api/v1/venue/agent-accounts/:id/submit            { actionKey, signature }
 *   POST /api/v1/venue/agent-accounts/:id/abandon           the person rejected a signature while it was opening
 *   POST /api/v1/venue/agent-accounts/:id/fund              { moveId, amount }
 *   POST /api/v1/venue/agent-accounts/:id/withdraw          { moveId, amount }
 *   POST /api/v1/venue/agent-accounts/:id/cap               { cap }
 *   POST /api/v1/venue/agent-accounts/:id/close
 *
 * Reads need trade:read, writes trade:write, every route the trade jurisdiction, and every route the person's own
 * session (never an API key: the assistant's key can't make, fund or close the account it trades). Amounts travel as
 * decimal strings. A refusal answers with `intafacedCode` (`agents.*`, or the door's `trade.venue.*`) and what it names.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { VenueWireError, decodeVenueWire, encodeVenueWire, type VenueSignature } from '@intafaced/venue-contracts';
import { privateRead, privateWrite } from '../route-inventory.js';
import { AgentAccountError, type AgentAccounts } from './agent-account.js';
import { UserVenueDoorError } from './user-venue-door.js';
import { venueRefusalReply, type UserVenueRestDeps } from './user-venue-rest.js';

export const AGENT_ACCOUNTS_PATH = '/api/v1/venue/agent-accounts';

export function agentAccountReply(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentAccountError) {
    return reply.code(err.status).send({
      code: err.status === 404 ? 'NotFound' : err.status === 400 ? 'BadRequest' : 'InvalidOrder',
      message: err.message,
      intafacedCode: err.code,
      ...err.detail,
    });
  }
  return venueRefusalReply(reply, err);
}

export function attachAgentAccountRoutes(app: FastifyInstance, accounts: AgentAccounts | null, deps: UserVenueRestDeps): void {
  function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  async function answer(reply: FastifyReply, run: (a: AgentAccounts) => Promise<unknown>) {
    try {
      if (!accounts)
        throw new UserVenueDoorError(
          'the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)',
          'trade.user_venue_off',
          404,
        );
      return reply.code(200).send(encodeVenueWire(await run(accounts)));
    } catch (error) {
      return agentAccountReply(reply, error);
    }
  }

  function body<T>(req: FastifyRequest): T {
    const raw = req.body ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new VenueWireError('the body must be a JSON object');
    return decodeVenueWire<T>(raw);
  }

  type Id = { Params: { id: string } };

  app.get(`${AGENT_ACCOUNTS_PATH}/terms`, privateRead, async (req, reply) => {
    if (!admit(req, reply, 'trade:read')) return;
    return answer(reply, async (a) => a.terms());
  });

  app.get(AGENT_ACCOUNTS_PATH, privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => ({ accounts: await a.list(principal) }));
  });

  app.post(AGENT_ACCOUNTS_PATH, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.create(principal, body(req)));
  });

  app.get<Id>(`${AGENT_ACCOUNTS_PATH}/:id`, privateRead, async (req, reply) => {
    const principal = admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => a.advance(principal, req.params.id));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/submit`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => {
      const b = body<{ actionKey?: string; signature?: VenueSignature }>(req);
      return a.submit(principal, req.params.id, b.actionKey, b.signature as VenueSignature);
    });
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/abandon`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.abandon(principal, req.params.id));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/fund`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.fund(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/withdraw`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.withdraw(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/cap`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.setCap(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/close`, privateWrite, async (req, reply) => {
    const principal = admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.close(principal, req.params.id));
  });
}
