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
 *   POST /api/v1/venue/agent-accounts/:id/limits            { maxOrderNotional?, maxLeverage?, maxDailyLoss? } (#16)
 *   POST /api/v1/venue/agent-accounts/:id/close
 *   GET  /api/v1/venue/agent-accounts/connections           the person's agent keys and the agent account each trades
 *   POST /api/v1/venue/agent-accounts/:id/connections       { keyId, stepUpApprovalId }: bind an own agent key (#6)
 *
 * And the assistant's own route, called with the connected agent API key (agent-orders.ts, #7 #8 #10):
 *
 *   POST /api/v1/venue/agent/orders                         { clientOrderId, symbol, side, type, amount, price, timeInForce,
 *                                                             leverage?, reduceOnly? }   a perp opens isolated at `leverage`
 *
 * A connected agent key calls that route and no other venue route: every other one refuses it `auth.scope_denied` (#9).
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
import { AgentVenueRefusal, type AgentOrders } from './agent-orders.js';
import { UserVenueDoorError } from './user-venue-door.js';
import { refusedAgentKey, venueRefusalReply, type UserVenueRestDeps } from './user-venue-rest.js';

export const AGENT_ACCOUNTS_PATH = '/api/v1/venue/agent-accounts';
export const AGENT_ORDERS_PATH = '/api/v1/venue/agent/orders';

export function agentAccountReply(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentAccountError) {
    return reply.code(err.status).send({
      code: err.status === 404 ? 'NotFound' : err.status === 400 ? 'BadRequest' : 'InvalidOrder',
      message: err.message,
      intafacedCode: err.code,
      ...err.detail,
    });
  }
  if (err instanceof AgentVenueRefusal) {
    // The venue's own refusal of the assistant's order, in its words, with the venue named; nothing is open.
    return reply.code(422).send({
      code: 'InvalidOrder',
      message: err.message,
      intafacedCode: `trade.venue.${err.refusal.code}`,
      refusal: err.refusal,
      venue: { id: err.refusal.venueId, displayName: err.venueName },
      actionKey: err.actionKey,
    });
  }
  return venueRefusalReply(reply, err);
}

export function attachAgentAccountRoutes(
  app: FastifyInstance,
  accounts: AgentAccounts | null,
  deps: UserVenueRestDeps,
  orders: AgentOrders | null = null,
): void {
  /** `assistant`: the assistant's own order route, the one route a connected agent key may call (#9). */
  async function admit(req: FastifyRequest, reply: FastifyReply, scope: Scope, assistant = false): Promise<Principal | null> {
    const principal = deps.requirePrincipal(req, reply);
    if (!principal) return null;
    if (!assistant && (await refusedAgentKey(reply, principal, deps))) return null;
    try {
      requireScope(principal, scope);
    } catch (error) {
      void venueRefusalReply(reply, error);
      return null;
    }
    return deps.requireTradeJurisdiction(req, reply, principal) ? principal : null;
  }

  function off(): never {
    throw new UserVenueDoorError('the user-venue door is off on this deployment (TRADE_USER_VENUE_URL unset)', 'trade.user_venue_off', 404);
  }

  async function answerOrders(reply: FastifyReply, run: (o: AgentOrders) => Promise<unknown>) {
    try {
      return reply.code(200).send(encodeVenueWire(await run(orders ?? off())));
    } catch (error) {
      return agentAccountReply(reply, error);
    }
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
    if (!(await admit(req, reply, 'trade:read'))) return;
    return answer(reply, async (a) => a.terms());
  });

  app.get(AGENT_ACCOUNTS_PATH, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => ({ accounts: await a.list(principal) }));
  });

  app.post(AGENT_ACCOUNTS_PATH, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.create(principal, body(req)));
  });

  app.get(`${AGENT_ACCOUNTS_PATH}/connections`, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answerOrders(reply, async (o) => ({ connections: await o.connections(principal) }));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/connections`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answerOrders(reply, async (o) => o.connect(principal, req.params.id, body(req)));
  });

  // The assistant's order: an agent API key connected to an agent account (agent-orders.ts). An answer that is not
  // definite is 202: retry the same clientOrderId, which reads the venue's record first and never signs again.
  app.post(AGENT_ORDERS_PATH, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write', true);
    if (!principal) return;
    try {
      const view = await (orders ?? off()).place(principal, body(req));
      return reply.code(view.state === 'accepted' ? 200 : 202).send(encodeVenueWire(view));
    } catch (error) {
      return agentAccountReply(reply, error);
    }
  });

  app.get<Id>(`${AGENT_ACCOUNTS_PATH}/:id`, privateRead, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:read');
    if (!principal) return;
    return answer(reply, async (a) => a.advance(principal, req.params.id));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/submit`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => {
      const b = body<{ actionKey?: string; signature?: VenueSignature }>(req);
      return a.submit(principal, req.params.id, b.actionKey, b.signature as VenueSignature);
    });
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/abandon`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.abandon(principal, req.params.id));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/fund`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.fund(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/withdraw`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.withdraw(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/cap`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.setCap(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/limits`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.setLimits(principal, req.params.id, body(req)));
  });

  app.post<Id>(`${AGENT_ACCOUNTS_PATH}/:id/close`, privateWrite, async (req, reply) => {
    const principal = await admit(req, reply, 'trade:write');
    if (!principal) return;
    return answer(reply, async (a) => a.close(principal, req.params.id));
  });
}
